#!/usr/bin/env node
// UnicaCity Unternehmen-Watcher – Server-Variante.
// Läuft ohne offenen Browser auf einem Dauerläufer (Raspberry Pi, VPS, NAS).
// Nutzt die exportierten Session-Cookies und braucht keine externen Pakete.
// Voraussetzung: Node.js >= 18.

import fs from 'node:fs';
import path from 'node:path';

/* ========================= KONFIGURATION ========================= */

const CFG = {
  DASHBOARD_URL: process.env.UC_DASHBOARD_URL || 'https://unicacity.eu/dashboard/unternehmen',
  ONLINE_URL:    process.env.UC_ONLINE_URL    || '',     // leer = gleiche Seite
  COOKIE:        process.env.UC_COOKIE        || '',     // Pflicht, siehe README
  USER_AGENT:    process.env.UC_USER_AGENT    ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',

  NTFY_TOPIC:  process.env.UC_NTFY_TOPIC || '',
  NTFY_SERVER: process.env.UC_NTFY_SERVER || 'https://ntfy.sh',

  LAGER_SCHWELLE: +(process.env.UC_LAGER_SCHWELLE || 500),
  PERSONAL_SOLL:  +(process.env.UC_PERSONAL_SOLL  || 6),   // Rückfall, wenn kein "x/y"

  AUSSCHUETTUNG_STD:             +(process.env.UC_AUSSCHUETTUNG_STD || 12),
  AUSSCHUETTUNG_GEWINN_SCHWELLE: +(process.env.UC_AUSSCHUETTUNG_SCHWELLE || 1000),
  ERINNERUNG_MIN: +(process.env.UC_ERINNERUNG_MIN || 60),

  STEUER_NORMAL_PCT:    4,
  STEUER_IGNORIERT_PCT: 8,
  STEUER_TOLERANZ_PP:   0.6,

  SPIELER: (process.env.UC_SPIELER ||
    'LottiMi,maaxxyyy,halo361,Lexae,777ELITE,jqshey').split(',').map(s => s.trim()).filter(Boolean),

  ONLINE_FENSTER_MIN: 180,
  LUECKE_MIN:         10,
  TAGESWECHSEL_STD:   4,          // Tageszähler-Reset um 04:00

  INTERVALL_MS: +(process.env.UC_INTERVALL_MS || 60_000),
  STATE_FILE:   process.env.UC_STATE_FILE || path.join(process.cwd(), 'uc-watcher-state.json'),
  DEBUG:        process.env.UC_DEBUG === '1',
};

const LABELS = {
  lager:    ['lagerbestand', 'lager', 'bestand', 'warenlager'],
  personal: ['personal', 'mitarbeiter', 'angestellte', 'belegschaft'],
  kasse:    ['firmenkasse', 'kasse', 'guthaben', 'kontostand', 'firmenkonto'],
  gewinn:   ['gewinn seit ausschüttung', 'gewinn seit', 'gewinn', 'profit'],
};

// Nur eindeutige Begriffe – "Kontrolle"/"Brand" lösen sonst im Kassenbuch aus.
const VORFALL_WORTE = [
  'vorfall', 'vorfälle', 'steuerprüfung', 'steuerpruefung', 'razzia', 'überfall',
  'ueberfall', 'einbruch', 'diebstahl', 'abwerbung', 'abgeworben',
  'bußgeld', 'bussgeld', 'sabotage', 'streik',
];

// Die Meldungen-Karte meldet im Normalfall "Alles ruhig".
function meldungAuffaellig(text) {
  const lines = text.split('\n').map(l => l.trim());
  const i = lines.findIndex(l => /^Meldungen$/i.test(l));
  if (i < 0) return null;
  const titel = lines.slice(i + 1, i + 4).find(l => l && !/^Meldungen$/i.test(l));
  return (titel && !/^alles ruhig/i.test(titel)) ? titel : null;
}

const MIN = 60_000;
const log = (...a) => CFG.DEBUG && console.log(new Date().toISOString(), ...a);
const info = (...a) => console.log(new Date().toISOString(), ...a);

/* ========================= ZUSTAND ========================= */

const leer = () => ({
  lager: null, personal: null, kasse: null, gewinn: null,
  vorfaelle: [], spieler: {},
  teamOnlineMs: 0, letzteAusschuettung: null, letzterTick: null,
  lastPush: {},
});

function load() {
  try { return Object.assign(leer(), JSON.parse(fs.readFileSync(CFG.STATE_FILE, 'utf8'))); }
  catch { return leer(); }
}
function save(s) {
  const tmp = CFG.STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, CFG.STATE_FILE);          // atomar, übersteht Stromausfall
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

/* ========================= HTML → TEXT ========================= */

function htmlText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function toNumber(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/-?[\d.,]*\d/);
  if (!m) return null;
  let s = m[0];
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}(\D|$)/.test(s + ' ')) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Eine Zeile, die nur aus einer Zahl (mit Einheit) besteht – so sehen die
// Kachel-Werte aus, die ÜBER ihrem Label stehen.
const nurZahl = l => /^[\s\d.,/%$€+-]+$/.test(l) && /\d/.test(l);

// Sucht die Zeile mit dem Label und nimmt die Zahl daraus. Steht dort keine,
// werden die Nachbarzeilen geprüft – zuerst darüber (Kachel-Layout:
// "412" über "LAGERBESTAND"), dann darunter. Nachbarzeilen werden nur
// akzeptiert, wenn sie reine Zahlen sind, damit nicht der Wert der
// nächsten Kachel eingesammelt wird.
function readValue(text, words) {
  const lines = text.split('\n').map(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    if (!words.some(w => low.includes(w))) continue;

    // ZUERST die Nachbarzeilen: In den Kacheln steht der Wert über dem Label
    // ("1284 / 1500" über "Lager · 36 Einheiten/Min Absatz"). Würde man die
    // Label-Zeile zuerst nehmen, käme die Absatzrate 36 statt des Bestands.
    for (const j of [i - 1, i - 2, i + 1, i + 2]) {
      if (j < 0 || j >= lines.length) continue;
      if (!nurZahl(lines[j])) continue;
      const n = toNumber(lines[j]);
      if (n !== null) return { value: n, text: `${lines[j]} | ${lines[i]}` };
    }

    // Erst danach eine Zahl aus der Label-Zeile selbst
    const own = toNumber(lines[i].replace(new RegExp(words.join('|'), 'gi'), ''));
    if (own !== null) return { value: own, text: lines[i] };
  }
  return null;
}

// Liest die PERSONAL-Kachel (NPCs, "6/6"). Die Zahl steht ÜBER dem Label,
// deshalb wird in beide Richtungen gesucht. Die TEAM-Leiste ("TEAM · 5 / 8")
// ist ausgeschlossen – das sind die Spieler, nicht die abwerbbaren NPCs.
function readPersonal(text) {
  const lines = text.split('\n').map(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    if (!/personal/i.test(lines[i]) || /\bteam\b/i.test(lines[i])) continue;
    for (const j of [i, i - 1, i - 2, i + 1, i + 2]) {
      if (j < 0 || j >= lines.length || /\bteam\b/i.test(lines[j])) continue;
      const f = lines[j].match(/(\d+)\s*\/\s*(\d+)/);
      if (f) return { ist: +f[1], soll: +f[2], quelle: `${lines[j]} | ${lines[i]}` };
    }
  }
  return null;
}

// Online = grünes Kästchen. Ohne Browser gibt es keine gerenderten Farben,
// deshalb wird das Roh-HTML rund um den Namen nach Grün-Signalen durchsucht:
// Hex-/rgb-Farbe, Tailwind-Klassen (bg-green-*, bg-emerald-*) oder "online".
// Grün inkl. Türkis/Emerald (#2dd4bf), aber ohne Grautöne (#4b5563).
const gruen = (r, g, b) => g >= 100 && g - r >= 40 && g - b >= 10;

function istGruenerCode(s) {
  if (/\b(bg|text|fill|border)-(green|emerald|lime|teal)-\d{2,3}\b/i.test(s)) return true;
  if (/\bonline\b/i.test(s) && !/\boffline\b/i.test(s)) return true;

  for (const m of s.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16));
    if (gruen(r, g, b)) return true;
  }
  for (const m of s.matchAll(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/gi)) {
    if (gruen(+m[1], +m[2], +m[3])) return true;
  }
  return false;
}

// Das Kästchen steht direkt VOR dem Namen. Damit die Farbe des Nachbarn nicht
// mitgelesen wird, reicht das Fenster nur bis zum vorigen Spielernamen zurück.
function readOnline(htmlRoh) {
  // Nur ab der Team-Leiste suchen! Die NPC-Mitarbeiter darüber haben ebenfalls
  // grüne Punkte (bg-emerald-400) und würden sonst mitgezählt.
  const start = htmlRoh.search(/Team\s*(&middot;|·|&#183;)/i);
  const html = start >= 0 ? htmlRoh.slice(start) : htmlRoh;

  const positionen = CFG.SPIELER
    .map(name => {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = html.match(new RegExp(`\\b${esc}\\b`, 'i'));
      return m ? { name, idx: m.index } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.idx - b.idx);

  const namen = [];
  let vorher = 0;
  for (const { name, idx } of positionen) {
    const fenster = html.slice(Math.max(vorher, idx - 400), idx);
    if (istGruenerCode(fenster)) namen.push(name);
    vorher = idx;
  }
  return namen;
}

function readVorfaelle(text) {
  const auffaellig = meldungAuffaellig(text);
  return [...new Set(
    (auffaellig ? [auffaellig] : []).concat(
    text.split('\n')
      .map(l => l.trim())
      .filter(l => l && l.length <= 250 && VORFALL_WORTE.some(w => l.toLowerCase().includes(w))))
  )];
}

/* ========================= SPIELERZEITEN ========================= */

function updateSpieler(state, online) {
  const now = Date.now(), tag = spieltag(), set = new Set(online);

  for (const name of set) {
    const p = state.spieler[name] ||
      { online: false, seit: null, sitzungMs: 0, gesamtMs: 0, zuletzt: 0, tag };
    if (p.tag !== tag) { p.gesamtMs = 0; p.tag = tag; }

    const luecke = now - (p.zuletzt || 0);
    if (!p.online || luecke > CFG.LUECKE_MIN * MIN) {
      p.online = true; p.seit = now; p.sitzungMs = 0;
    } else {
      p.sitzungMs = now - p.seit;
      p.gesamtMs += Math.min(luecke, CFG.LUECKE_MIN * MIN);
    }
    p.zuletzt = now;
    state.spieler[name] = p;
  }

  for (const [name, p] of Object.entries(state.spieler)) {
    if (set.has(name)) continue;
    if (p.online) { p.online = false; p.sitzungMs = (p.zuletzt || now) - (p.seit || now); }
  }
}

// Wandzeit, in der mindestens EIN Spieler online war (keine Doppelzählung).
function updateTeamzeit(state, irgendwerOnline) {
  const now = Date.now();
  const letzter = state.letzterTick;
  state.letzterTick = now;
  if (!letzter) return;
  const luecke = now - letzter;
  if (luecke > CFG.LUECKE_MIN * MIN) return;      // Watcher lief nicht – nicht zählen
  if (irgendwerOnline) state.teamOnlineMs += luecke;
}

function onlineBericht(state) {
  const cutoff = Date.now() - CFG.ONLINE_FENSTER_MIN * MIN;
  const zeilen = [];
  for (const [name, p] of Object.entries(state.spieler)) {
    if (!p.zuletzt || p.zuletzt < cutoff) continue;
    const status = p.online ? 'online' : `zuletzt vor ${dauer(Date.now() - p.zuletzt)}`;
    const sitz = p.online ? dauer(Date.now() - p.seit) : dauer(p.sitzungMs);
    zeilen.push(`• ${name} — ${status}, Sitzung ${sitz}, heute ${dauer(p.gesamtMs)}`);
  }
  return zeilen;
}

/* ==================== AUSSCHÜTTUNG ==================== */

async function pruefeAusschuettung(state, text) {
  const ziel = CFG.AUSSCHUETTUNG_STD * 3_600_000;
  const g = readValue(text, LABELS.gewinn);

  if (g?.value != null) {
    const vorher = state.gewinn;
    if (vorher !== null && vorher >= CFG.AUSSCHUETTUNG_GEWINN_SCHWELLE
        && g.value < CFG.AUSSCHUETTUNG_GEWINN_SCHWELLE) {
      state.letzteAusschuettung = Date.now();
      state.teamOnlineMs = 0;
      state.lastPush.ausschuettung_faellig = 0;
      await push('ausschuettung_erfolgt', '💰 Ausschüttung erfolgt',
        `Gewinn zurückgesetzt: ${fmt(vorher)} → ${fmt(g.value)}\n` +
        `Zähler läuft neu: 0 von ${CFG.AUSSCHUETTUNG_STD} Std. Team-Onlinezeit.`,
        state, 'default');
    }
    state.gewinn = g.value;
  } else log('Gewinn seit Ausschüttung nicht gefunden');

  if (state.teamOnlineMs >= ziel) {
    await push('ausschuettung_faellig', '💰 Ausschüttung ist fällig',
      `${CFG.AUSSCHUETTUNG_STD} Std. Team-Onlinezeit erreicht (${dauer(state.teamOnlineMs)}).` +
      (state.gewinn !== null ? `\nAktueller Gewinn: ${fmt(state.gewinn)}` : ''),
      state, 'high');
  }
}

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
    Gewinn: state.gewinn,
  };
}

/* ========================= PUSH ========================= */

// ntfy-Prioritäten sind Zahlen: 1 min ... 5 max
const PRIO = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };

async function push(thema, titel, text, state, prio = 'high') {
  const now = Date.now();
  if (now - (state.lastPush[thema] || 0) < CFG.ERINNERUNG_MIN * MIN) return log('Cooldown:', thema);
  state.lastPush[thema] = now;

  info('PUSH:', titel);
  log(text);
  if (!CFG.NTFY_TOPIC) return console.warn('  (kein UC_NTFY_TOPIC gesetzt – nicht gesendet)');

  // Als JSON, nicht über HTTP-Header: Header dürfen nur Latin-1 enthalten,
  // unsere Titel haben Emojis und Umlaute ("🚨 Steuerprüfung").
  try {
    const res = await fetch(CFG.NTFY_SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: CFG.NTFY_TOPIC,
        title: titel,
        message: text,
        priority: PRIO[prio] || 4,
        tags: ['office'],
        click: CFG.DASHBOARD_URL,
      }),
    });
    if (!res.ok) console.error('  ntfy antwortete:', res.status, await res.text());
  } catch (e) { console.error('  ntfy nicht erreichbar:', e.message); }
}

const fmt = n => n.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' $';

/* ========================= ABRUF ========================= */

// liefert { html, text }
async function holen(url) {
  const res = await fetch(url, {
    headers: { Cookie: CFG.COOKIE, 'User-Agent': CFG.USER_AGENT, 'Accept-Language': 'de-DE,de;q=0.9' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (/login|anmelden|signin/i.test(new URL(res.url).pathname)) throw new Error('LOGIN');
  const html = await res.text();
  return { html, text: htmlText(html) };
}

/* ========================= PRÜFLAUF ========================= */

async function durchlauf() {
  const state = load();

  let seite, onlineSeite;
  try {
    seite = await holen(CFG.DASHBOARD_URL);
    onlineSeite = CFG.ONLINE_URL ? await holen(CFG.ONLINE_URL).catch(() => null) : null;
  } catch (e) {
    if (e.message === 'LOGIN') {
      await push('login', '🔑 UnicaCity: Cookie abgelaufen',
        'Der Watcher kommt nicht mehr rein – bitte UC_COOKIE neu exportieren.', state, 'urgent');
      save(state);
    } else log('Abruf fehlgeschlagen:', e.message);
    return;
  }

  const text = seite.text;
  const online = readOnline((onlineSeite || seite).html);
  updateSpieler(state, online);
  updateTeamzeit(state, online.length > 0);

  // 1) Lager – die Kachel zeigt "1284 / 1500", uns interessiert der Bestand
  const lager = readValue(text, LABELS.lager);
  if (lager?.value != null) {
    if (lager.value < CFG.LAGER_SCHWELLE) {
      await push('lager', '⚠️ Lagerbestand niedrig',
        `Lager: ${lager.value} (Schwelle ${CFG.LAGER_SCHWELLE}) – nachfüllen.`, state);
    } else if (state.lager !== null && state.lager < CFG.LAGER_SCHWELLE) state.lastPush.lager = 0;
    state.lager = lager.value;
  } else log('Lager nicht gefunden');

  // 2) Personal
  const p = readPersonal(text);
  if (p?.ist != null) {
    const soll = p.soll || CFG.PERSONAL_SOLL;
    const alt = state.personal;
    if (alt !== null && p.ist !== alt) {
      const gefallen = p.ist < alt;
      const b = onlineBericht(state);
      await push(`personal_change_${p.ist}`,
        gefallen ? '🚨 Personal abgeworben' : 'ℹ️ Personal aufgestockt',
        `Personal: ${alt}/${soll} → ${p.ist}/${soll}\n` +
        (gefallen
          ? `${alt - p.ist} NPC${alt - p.ist > 1 ? 's' : ''} weg – Abwerbung wurde nicht abgewendet.`
          : `+${p.ist - alt} eingestellt.`) +
        (b.length ? `\n\nOnline zum Zeitpunkt der Änderung:\n${b.join('\n')}`
                  : '\n\n(Keine Online-Daten – UC_SPIELER prüfen.)'),
        state, gefallen ? 'urgent' : 'default');
    } else if (p.ist < soll) {
      const b = onlineBericht(state);
      await push('personal_unterbesetzt', '⚠️ Personal unvollständig',
        `Personal: ${p.ist}/${soll} – ${soll - p.ist} fehlen.` +
        (b.length ? `\n\nOnline:\n${b.join('\n')}` : ''), state);
    }
    state.personal = p.ist;
  } else log('Personal nicht gefunden');

  // 3a) Vorfälle
  const vorfaelle = readVorfaelle(text);
  const neue = vorfaelle.filter(v => !state.vorfaelle.includes(v));
  if (neue.length) {
    const b = onlineBericht(state);
    await push('vorfall_' + neue[0].slice(0, 24), '🚨 Vorfall im Unternehmen',
      neue.join('\n') + (b.length ? `\n\nOnline:\n${b.join('\n')}` : ''), state, 'urgent');
  }
  state.vorfaelle = [...new Set([...state.vorfaelle, ...vorfaelle])].slice(-50);

  // 3b) Steuerprüfung aus dem Kassenverlauf
  const kasse = readValue(text, LABELS.kasse);
  if (kasse?.value != null) {
    if (state.kasse !== null && state.kasse > 0 && kasse.value < state.kasse) {
      const diff = state.kasse - kasse.value;
      const pct = (diff / state.kasse) * 100;
      const nahe = z => Math.abs(pct - z) <= CFG.STEUER_TOLERANZ_PP;

      if (nahe(CFG.STEUER_IGNORIERT_PCT)) {
        const b = onlineBericht(state);
        await push('steuer_ignoriert', '🚨 Steuerprüfung wurde IGNORIERT',
          `Firmenkasse: ${fmt(state.kasse)} → ${fmt(kasse.value)}\n` +
          `Abzug: ${fmt(diff)} (${pct.toFixed(2)} % statt ${CFG.STEUER_NORMAL_PCT} %)\n` +
          `Vermeidbare Mehrkosten: ${fmt(diff / 2)}\n\n` +
          (b.length ? `Online zum Zeitpunkt der Prüfung:\n${b.join('\n')}` : '(Keine Online-Daten.)'),
          state, 'urgent');
      } else if (nahe(CFG.STEUER_NORMAL_PCT)) {
        await push('steuer_normal', 'ℹ️ Steuerprüfung bezahlt',
          `Firmenkasse: ${fmt(state.kasse)} → ${fmt(kasse.value)}\n` +
          `Abzug: ${fmt(diff)} (${pct.toFixed(2)} % – regulär bearbeitet).`, state, 'default');
      }
    }
    state.kasse = kasse.value;
  } else log('Kasse nicht gefunden');

  // 4) Ausschüttung
  await pruefeAusschuettung(state, text);

  save(state);
  log('geprüft', { lager: state.lager, personal: state.personal,
                   kasse: state.kasse, teamOnline: dauer(state.teamOnlineMs) });
}

/* ========================= START ========================= */

const args = process.argv.slice(2);

if (args.includes('--push-test')) {
  const state = load();
  state.lastPush.selftest = 0;
  await push('selftest', '✅ UC-Watcher Test',
    'Wenn du das auf dem Handy siehst, funktioniert die Benachrichtigung.', state, 'default');
  process.exit(0);
}

if (args.includes('--ausschuettung')) {
  console.table(ausschuettungStand(load()));
  process.exit(0);
}

if (args.includes('--zeiten')) {
  const s = load();
  const rows = {};
  for (const [name, p] of Object.entries(s.spieler)) {
    rows[name] = {
      Status:  p.online ? 'online' : 'offline',
      Sitzung: p.online ? dauer(Date.now() - p.seit) : dauer(p.sitzungMs),
      Heute:   dauer(p.gesamtMs),
      Zuletzt: p.zuletzt ? new Date(p.zuletzt).toLocaleString('de-DE') : '–',
    };
  }
  console.table(rows);
  process.exit(0);
}

if (!CFG.COOKIE) {
  console.error('FEHLER: UC_COOKIE ist nicht gesetzt. Siehe README (Abschnitt "Cookie exportieren").');
  process.exit(1);
}

if (args.includes('--test')) {
  const seite = await holen(CFG.DASHBOARD_URL);
  const onlineSeite = CFG.ONLINE_URL ? await holen(CFG.ONLINE_URL) : seite;
  console.log('Lager:      ', readValue(seite.text, LABELS.lager));
  console.log('Personal:   ', readPersonal(seite.text));
  console.log('Firmenkasse:', readValue(seite.text, LABELS.kasse));
  console.log('Online:     ', readOnline(onlineSeite.html));
  console.log('Vorfälle:   ', readVorfaelle(seite.text));
  console.log('Gewinn:     ', readValue(seite.text, LABELS.gewinn));
  process.exit(0);
}

info(`UC-Watcher läuft – Intervall ${CFG.INTERVALL_MS / 1000}s, Zustand: ${CFG.STATE_FILE}`);
await durchlauf();
setInterval(() => durchlauf().catch(e => console.error('Fehler:', e)), CFG.INTERVALL_MS);
