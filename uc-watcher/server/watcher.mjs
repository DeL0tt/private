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

  // Zugang: mindestens eines von beiden muss gesetzt sein.
  COOKIE: process.env.UC_COOKIE || '',   // komplette cookie-Zeile aus dem Browser
  TOKEN:  process.env.UC_TOKEN  || '',   // JWT, wird als "Authorization: Bearer" gesendet

  USER_AGENT: process.env.UC_USER_AGENT ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',

  NTFY_TOPIC:  process.env.UC_NTFY_TOPIC || '',
  NTFY_SERVER: process.env.UC_NTFY_SERVER || 'https://ntfy.sh',

  LAGER_SCHWELLE: +(process.env.UC_LAGER_SCHWELLE || 500),
  ERINNERUNG_MIN: +(process.env.UC_ERINNERUNG_MIN || 60),

  AUSSCHUETTUNG_STD:            +(process.env.UC_AUSSCHUETTUNG_STD || 12),
  AUSSCHUETTUNG_STUNDENMELDUNG: process.env.UC_AUSSCHUETTUNG_STUNDENMELDUNG !== '0',

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
  lager: null, personal: null, kasse: null, gewinn: null,
  spieler: {},            // name -> { online, seit, sitzungMs, gesamtMs, zuletzt, tag }
  teamOnlineMs: 0, gemeldeteStunde: 0, faelligGemeldet: false,
  letzteAusschuettung: null, letzterTick: null,
  letzterLedgerStamp: 0,  // bis hierhin wurde das Kassenbuch verarbeitet
  lastPush: {},
});

function load() {
  try { return Object.assign(leer(), JSON.parse(fs.readFileSync(CFG.STATE_FILE, 'utf8'))); }
  catch { return leer(); }
}
function save(s) {
  const tmp = CFG.STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
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

/* ========================= API ========================= */

async function api(pfad) {
  const kopf = {
    'User-Agent': CFG.USER_AGENT,
    'Accept': 'application/json',
    'Accept-Language': 'de-DE,de;q=0.9',
  };
  if (CFG.COOKIE) kopf.Cookie = CFG.COOKIE;
  if (CFG.TOKEN)  kopf.Authorization = 'Bearer ' + CFG.TOKEN;

  const res = await fetch(CFG.API + pfad, { headers: kopf, redirect: 'follow' });
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

// Wandzeit, in der MINDESTENS EIN Spieler online war (keine Doppelzählung).
function updateTeamzeit(state, irgendwerOnline) {
  const now = Date.now(), letzter = state.letzterTick;
  state.letzterTick = now;
  if (!letzter) return;
  const luecke = now - letzter;
  if (luecke > CFG.LUECKE_MIN * MIN) return;      // Watcher lief nicht – nicht zählen
  if (irgendwerOnline) state.teamOnlineMs += luecke;
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

/* ========================= KASSENBUCH ========================= */

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
      await push(`unbekannt_${kat}`, `❔ Unbekannte Buchung: ${b.category}`,
        `${b.detail || ''}\nBetrag: ${fmt(b.amount)}\n\n` +
        'Diese Kategorie kennt der Watcher noch nicht.', state, 'default');
    }
  }

  if (buchungen.length) state.letzterLedgerStamp = buchungen[buchungen.length - 1].stamp;
}

/* ========================= PRÜFLAUF ========================= */

async function durchlauf() {
  const state = load();
  let daten;

  try {
    daten = await holeFirma();
  } catch (e) {
    if (e.message === 'AUTH') {
      await push('auth', '🔑 UnicaCity: Zugang abgelaufen',
        'Der Watcher kommt nicht mehr an die API. Bitte UC_COOKIE bzw. UC_TOKEN erneuern.',
        state, 'urgent');
      save(state);
    } else log('Abruf fehlgeschlagen:', e.message);
    return;
  }

  const f = daten.company;
  if (!f) { log('Keine Firma in der Antwort'); return; }

  // --- Spieler & Teamzeit ---
  const members = f.members || [];
  updateSpieler(state, members);
  updateTeamzeit(state, members.some(m => m.online));

  // --- 1) Lager ---
  const lager = f.stock?.total;
  if (typeof lager === 'number') {
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
    await push('event_' + JSON.stringify(f.event).slice(0, 30), '🚨 Vorfall im Unternehmen',
      typeof f.event === 'string' ? f.event : JSON.stringify(f.event, null, 2) +
      (bericht.length ? `\n\nOnline:\n${bericht.join('\n')}` : ''), state, 'urgent');
  }

  // --- 4) Kasse & Gewinn ---
  state.kasse  = f.kasse?.balance ?? state.kasse;
  state.gewinn = f.kasse?.profitSincePayout ?? state.gewinn;

  // --- 5) Kassenbuch ---
  try {
    const ledger = await holeLedger(f.id);
    const neu = neueBuchungen(state, ledger);
    if (state.letzterLedgerStamp === 0) {
      // Erster Lauf: nur Stand merken, nicht rückwirkend melden
      const alle = ledger.entries || [];
      state.letzterLedgerStamp = alle.length ? Math.max(...alle.map(e => e.stamp)) : 0;
      log('Kassenbuch-Startpunkt gesetzt');
    } else {
      await werteBuchungenAus(state, neu);
    }
  } catch (e) { log('Kassenbuch nicht lesbar:', e.message); }

  // --- 6) Ausschüttung ---
  await pruefeAusschuettung(state);

  save(state);
  log('geprüft', { lager: state.lager, personal: state.personal, kasse: state.kasse,
                   gewinn: state.gewinn, teamOnline: dauer(state.teamOnlineMs),
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

if (args.includes('--ausschuettung')) { console.table(ausschuettungStand(load())); process.exit(0); }

if (args.includes('--ausschuettung-start')) {
  const s = load();
  s.teamOnlineMs = 0; s.gemeldeteStunde = 0; s.faelligGemeldet = false;
  s.letzteAusschuettung = Date.now();
  save(s); console.log('Zähler neu gestartet.'); console.table(ausschuettungStand(s));
  process.exit(0);
}

if (!CFG.COOKIE && !CFG.TOKEN) {
  console.error('FEHLER: Weder UC_COOKIE noch UC_TOKEN gesetzt. Siehe README.');
  process.exit(1);
}

if (args.includes('--push-test')) {
  const s = load(); s.lastPush.selftest = 0;
  await push('selftest', '✅ UC-Watcher Test',
    'Wenn du das auf dem Handy siehst, funktioniert die Benachrichtigung.', s, 'default');
  process.exit(0);
}

if (args.includes('--test')) {
  try {
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
    console.log('\n✅ Zugang funktioniert.');
  } catch (e) {
    console.error(e.message === 'AUTH'
      ? '❌ Zugang abgelehnt (401/403) – UC_COOKIE bzw. UC_TOKEN prüfen.'
      : '❌ Fehler: ' + e.message);
    process.exit(1);
  }
  process.exit(0);
}

info(`UC-Watcher läuft – Intervall ${CFG.INTERVALL_MS / 1000}s, Zustand: ${CFG.STATE_FILE}`);
await durchlauf();
setInterval(() => durchlauf().catch(e => console.error('Fehler:', e)), CFG.INTERVALL_MS);
