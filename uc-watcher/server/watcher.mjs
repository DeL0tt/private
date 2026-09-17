#!/usr/bin/env node
// UnicaCity Unternehmen-Watcher – Server-Variante (API).
// Läuft ohne Browser auf einem Dauerläufer und fragt die offizielle API ab.
// Voraussetzung: Node.js >= 18. Keine externen Pakete.

import fs from 'node:fs';
import path from 'node:path';

/* ========================= KONFIGURATION ========================= */

const CFG = {
  API:        process.env.UC_API || 'https://api.unicacity.eu',
  DASHBOARD:  'https://unicacity.eu/dashboard/unternehmen',

  // Der Zugang läuft über ein Cookie von api.unicacity.eu. Damit holt sich der
  // Watcher bei /api/auth/refresh fortlaufend frische Token (die halten 2 Std.).
  COOKIE: process.env.UC_COOKIE || '',
  TOKEN:  process.env.UC_TOKEN  || '',   // optionaler Starttoken, sonst per refresh

  // So lange vor Ablauf wird vorsorglich erneuert
  TOKEN_PUFFER_MIN: +(process.env.UC_TOKEN_PUFFER_MIN || 5),

  USER_AGENT: process.env.UC_USER_AGENT ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',

  NTFY_TOPIC:  process.env.UC_NTFY_TOPIC || '',
  NTFY_SERVER: process.env.UC_NTFY_SERVER || 'https://ntfy.sh',

  LAGER_SCHWELLE: +(process.env.UC_LAGER_SCHWELLE || 500),
  // Plötzlicher Lagerverlust: ab wie viel Prozent des Bestands gilt ein
  // Rückgang als Vorfall, wenn er nicht durch den normalen Absatz erklärbar ist
  LAGER_EINBRUCH_PCT: +(process.env.UC_LAGER_EINBRUCH_PCT || 15),

  // Sprung der Einkaufspreise, ab dem ein Lieferengpass vermutet wird
  PREIS_SPRUNG_PCT: +(process.env.UC_PREIS_SPRUNG_PCT || 20),
  ERINNERUNG_MIN: +(process.env.UC_ERINNERUNG_MIN || 60),

  AUSSCHUETTUNG_STD:            +(process.env.UC_AUSSCHUETTUNG_STD || 12),
  AUSSCHUETTUNG_STUNDENMELDUNG: process.env.UC_AUSSCHUETTUNG_STUNDENMELDUNG !== '0',
  TAGESBERICHT:                  process.env.UC_TAGESBERICHT !== '0',

  LUECKE_MIN:       +(process.env.UC_LUECKE_MIN || 10),
  TAGESWECHSEL_STD: +(process.env.UC_TAGESWECHSEL_STD || 4),

  INTERVALL_MS: +(process.env.UC_INTERVALL_MS || 60_000),
  STATE_FILE:   process.env.UC_STATE_FILE || path.join(process.cwd(), 'uc-watcher-state.json'),
  DEBUG:        process.env.UC_DEBUG === '1',
};

// Kassenbuch-Kategorien, die einen Vorfall darstellen (Groß/Klein egal).
const VORFALL_KATEGORIEN = [
  'steuerprüfung', 'steuerpruefung', 'razzia', 'überfall', 'ueberfall',
  'einbruch', 'diebstahl', 'strafe', 'bußgeld', 'bussgeld', 'sabotage',
];

// Bekannte, harmlose Kategorien – alles andere wird als unbekannt gemeldet.
const NORMALE_KATEGORIEN = [
  'verkauf', 'einkauf', 'löhne', 'loehne', 'nebenkosten', 'talent',
  'ausschüttung', 'ausschuettung', 'einzahlung', 'auszahlung', 'quest', 'auftrag',
];

const MIN = 60_000;
const log  = (...a) => CFG.DEBUG && console.log(new Date().toISOString(), ...a);
const info = (...a) => console.log(new Date().toISOString(), ...a);

/* ========================= ZUSTAND ========================= */

const leer = () => ({
  token: null, tokenExp: 0, cookie: null,   // Zugang, überlebt Neustarts
  lager: null, personal: null, kasse: null, gewinn: null,
  spieler: {},            // name -> { online, seit, sitzungMs, gesamtMs, zuletzt, tag }
  tag: null,                 // laufender Spieltag (wechselt um 04:00)
  teamOnlineMs: 0, gemeldeteStunde: 0, faelligGemeldet: false,
  letzteAusschuettung: null, letzterTick: null,
  preise: null,            // letzte Einkaufspreise je Ware
  letzterLagerTick: 0,
  letzterLedgerStamp: 0,  // bis hierhin wurde das Kassenbuch verarbeitet
  lastPush: {},
});

function load() {
  try { return Object.assign(leer(), JSON.parse(fs.readFileSync(CFG.STATE_FILE, 'utf8'))); }
  catch { return leer(); }
}
function save(s) {
  const tmp = CFG.STATE_FILE + '.tmp';
  // 0600: Die Datei enthält Cookie und Token – niemand sonst darf sie lesen.
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CFG.STATE_FILE);        // atomar – übersteht Stromausfall
}

// Spieltag läuft 04:00 → 04:00
const spieltag = () => {
  const d = new Date(Date.now() - CFG.TAGESWECHSEL_STD * 3_600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function dauer(ms) {
  if (!ms || ms < MIN) return '<1 Min.';
  const h = Math.floor(ms / 3_600_000), m = Math.round((ms % 3_600_000) / MIN);
  return h ? `${h} Std. ${m} Min.` : `${m} Min.`;
}

const fmt = n => Number(n).toLocaleString('de-DE', { maximumFractionDigits: 2 }) + '$';

/* ========================= API & ZUGANG ========================= */

// Zugang lebt im Zustand, damit er Neustarts übersteht.
const zugang = { token: null, exp: 0, cookie: null };

function ladeZugang(state) {
  zugang.token  = state.token  || CFG.TOKEN || null;
  zugang.exp    = state.tokenExp || 0;
  zugang.cookie = state.cookie || CFG.COOKIE || null;
}
function sichereZugang(state) {
  state.token = zugang.token; state.tokenExp = zugang.exp; state.cookie = zugang.cookie;
}

// Ablaufzeitpunkt aus dem JWT lesen (nur exp, sonst nichts).
function tokenAblauf(t) {
  try {
    const teil = String(t).split('.')[1];
    const p = JSON.parse(Buffer.from(teil, 'base64url').toString('utf8'));
    return p.exp ? p.exp * 1000 : 0;
  } catch { return 0; }
}

const tokenFrisch = () =>
  zugang.token && zugang.exp - Date.now() > CFG.TOKEN_PUFFER_MIN * 60_000;

// Holt einen neuen Token. Ausgewiesen wird sich mit dem Cookie – der Token
// allein reicht nicht, das wurde im Browser nachgemessen.
async function erneuere() {
  if (!zugang.cookie) throw new Error('KEIN_COOKIE');

  const res = await fetch(CFG.API + '/api/auth/refresh', {
    method: 'POST',
    headers: {
      Cookie: zugang.cookie,
      'User-Agent': CFG.USER_AGENT,
      'Accept': 'application/json',
      'Origin': 'https://unicacity.eu',
      'Referer': 'https://unicacity.eu/',
    },
  });
  if (!res.ok) throw new Error('REFRESH ' + res.status);

  const daten = await res.json();
  const neu = daten.token || daten.accessToken || daten.data?.token;
  if (!neu) throw new Error('REFRESH_OHNE_TOKEN');

  // Manche Server erneuern dabei auch das Cookie – dann übernehmen wir es,
  // sonst verfällt der Zugang beim nächsten Mal.
  const gesetzt = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (gesetzt.length) {
    const paare = new Map();
    for (const teil of String(zugang.cookie).split(';')) {
      const [k, ...rest] = teil.trim().split('=');
      if (k) paare.set(k, rest.join('='));
    }
    for (const z of gesetzt) {
      const [k, ...rest] = z.split(';')[0].split('=');
      if (k) paare.set(k.trim(), rest.join('='));
    }
    zugang.cookie = [...paare].map(([k, v]) => `${k}=${v}`).join('; ');
    log('Cookie wurde erneuert');
  }

  zugang.token = neu;
  zugang.exp = tokenAblauf(neu);
  info(`Token erneuert, gültig bis ${new Date(zugang.exp).toLocaleTimeString('de-DE')}`);
  return neu;
}

async function api(pfad, zweiterVersuch = false) {
  if (!tokenFrisch()) await erneuere();

  const res = await fetch(CFG.API + pfad, {
    headers: {
      Authorization: 'Bearer ' + zugang.token,
      Cookie: zugang.cookie || '',
      'User-Agent': CFG.USER_AGENT,
      'Accept': 'application/json',
      'Accept-Language': 'de-DE,de;q=0.9',
      'Origin': 'https://unicacity.eu',
      'Referer': 'https://unicacity.eu/',
    },
  });

  if ((res.status === 401 || res.status === 403) && !zweiterVersuch) {
    log('Abgewiesen – Token wird erneuert und noch einmal versucht');
    zugang.exp = 0;
    return api(pfad, true);
  }
  if (res.status === 401 || res.status === 403) throw new Error('AUTH');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

const holeFirma  = () => api('/api/panel/company');
const holeLedger = (id) => api(`/api/panel/company/ledger?companyId=${id}&days=1&limit=40`);

/* ========================= SPIELERZEITEN ========================= */

// members[] der API liefert online direkt – keine Namensliste nötig.
function updateSpieler(state, members) {
  const now = Date.now(), tag = spieltag();

  for (const m of members) {
    const name = m.name;
    if (!name) continue;
    const p = state.spieler[name] ||
      { online: false, seit: null, sitzungMs: 0, gesamtMs: 0, zuletzt: 0, tag };
    if (p.tag !== tag) { p.gesamtMs = 0; p.tag = tag; }

    if (m.online) {
      const luecke = now - (p.zuletzt || 0);
      if (!p.online || luecke > CFG.LUECKE_MIN * MIN) {
        p.online = true; p.seit = now; p.sitzungMs = 0;   // neue Sitzung
      } else {
        p.sitzungMs = now - p.seit;
        p.gesamtMs += Math.min(luecke, CFG.LUECKE_MIN * MIN);
      }
      p.zuletzt = now;
    } else if (p.online) {
      p.online = false;
      p.sitzungMs = (p.zuletzt || now) - (p.seit || now);
    }
    p.rolle = m.roleName || m.role || '';
    state.spieler[name] = p;
  }
}

// Wandzeit, in der die Firma tatsächlich lief: mindestens ein Spieler online
// UND nicht pausiert. Mehrere gleichzeitig zählen trotzdem nur einmal.
function updateTeamzeit(state, laeuft) {
  const now = Date.now(), letzter = state.letzterTick;
  state.letzterTick = now;
  if (!letzter) return;
  const luecke = now - letzter;
  if (luecke > CFG.LUECKE_MIN * MIN) return;      // Watcher lief nicht – nicht zählen
  if (laeuft) state.teamOnlineMs += luecke;
}

// Um 04:00 wechselt der Spieltag. Davor: Bericht über den abgelaufenen Tag,
// danach setzt updateSpieler die Tageszähler zurück.
async function tagesabschluss(state) {
  const tag = spieltag();
  if (!state.tag) { state.tag = tag; return; }        // erster Lauf
  if (state.tag === tag) return;

  const vorbei = state.tag;
  state.tag = tag;
  if (!CFG.TAGESBERICHT) return;

  const zeilen = Object.entries(state.spieler)
    .map(([name, p]) => ({ name, ms: p.gesamtMs || 0, rolle: p.rolle || '' }))
    .sort((a, b) => b.ms - a.ms)
    .map(e => e.ms >= MIN ? `• ${e.name} — ${dauer(e.ms)}` : `• ${e.name} — nicht online`);

  const gesamt = Object.values(state.spieler).reduce((a, p) => a + (p.gesamtMs || 0), 0);
  const [j, m, t] = vorbei.split('-');

  await push(`tagesbericht_${vorbei}`, `📊 Onlinezeiten ${t}.${m}.`,
    `Spieltag ${t}.${m}.${j} (04:00 bis 04:00)\n\n` +
    (zeilen.length ? zeilen.join('\n') : 'Niemand war online.') +
    `\n\nSumme aller Spieler: ${dauer(gesamt)}` +
    `\nDavon Firma gelaufen: ${dauer(state.teamOnlineMs)} von ` +
    `${CFG.AUSSCHUETTUNG_STD} Std. bis zur Ausschüttung`,
    state, 'low');
}

function onlineBericht(state, fensterMin = 180) {
  const cutoff = Date.now() - fensterMin * MIN;
  const zeilen = [];
  for (const [name, p] of Object.entries(state.spieler)) {
    if (!p.zuletzt || p.zuletzt < cutoff) continue;
    const status = p.online ? 'online' : `zuletzt vor ${dauer(Date.now() - p.zuletzt)}`;
    const sitz = p.online ? dauer(Date.now() - p.seit) : dauer(p.sitzungMs);
    zeilen.push(`• ${name} — ${status}, Sitzung ${sitz}, heute ${dauer(p.gesamtMs)}`);
  }
  return zeilen;
}

/* ========================= PUSH ========================= */

const PRIO = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };

async function push(thema, titel, text, state, prio = 'high') {
  const now = Date.now();
  if (now - (state.lastPush[thema] || 0) < CFG.ERINNERUNG_MIN * MIN) return log('Cooldown:', thema);
  state.lastPush[thema] = now;

  info('PUSH:', titel);
  log(text);
  if (!CFG.NTFY_TOPIC) return console.warn('  (kein UC_NTFY_TOPIC gesetzt – nicht gesendet)');

  // Als JSON, nicht per HTTP-Header: Header dürfen nur Latin-1, unsere Titel
  // enthalten Emojis und Umlaute.
  try {
    const res = await fetch(CFG.NTFY_SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: CFG.NTFY_TOPIC, title: titel, message: text,
        priority: PRIO[prio] || 4, tags: ['office'], click: CFG.DASHBOARD,
      }),
    });
    if (!res.ok) console.error('  ntfy antwortete:', res.status, await res.text());
  } catch (e) { console.error('  ntfy nicht erreichbar:', e.message); }
}

/* ========================= AUSSCHÜTTUNG ========================= */

function ausschuettungStand(state) {
  const ziel = CFG.AUSSCHUETTUNG_STD * 3_600_000;
  const rest = Math.max(0, ziel - state.teamOnlineMs);
  return {
    Erreicht: dauer(state.teamOnlineMs),
    Ziel: `${CFG.AUSSCHUETTUNG_STD} Std.`,
    Fehlt: rest ? dauer(rest) : 'fällig',
    Fortschritt: Math.min(100, Math.round(state.teamOnlineMs / ziel * 100)) + ' %',
    Letzte: state.letzteAusschuettung
      ? new Date(state.letzteAusschuettung).toLocaleString('de-DE') : 'unbekannt',
    Gewinn: state.gewinn === null ? '–' : fmt(state.gewinn),
  };
}

async function pruefeAusschuettung(state) {
  const ziel = CFG.AUSSCHUETTUNG_STD * 3_600_000;

  const stunden = Math.floor(state.teamOnlineMs / 3_600_000);
  if (CFG.AUSSCHUETTUNG_STUNDENMELDUNG
      && stunden > (state.gemeldeteStunde || 0) && stunden < CFG.AUSSCHUETTUNG_STD) {
    state.gemeldeteStunde = stunden;
    const wer = Object.entries(state.spieler).filter(([, p]) => p.online).map(([n]) => n);
    await push(`ausschuettung_std_${stunden}`,
      `⏱️ ${stunden} von ${CFG.AUSSCHUETTUNG_STD} Std. bis zur Ausschüttung`,
      `Team-Onlinezeit: ${dauer(state.teamOnlineMs)}\n` +
      `Noch ${dauer(ziel - state.teamOnlineMs)} bis zur nächsten Ausschüttung.` +
      (state.gewinn !== null ? `\nGewinn bisher: ${fmt(state.gewinn)}` : '') +
      (wer.length ? `\n\nGerade online: ${wer.join(', ')}` : ''),
      state, 'low');
  }

  if (state.teamOnlineMs >= ziel && !state.faelligGemeldet) {
    state.faelligGemeldet = true;
    await push('ausschuettung_faellig', '💰 Ausschüttung ist fällig',
      `${CFG.AUSSCHUETTUNG_STD} Std. Team-Onlinezeit erreicht (${dauer(state.teamOnlineMs)}).` +
      (state.gewinn !== null ? `\nAktueller Gewinn: ${fmt(state.gewinn)}` : ''),
      state, 'high');
  }
}

/* ========================= VORFÄLLE ========================= */

// Das Ereignis der Firma lesbar machen, ohne seinen Aufbau zu kennen.
function ereignisText(ev) {
  if (!ev) return '';
  if (typeof ev === 'string') return ev;
  const zeilen = [];
  for (const [k, v] of Object.entries(ev)) {
    if (v === null || typeof v === 'object') continue;
    let wert = v;
    if (/ms$/i.test(k) && typeof v === 'number' && v > 1000) wert = dauer(v);
    else if (/(endsAt|expires|until|bis)/i.test(k) && typeof v === 'number' && v > 1e12)
      wert = new Date(v).toLocaleTimeString('de-DE');
    zeilen.push(`${k}: ${wert}`);
  }
  return zeilen.join('\n');
}

// Was kostet der Einkauf gerade, im Schnitt über alle Waren?
function einkaufsschnitt(wares) {
  const preise = {};
  for (const w of wares || []) {
    if (w.key && typeof w.deskUnitPrice === 'number') preise[w.key] = w.deskUnitPrice;
  }
  return preise;
}

// Mittlere Preisänderung gegenüber dem letzten Durchlauf, in Prozent.
function preisAenderung(alt, neu) {
  if (!alt) return null;
  const werte = [];
  for (const [k, p] of Object.entries(neu)) {
    const v = alt[k];
    if (typeof v === 'number' && v > 0) werte.push((p - v) / v * 100);
  }
  if (!werte.length) return null;
  return werte.reduce((a, b) => a + b, 0) / werte.length;
}

/* ========================= KASSENBUCH ========================= */

// Was sagt das Kassenbuch über ein Zeitfenster? Verkäufe und Großaufträge
// kosten Bestand, bringen aber Geld – daran lassen sie sich von einem
// Einbruch unterscheiden, der nur Bestand kostet.
function bewegungImFenster(ledger, vonMs) {
  let abgegeben = 0, einnahmen = 0, unklar = false;
  for (const e of ledger?.entries || []) {
    if (e.stamp < vonMs) continue;
    if (e.amount <= 0) continue;                 // nur Einnahmen betrachten
    einnahmen += e.amount;
    const treffer = /(\d+)\s*x/i.exec(e.detail || '');
    if (treffer) abgegeben += +treffer[1];
    else unklar = true;                          // Menge nicht ablesbar
  }
  return { abgegeben, einnahmen, unklar };
}

// Liefert neue Buchungen seit dem letzten Durchlauf, älteste zuerst.
function neueBuchungen(state, ledger) {
  const alle = (ledger.entries || []).filter(e => e.stamp > state.letzterLedgerStamp);
  alle.sort((a, b) => a.stamp - b.stamp);
  return alle;
}

async function werteBuchungenAus(state, buchungen) {
  for (const b of buchungen) {
    const kat = String(b.category || '').toLowerCase();

    // Ausschüttung: Zähler exakt zurücksetzen
    if (kat.includes('ausschütt') || kat.includes('ausschuett')) {
      state.letzteAusschuettung = b.stamp;
      state.teamOnlineMs = 0;
      state.gemeldeteStunde = 0;
      state.faelligGemeldet = false;
      state.lastPush.ausschuettung_faellig = 0;
      await push(`ausschuettung_${b.stamp}`, '💰 Ausschüttung erfolgt',
        `Betrag: ${fmt(Math.abs(b.amount))}\n${b.detail || ''}\n` +
        `Zähler läuft neu: 0 von ${CFG.AUSSCHUETTUNG_STD} Std. Team-Onlinezeit.`,
        state, 'default');
      continue;
    }

    // Eindeutige Vorfälle
    if (VORFALL_KATEGORIEN.some(w => kat.includes(w))) {
      const bericht = onlineBericht(state);
      await push(`vorfall_${b.stamp}`, `🚨 ${b.category}`,
        `${b.detail || ''}\nBetrag: ${fmt(b.amount)}\nKassenstand danach: ${fmt(b.balance)}` +
        (bericht.length ? `\n\nOnline zu dem Zeitpunkt:\n${bericht.join('\n')}` : ''),
        state, 'urgent');
      continue;
    }

    // Unbekannte Kategorie: einmal melden, damit nichts untergeht
    if (!NORMALE_KATEGORIEN.some(w => kat.includes(w))) {
      const bericht = onlineBericht(state);
      await push(`unbekannt_${kat}`, `❔ Unbekannte Buchung: ${b.category}`,
        `${b.detail || ''}\nBetrag: ${fmt(b.amount)}\n` +
        `Kassenstand danach: ${fmt(b.balance)}\n` +
        (bericht.length ? `\nOnline zu dem Zeitpunkt:\n${bericht.join('\n')}\n` : '') +
        '\nDiese Kategorie kennt der Watcher noch nicht.', state, 'default');
    }
  }

  if (buchungen.length) state.letzterLedgerStamp = buchungen[buchungen.length - 1].stamp;
}

/* ========================= PRÜFLAUF ========================= */

async function durchlauf() {
  const state = load();
  ladeZugang(state);
  let daten;

  try {
    daten = await holeFirma();
  } catch (e) {
    if (e.message === 'AUTH' || e.message === 'KEIN_COOKIE' || e.message.startsWith('REFRESH')) {
      await push('auth', '🔑 UnicaCity: Zugang abgelaufen',
        'Der Watcher kommt nicht mehr an die API – das Cookie ist vermutlich abgelaufen.\n' +
        'Neues Cookie aus dem Browser holen und in die .env eintragen, dann:\n' +
        'sudo systemctl restart uc-watcher', state, 'urgent');
      sichereZugang(state);
      save(state);
    } else log('Abruf fehlgeschlagen:', e.message);
    return;
  }

  const f = daten.company;
  if (!f) { log('Keine Firma in der Antwort'); return; }

  // --- Spieler & Teamzeit ---
  const members = f.members || [];
  await tagesabschluss(state);                 // vor dem Zurücksetzen der Tageszähler
  updateSpieler(state, members);

  const jemandOnline = members.some(m => m.online);
  const laeuft = jemandOnline && !f.paused;
  updateTeamzeit(state, laeuft);

  // Kassenbuch früh holen: Der Lagercheck braucht es, um Großaufträge von
  // einem Einbruch zu unterscheiden.
  let ledger = null;
  try { ledger = await holeLedger(f.id); }
  catch (e) { log('Kassenbuch nicht lesbar:', e.message); }

  // Jemand ist da, die Firma steht trotzdem still – das ist einen Hinweis wert.
  if (jemandOnline && f.paused) {
    await push('pausiert_trotz_online', '⚠️ Firma pausiert, obwohl jemand online ist',
      `Status: ${f.status}\n` +
      (f.wagesUnpaid ? 'Die Löhne konnten nicht gezahlt werden.\n' : '') +
      `Online: ${members.filter(m => m.online).map(m => m.name).join(', ')}\n\n` +
      'Der Zähler für die Ausschüttung läuft solange nicht weiter.', state, 'high');
  }

  // --- 1) Lager ---
  const lager = f.stock?.total;
  if (typeof lager === 'number') {
    // Plötzlicher Einbruch: Ein Rückgang, den der normale Absatz nicht erklärt,
    // ist ein Vorfall – etwa ein Einbruch. Nur prüfen, wenn der Watcher
    // durchgehend lief, sonst wäre jede Ausfallzeit ein Fehlalarm.
    const jetzt = Date.now();
    const seitLetzter = state.letzterLagerTick ? jetzt - state.letzterLagerTick : 0;
    if (state.lager !== null && seitLetzter > 0 && seitLetzter <= CFG.LUECKE_MIN * MIN) {
      const verlust = state.lager - lager;
      const minuten = seitLetzter / MIN;
      // Großzügig gerechnet: anderthalbfacher Absatz plus etwas Spielraum
      const laufenderAbsatz = (f.stock.salesPerMinute || 0) * minuten * 1.5 + 5;

      // Dazu alles, was im selben Fenster Geld gebracht hat – Verkäufe und
      // Großaufträge kosten Bestand, sind aber kein Vorfall.
      const bewegung = bewegungImFenster(ledger, jetzt - seitLetzter);
      const erklaerbar = laufenderAbsatz + bewegung.abgegeben;
      const prozent = state.lager > 0 ? (verlust / state.lager) * 100 : 0;

      if (verlust > erklaerbar && prozent >= CFG.LAGER_EINBRUCH_PCT) {
        if (bewegung.unklar) {
          // Es gab Einnahmen, deren Stückzahl nicht ablesbar war – dann lieber
          // schweigen als einen Großauftrag als Einbruch melden.
          log('Lagerverlust nicht eindeutig: Einnahmen ohne ablesbare Menge');
        } else {
          const bericht = onlineBericht(state);
          await push(`lagerverlust_${jetzt}`, '🚨 Plötzlicher Lagerverlust',
            `Lager: ${state.lager} → ${lager} (${verlust} Einheiten, ` +
            `${prozent.toFixed(1)} %)\n` +
            `Erklärbar wären höchstens ${Math.round(erklaerbar)} in ` +
            `${Math.round(minuten)} Min.\n` +
            `Einnahmen in dieser Zeit: ${fmt(bewegung.einnahmen)} — ` +
            `ein Großauftrag war es also nicht.\n\n` +
            (bericht.length
              ? `Online zum Zeitpunkt:\n${bericht.join('\n')}`
              : 'Niemand aus dem Team war online.'),
            state, 'urgent');
        }
      }
    }
    state.letzterLagerTick = jetzt;

    if (lager < CFG.LAGER_SCHWELLE) {
      await push('lager', '⚠️ Lagerbestand niedrig',
        `Lager: ${lager} / ${f.stock.capacity} (Schwelle ${CFG.LAGER_SCHWELLE})\n` +
        `Absatz: ${f.stock.salesPerMinute}/Min – reicht noch ` +
        `${f.stock.salesPerMinute ? dauer(lager / f.stock.salesPerMinute * MIN) : '?'}.`,
        state, 'high');
    } else if (state.lager !== null && state.lager < CFG.LAGER_SCHWELLE) {
      state.lastPush.lager = 0;
    }
    state.lager = lager;
  }

  // --- 2) Personal (NPCs) ---
  const personal = Array.isArray(f.employees) ? f.employees.length : null;
  const maxPersonal = f.maxEmployees ?? null;
  if (personal !== null) {
    const alt = state.personal;
    if (alt !== null && personal !== alt) {
      const gefallen = personal < alt;
      const bericht = onlineBericht(state);
      await push(`personal_${personal}_${Date.now()}`,
        gefallen ? '🚨 Personal abgeworben' : 'ℹ️ Personal aufgestockt',
        `Personal: ${alt}/${maxPersonal} → ${personal}/${maxPersonal}\n` +
        (gefallen
          ? `${alt - personal} NPC${alt - personal > 1 ? 's' : ''} weg – Abwerbung wurde nicht abgewendet.`
          : `+${personal - alt} eingestellt.`) +
        (bericht.length
          ? `\n\nOnline zum Zeitpunkt der Änderung:\n${bericht.join('\n')}`
          : '\n\n(Niemand aus dem Team war online.)'),
        state, gefallen ? 'urgent' : 'default');
    } else if (maxPersonal && personal < maxPersonal) {
      await push('personal_unvollstaendig', '⚠️ Personal unvollständig',
        `Personal: ${personal}/${maxPersonal} – ${maxPersonal - personal} fehlen.`, state);
    }
    state.personal = personal;
  }

  // --- 3) Firmenzustand ---
  if (f.wagesUnpaid) {
    await push('loehne', '⚠️ Löhne nicht bezahlt',
      `Die Firma kann die Löhne nicht zahlen.\nKasse: ${fmt(f.kasse.balance)}`, state, 'urgent');
  }
  if (f.rentStrikes > 0) {
    await push('miete', '⚠️ Mietrückstand',
      `Mahnungen: ${f.rentStrikes} von ${f.rentStrikesMax}.`, state, 'urgent');
  }
  if (f.event) {
    const bericht = onlineBericht(state);
    const ex = f.express || {};
    await push('event_' + JSON.stringify(f.event).slice(0, 40), '🚨 Vorfall im Unternehmen',
      ereignisText(f.event) +
      (ex.maxSlots
        ? `\n\nExpresslieferung: ${ex.freeSlots ?? '?'} von ${ex.maxSlots} Plätzen frei` +
          `, Aufschlag ${Math.round((ex.surcharge || 0) * 100)} %` +
          (ex.cooldownLeftMs ? `, wieder möglich in ${dauer(ex.cooldownLeftMs)}` : '')
        : '') +
      (bericht.length ? `\n\nOnline zum Zeitpunkt:\n${bericht.join('\n')}` : ''),
      state, 'urgent');
  }

  // --- Einkaufspreise: Sprung deutet auf einen Lieferengpass hin ---
  const preiseJetzt = einkaufsschnitt(f.wares);
  if (Object.keys(preiseJetzt).length) {
    const aenderung = preisAenderung(state.preise, preiseJetzt);
    // Nur melden, wenn die Firma das Ereignis nicht ohnehin selbst nennt –
    // sonst bekämst du dieselbe Sache zweimal aufs Handy.
    if (aenderung !== null && aenderung >= CFG.PREIS_SPRUNG_PCT && !f.event) {
      const bericht = onlineBericht(state);
      const ex = f.express || {};
      const teuerste = Object.entries(preiseJetzt)
        .map(([k, p]) => `${k.toLowerCase()}: ${p}$` +
             (state.preise[k] ? ` (vorher ${state.preise[k]}$)` : ''))
        .slice(0, 6);
      await push('preissprung', '📦 Lieferengpass – Einkauf teurer',
        `Einkaufspreise im Schnitt +${aenderung.toFixed(0)} %\n\n` +
        teuerste.join('\n') +
        (ex.maxSlots
          ? `\n\nExpresslieferung: ${ex.freeSlots ?? '?'} von ${ex.maxSlots} Plätzen frei` +
            `, Aufschlag ${Math.round((ex.surcharge || 0) * 100)} %` +
            (ex.cooldownLeftMs ? `, wieder möglich in ${dauer(ex.cooldownLeftMs)}` : '')
          : '') +
        (bericht.length ? `\n\nOnline zum Zeitpunkt:\n${bericht.join('\n')}` : ''),
        state, 'high');
    }
    state.preise = preiseJetzt;
  }

  // --- 4) Kasse & Gewinn ---
  state.kasse  = f.kasse?.balance ?? state.kasse;
  state.gewinn = f.kasse?.profitSincePayout ?? state.gewinn;

  // --- 5) Kassenbuch (oben bereits geholt) ---
  try {
    if (!ledger) throw new Error('nicht geladen');
    const neu = neueBuchungen(state, ledger);
    if (state.letzterLedgerStamp === 0) {
      // Erster Lauf: nur Stand merken, nicht rückwirkend melden
      const alle = ledger.entries || [];
      state.letzterLedgerStamp = alle.length ? Math.max(...alle.map(e => e.stamp)) : 0;
      log('Kassenbuch-Startpunkt gesetzt');
    } else {
      await werteBuchungenAus(state, neu);
    }
  } catch (e) { log('Kassenbuch nicht auswertbar:', e.message); }

  // --- 6) Ausschüttung ---
  await pruefeAusschuettung(state);

  sichereZugang(state);
  save(state);
  log('geprüft', { lager: state.lager, personal: state.personal, kasse: state.kasse,
                   gewinn: state.gewinn, laeuft, teamOnline: dauer(state.teamOnlineMs),
                   online: members.filter(m => m.online).map(m => m.name) });
}

/* ========================= START ========================= */

const args = process.argv.slice(2);

if (args.includes('--zeiten')) {
  const s = load(); const rows = {};
  for (const [name, p] of Object.entries(s.spieler)) {
    rows[name] = {
      Rolle: p.rolle || '', Status: p.online ? 'online' : 'offline',
      Sitzung: p.online ? dauer(Date.now() - p.seit) : dauer(p.sitzungMs),
      Heute: dauer(p.gesamtMs),
      Zuletzt: p.zuletzt ? new Date(p.zuletzt).toLocaleString('de-DE') : '–',
    };
  }
  console.table(rows); process.exit(0);
}

if (args.includes('--tagesbericht')) {
  const s = load();
  const zeilen = Object.entries(s.spieler)
    .map(([name, p]) => ({ Name: name, Rolle: p.rolle || '',
                           Heute: dauer(p.gesamtMs || 0),
                           Status: p.online ? 'online' : 'offline' }))
    .sort((a, b) => (b.Heute > a.Heute ? 1 : -1));
  console.log('Spieltag seit 04:00 –', s.tag || 'unbekannt');
  console.table(zeilen);
  process.exit(0);
}

if (args.includes('--ausschuettung')) { console.table(ausschuettungStand(load())); process.exit(0); }

if (args.includes('--ausschuettung-start')) {
  const s = load();
  s.teamOnlineMs = 0; s.gemeldeteStunde = 0; s.faelligGemeldet = false;
  s.letzteAusschuettung = Date.now();
  save(s); console.log('Zähler neu gestartet.'); console.table(ausschuettungStand(s));
  process.exit(0);
}

{
  const s = load(); ladeZugang(s);
  if (!zugang.cookie) {
    console.error('FEHLER: UC_COOKIE ist nicht gesetzt – ohne Cookie kann sich der');
    console.error('Watcher keine Token holen. Siehe README, Abschnitt "Zugang besorgen".');
    process.exit(1);
  }
}

if (args.includes('--push-test')) {
  const s = load(); s.lastPush.selftest = 0;
  await push('selftest', '✅ UC-Watcher Test',
    'Wenn du das auf dem Handy siehst, funktioniert die Benachrichtigung.', s, 'default');
  process.exit(0);
}

if (args.includes('--test')) {
  try {
    const s0 = load(); ladeZugang(s0);
    await erneuere();
    console.log('Token gültig bis:', new Date(zugang.exp).toLocaleString('de-DE'));
    const d = await holeFirma(); const f = d.company;
    console.log('Firma:      ', f.name, '· Level', f.level, '·', f.status);
    console.log('Lager:      ', f.stock.total, '/', f.stock.capacity);
    console.log('Personal:   ', f.employees.length, '/', f.maxEmployees);
    console.log('Firmenkasse:', fmt(f.kasse.balance));
    console.log('Gewinn:     ', fmt(f.kasse.profitSincePayout));
    console.log('Team:       ', f.members.length, '/', f.maxMembers);
    console.table(f.members.map(m => ({ Name: m.name, Rolle: m.roleName, Online: m.online ? '🟢' : '⚪' })));
    const l = await holeLedger(f.id);
    console.log('Kategorien: ', (l.summary?.categories || []).map(c => c.category).join(', '));
    const s1 = load(); sichereZugang(s1); save(s1);
    console.log('\n✅ Zugang funktioniert und wurde gespeichert.');
  } catch (e) {
    console.error(
      e.message === 'KEIN_COOKIE' ? '❌ UC_COOKIE ist leer.' :
      e.message.startsWith('REFRESH') ? `❌ Erneuerung abgelehnt (${e.message}) – Cookie abgelaufen?` :
      e.message === 'AUTH' ? '❌ Zugang abgelehnt (401/403).' :
      '❌ Fehler: ' + e.message);
    process.exit(1);
  }
  process.exit(0);
}

info(`UC-Watcher läuft – Intervall ${CFG.INTERVALL_MS / 1000}s, Zustand: ${CFG.STATE_FILE}`);
await durchlauf();
setInterval(() => durchlauf().catch(e => console.error('Fehler:', e)), CFG.INTERVALL_MS);
