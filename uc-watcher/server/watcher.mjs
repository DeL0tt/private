#!/usr/bin/env node
// UnicaCity Unternehmen-Watcher – Server-Variante (API).
// Läuft ohne Browser auf einem Dauerläufer und fragt die offizielle API ab.
// Voraussetzung: Node.js >= 18. Keine externen Pakete.

import fs from 'node:fs';
import path from 'node:path';
import { discordAktiv, discordSende, discordStart, discordStop, empfaenger,
         regelText, THEMEN, themaName, ladeRegeln, speichereRegeln,
         ladeZuordnung, speichereZuordnung, zuordnungEigen, pruefeToken,
         ladeRechte, speichereRechte } from './discord.mjs';

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

  // --- Wiki ---
  WIKI: process.env.UC_WIKI !== '0',
  WIKI_INTERVALL_STD: +(process.env.UC_WIKI_INTERVALL_STD || 24),

  // --- Notion-Abgleich ---
  NOTION_TOKEN: process.env.UC_NOTION_TOKEN || '',
  // Die Wiki-Seite in Notion (ID aus der Adresse, mit oder ohne Bindestriche)
  NOTION_WIKI: process.env.UC_NOTION_WIKI || '3c4a6c9607aa80ef9ca5c6658d04c349',
  NOTION_INTERVALL_STD: +(process.env.UC_NOTION_INTERVALL_STD || 168),   // wöchentlich
  ERINNERUNG_MIN: +(process.env.UC_ERINNERUNG_MIN || 60),

  AUSSCHUETTUNG_STD:            +(process.env.UC_AUSSCHUETTUNG_STD || 12),
  AUSSCHUETTUNG_STUNDENMELDUNG: process.env.UC_AUSSCHUETTUNG_STUNDENMELDUNG !== '0',
  TAGESBERICHT:                  process.env.UC_TAGESBERICHT !== '0',

  // Ab wann eine nicht erreichbare Seite gemeldet wird. Kurze Aussetzer sind
  // normal und sollen nicht aufs Handy.
  API_WEG_MELDUNG_MIN: +(process.env.UC_API_WEG_MELDUNG_MIN || 30),

  // --- Betrieb (z. B. die Zoohandlung) ---
  // Wie lange nach dem letzten Einkauf der Nachkauf noch als laufend gilt.
  NACHKAUF_FENSTER_MIN: +(process.env.UC_NACHKAUF_FENSTER_MIN || 90),

  // Bleibt ein Vorfall offen, wird nach so vielen Minuten nachgefasst.
  // Aus, weil längst nicht jeder Vorfall wichtig genug ist, um zweimal zu
  // stören – wer nachgefasst haben will, schaltet es über /melden ein.
  VORFALL_ERINNERUNG_MIN: +(process.env.UC_VORFALL_ERINNERUNG_MIN ?? 0),
  // Wie oft höchstens nachgefasst wird, damit ein hängender Vorfall nicht
  // endlos meldet.
  VORFALL_ERINNERUNG_MAX: +(process.env.UC_VORFALL_ERINNERUNG_MAX || 3),

  // Gelesen wird der Bestand eines einzelnen Betriebs aus /api/panel/me –
  // also bereits der echte Wert. Der Abzug bleibt nur als Notnagel für den
  // Fall, dass jemand eine Gesamtsumme statt eines Betriebs auswertet.
  BETRIEB:           process.env.UC_BETRIEB || 'Zoohandlung',
  // Sicherer als der Name: die ID des Betriebs aus dem Dashboard. Ist sie
  // gesetzt, wird nur danach gesucht und der Abzug entfällt – dann steht der
  // Bestand dieses einen Betriebs da, nicht die Summe aller.
  BETRIEB_ID:        process.env.UC_BETRIEB_ID || '',
  BETRIEB_ABZUG:    +(process.env.UC_BETRIEB_ABZUG || 0),
  BETRIEB_MAX:      +(process.env.UC_BETRIEB_MAX || 240),
  BETRIEB_SCHWELLE: +(process.env.UC_BETRIEB_SCHWELLE || 40),

  // Obergrenze für Auszahlungen und Gehälter je Tag
  AUSZAHLUNG_LIMIT: +(process.env.UC_AUSZAHLUNG_LIMIT || 35_000),
  // Wann der Topf zurückgesetzt wird. Das ist Mitternacht und damit etwas
  // anderes als der Spieltag, der um 04:00 wechselt – die beiden nicht
  // verwechseln, sonst zeigt der Befehl nachts einen falschen Stand.
  AUSZAHLUNG_RESET_STD: +(process.env.UC_AUSZAHLUNG_RESET_STD ?? 0),
  // Unbekannte Buchungen melden – aus, weil es vor allem Lärm war
  UNBEKANNTE_BUCHUNGEN: process.env.UC_UNBEKANNTE_BUCHUNGEN === '1',

  LUECKE_MIN:       +(process.env.UC_LUECKE_MIN || 10),
  TAGESWECHSEL_STD: +(process.env.UC_TAGESWECHSEL_STD || 4),

  INTERVALL_MS: +(process.env.UC_INTERVALL_MS || 60_000),
  STATE_FILE:   process.env.UC_STATE_FILE || path.join(process.cwd(), 'uc-watcher-state.json'),
  DEBUG:        process.env.UC_DEBUG === '1',
};

// Kassenbuch-Kategorien, die einen Vorfall darstellen (Groß/Klein egal).
// Vorfallsarten, die es im Spiel gibt. Nur als Starthilfe für die Auswahl in
// /melden – der Watcher ergänzt selbst, was ihm tatsächlich begegnet.
const VORFALL_BEKANNT = (process.env.UC_VORFALL_ARTEN ||
  'ABWERBUNG,RAZZIA,UEBERFALL,EINBRUCH,DIEBSTAHL,SABOTAGE,STEUERPRUEFUNG,LIEFERENGPASS')
  .split(',').map(a => a.trim().toUpperCase()).filter(Boolean);

const VORFALL_KATEGORIEN = [
  'steuerprüfung', 'steuerpruefung', 'razzia', 'überfall', 'ueberfall',
  'einbruch', 'diebstahl', 'strafe', 'bußgeld', 'bussgeld', 'sabotage',
];

// Was aus dem 35.000$-Topf für Auszahlungen und Gehälter genommen wird.
// Löhne stehen bewusst nicht dabei: das sind die NPC-Kosten der Firma, kein
// Geld, das sich ein Mitarbeiter auszahlt.
const AUSZAHLUNG_KATEGORIEN =
  (process.env.UC_AUSZAHLUNG_KATEGORIEN || 'auszahlung,gehalt')
    .split(',').map(w => w.trim().toLowerCase()).filter(Boolean);

// Bekannte, harmlose Kategorien – alles andere landet im Log.
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
  wiki: null,              // { id: {titel, kategorie, updatedAt, laenge} }
  wikiGeprueft: 0,
  notionGeprueft: 0,
  preise: null,            // letzte Einkaufspreise je Ware
  letzterLagerTick: 0,
  letzterLedgerStamp: 0,  // bis hierhin wurde das Kassenbuch verarbeitet
  auszahlungSumme: 0, auszahlungTag: null, auszahlungen: [],  // 35k-Topf je Spieltag
  betriebBestand: null,   // zuletzt gesehener Bestand der Zoohandlung
  letzterEinkauf: 0,      // belegt, dass der Nachkauf läuft
  offenerVorfall: null,   // { schluessel, seit, zuletzt, runde } fürs Nachfassen
  vorfallArten: {},       // gesehene Arten, für die Auswahl in /melden
  lagerVerlauf: [],       // { t, lager } für den gemessenen Absatz
  lastPush: {},
});

function load() {
  try { return Object.assign(leer(), JSON.parse(fs.readFileSync(CFG.STATE_FILE, 'utf8'))); }
  catch { return leer(); }
}
let zuletztGespeichert = '';
function save(s) {
  // Ein Ausfall läuft jede Minute durch diese Funktion, ohne dass sich etwas
  // ändert. Dann muss auch nichts auf die Platte.
  const inhalt = JSON.stringify(s, null, 2);
  if (inhalt === zuletztGespeichert) return;
  const tmp = CFG.STATE_FILE + '.tmp';
  // 0600: Die Datei enthält Cookie und Token – niemand sonst darf sie lesen.
  fs.writeFileSync(tmp, inhalt, { mode: 0o600 });
  fs.renameSync(tmp, CFG.STATE_FILE);        // atomar – übersteht Stromausfall
  zuletztGespeichert = inhalt;
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

// Texte aus dem Spiel enthalten Minecraft-Farbcodes: "§7" und Hex-Farben der
// Form "§x§F§F§E§1§A§8". Die müssen raus, bevor irgendetwas gelesen oder
// angezeigt wird – sonst verschmilzt die letzte Ziffer des Codes mit der
// folgenden Zahl ("§x…§8" + "92x" wird zu "892x").
const sauber = t => String(t ?? '').replace(/§./gu, '').replace(/\s+/g, ' ').trim();

/* ========================= API & ZUGANG ========================= */

// Zugang lebt im Zustand, damit er Neustarts übersteht.
const zugang = { token: null, exp: 0, cookie: null, geholtUm: 0 };

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

// 401/403 heißt: das Cookie taugt nicht mehr, da hilft nur ein neues. Alles
// andere (502, 503, 500 …) ist der Server von UnicaCity, der gerade hustet –
// das geht von selbst vorbei und ist kein Grund, den Zugang zu verdächtigen.
// Beide Fälle müssen überall gleich heißen, sonst wird wieder ein Ausfall für
// einen abgelaufenen Zugang gehalten.
function pruefeAntwort(res) {
  if (res.status === 401 || res.status === 403) throw new Error('AUTH');
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

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
  pruefeAntwort(res);

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
  zugang.geholtUm = Date.now();
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
    // Ein gerade erst geholter Token kann nicht abgelaufen sein – dann liegt es
    // am Pfad oder an fehlenden Rechten. Sonst würde jeder 404-artige Fehler
    // eine überflüssige Erneuerung auslösen.
    if (Date.now() - zugang.geholtUm < 60_000) {
      log('Abgewiesen trotz frischem Token:', pfad);
      throw new Error('AUTH');
    }
    log('Abgewiesen – Token wird erneuert und noch einmal versucht');
    zugang.exp = 0;
    return api(pfad, true);
  }
  pruefeAntwort(res);
  return res.json();
}

const holeFirma  = () => api('/api/panel/company');

// Mögliche Adressen der Betriebsübersicht. Welche es ist, zeigt
// --betrieb-probe; die erste, die antwortet, wird gemerkt.
// Aus dem Programmcode des Dashboards gelesen (--api-suche): mehr Panel-
// Adressen gibt es nicht. Eine eigene für Betriebe existiert nicht, die Daten
// stecken also in einer dieser Antworten.
const BETRIEB_PFADE = [
  '/api/panel/me', '/api/panel/company', '/api/panel/history', '/api/panel/referral',
];
let betriebPfad = process.env.UC_BETRIEB_PFAD || '';

async function holeBetriebe() {
  if (betriebPfad) return api(betriebPfad);
  let letzterFehler;
  for (const pfad of BETRIEB_PFADE) {
    try {
      const d = await api(pfad);
      betriebPfad = pfad;
      log('Betriebe kommen von', pfad);
      return d;
    } catch (e) {
      letzterFehler = e;
      // 401/403 heißt Zugangsproblem, nicht falscher Pfad – dann abbrechen.
      if (e.message === 'AUTH') throw e;
    }
  }
  throw new Error('BETRIEB_PFAD_UNBEKANNT' + (letzterFehler ? ` (${letzterFehler.message})` : ''));
}

/**
 * Sucht einen Betrieb am Namen, egal wie tief er in der Antwort steckt.
 * Die genaue Form der Antwort kennen wir nicht, deshalb wird gesucht statt
 * einen festen Pfad anzunehmen.
 */
function findeBetrieb(daten, name) {
  const ziel = schluessel(sauber(name));
  const id = CFG.BETRIEB_ID ? String(CFG.BETRIEB_ID) : '';
  if (!ziel && !id) return null;
  let treffer = null;
  const suche = (o, tiefe = 0) => {
    if (treffer || !o || tiefe > 8) return;
    if (Array.isArray(o)) { o.forEach(x => suche(x, tiefe + 1)); return; }
    if (typeof o !== 'object') return;
    // Die ID ist eindeutig, der Name kann sich ändern – deshalb zuerst.
    // In /api/panel/me heißt sie bizID.
    if (id && String(o.bizID ?? o.id ?? o.businessId ?? '') === id) { treffer = o; return; }
    if (!id) {
      const n = o.name ?? o.title ?? o.businessName ?? o.displayName;
      if (typeof n === 'string' && ziel && schluessel(sauber(n)).includes(ziel)) { treffer = o; return; }
    }
    for (const v of Object.values(o)) suche(v, tiefe + 1);
  };
  suche(daten);
  if (treffer) return treffer;

  // Eine gesetzte ID ist verbindlich: Wird sie nicht gefunden, ist das ein
  // Fehler in der Einstellung. Dann lieber nichts melden als den falschen
  // Betrieb, dessen Zahlen echt aussehen.
  if (id) return null;

  // Ohne ID: ein Betrieb wie die Werbung zeigt zwar einen Lagerwert an, hat
  // aber keines (hasLager: false). Bleibt genau einer mit echtem Lager übrig,
  // ist er gemeint.
  const mitLager = [];
  const sammle = (o, tiefe = 0) => {
    if (!o || tiefe > 8) return;
    if (Array.isArray(o)) { o.forEach(x => sammle(x, tiefe + 1)); return; }
    if (typeof o !== 'object') return;
    if (o.hasLager === true) mitLager.push(o);
    for (const v of Object.values(o)) sammle(v, tiefe + 1);
  };
  sammle(daten);
  return mitLager.length === 1 ? mitLager[0] : null;
}

// Felder, unter denen ein Bestand stecken kann – in dieser Reihenfolge.
// So heißen die Felder in /api/panel/me. Die übrigen Namen bleiben als
// Rückfallebene stehen, falls sich die API einmal ändert.
const BESTAND_FELDER = ['lager', 'stock', 'bestand', 'inventory', 'total', 'amount', 'quantity'];
const KAPAZITAET_FELDER = ['lagerMax', 'capacity', 'max', 'maxStock', 'maximum', 'limit'];

const ersteZahl = (o, felder) => {
  for (const k of felder) if (typeof o?.[k] === 'number') return o[k];
  return null;
};

/** Liest Bestand und Kapazität aus einem Betrieb heraus. */
function betriebBestand(betrieb) {
  if (!betrieb) return null;
  const direkt = ersteZahl(betrieb, BESTAND_FELDER);
  if (direkt !== null) {
    return { roh: direkt, kapazitaet: ersteZahl(betrieb, KAPAZITAET_FELDER) };
  }
  // Verschachtelt, etwa { stock: { total: 340, capacity: 400 } }
  for (const k of BESTAND_FELDER) {
    const v = betrieb[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const zahl = ersteZahl(v, BESTAND_FELDER);
      if (zahl !== null) return { roh: zahl, kapazitaet: ersteZahl(v, KAPAZITAET_FELDER) };
    }
  }
  return null;
}

/**
 * Bestand des beobachteten Betriebs, bereits um den Sockel bereinigt.
 * Der Abzug ist das, was im Betrieb steht, aber nicht entnommen werden kann.
 */
function betriebStand(daten) {
  const b = findeBetrieb(daten, CFG.BETRIEB);
  if (!b) return { gefunden: false };
  const roh = betriebBestand(b);
  if (!roh) return { gefunden: true, bestand: null, name: sauber(b.name || b.title || CFG.BETRIEB) };

  // Wir lesen immer den Bestand eines einzelnen Betriebs, nie eine Summe –
  // der Wert stimmt also schon. Abgezogen wird nur, wenn es jemand
  // ausdrücklich einstellt.
  const abzug = CFG.BETRIEB_ID ? 0 : CFG.BETRIEB_ABZUG;
  const verfuegbar = Math.max(0, roh.roh - abzug);
  const max = roh.kapazitaet ? Math.max(0, roh.kapazitaet - abzug) : CFG.BETRIEB_MAX;
  // Heißt der Betrieb in der API nur "Business #35", ist der eingestellte
  // Name (Zoohandlung) für Menschen die bessere Auskunft.
  const apiName = sauber(b.name || b.title || '');
  const anzeige = !apiName || /^business\s*#?\d+$/i.test(apiName) ? CFG.BETRIEB : apiName;

  return {
    gefunden: true,
    name: anzeige,
    angezeigt: roh.roh,
    bestand: verfuegbar,
    max,
    anteil: max ? Math.round(verfuegbar / max * 100) : 0,
  };
}
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

/**
 * Wer ist gerade in UnicaCity online und hat ein zugeordnetes Discord-Konto?
 *
 * Grundlage sind die Spielerdaten, die der Watcher ohnehin je Durchlauf
 * fortschreibt. Namen werden ohne Rücksicht auf Groß- und Kleinschreibung
 * verglichen, weil die Zuordnung von Hand eingetippt wird.
 */
function onlineDiscordIds(state) {
  const online = new Set(Object.entries(state.spieler || {})
    .filter(([, p]) => p.online)
    .map(([name]) => name.toLowerCase()));
  if (!online.size) return [];
  return Object.entries(ladeZuordnung())
    .filter(([, ucName]) => online.has(String(ucName).toLowerCase()))
    .map(([discordId]) => discordId);
}

/**
 * Schickt eine Meldung raus: an ntfy (dein Handy) und, falls eingerichtet,
 * an Discord.
 *
 * extra.teamText / extra.teamTitel: entschärfte Fassung für den Team-Kanal,
 * ohne Geldbeträge und ohne Namenslisten. Fehlt sie bei einem Team-Thema,
 * bekommt das Team denselben Text.
 */
async function push(thema, titel, text, state, prio = 'high', extra = {}) {
  const regel = extra.ziel ? { ziel: extra.ziel } : empfaenger(thema, ladeRegeln());

  // "Gar nicht" heißt gar nicht: auch kein ntfy aufs Handy. Sonst wäre die
  // Einstellung eine Halbwahrheit.
  if (regel.ziel === 'aus') return log('Abgeschaltet:', thema);

  // Wie lange dieselbe Meldung Ruhe gibt, ist je Thema über /melden
  // einstellbar – sonst gilt die allgemeine Vorgabe.
  const ruhe = (regel.wiederholung ?? CFG.ERINNERUNG_MIN) * MIN;
  const now = Date.now();
  if (now - (state.lastPush[thema] || 0) < ruhe) return log('Cooldown:', thema);
  state.lastPush[thema] = now;

  info('PUSH:', titel);
  log(text);
  await discordSende({ ...regel, titel, text, prio,
                       pingNutzer: regel.ping === 'online' ? onlineDiscordIds(state) : undefined,
                       teamTitel: extra.teamTitel, teamText: extra.teamText });

  if (!CFG.NTFY_TOPIC) return log('  (kein UC_NTFY_TOPIC gesetzt – nur Discord)');

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

/**
 * Der Tag, auf den sich der Auszahlungstopf bezieht. Nicht der Spieltag:
 * der beginnt um 04:00, der Topf aber um Mitternacht.
 */
function budgetTag(d = new Date()) {
  const verschoben = new Date(d.getTime() - CFG.AUSZAHLUNG_RESET_STD * 3_600_000);
  return `${verschoben.getFullYear()}-` +
    `${String(verschoben.getMonth() + 1).padStart(2, '0')}-` +
    `${String(verschoben.getDate()).padStart(2, '0')}`;
}

/**
 * Stand des Topfes für Auszahlungen und Gehälter. Setzt um Mitternacht
 * zurück (einstellbar über UC_AUSZAHLUNG_RESET_STD).
 */
function auszahlungTopf(state) {
  const heute = budgetTag();
  if (state.auszahlungTag !== heute) {
    state.auszahlungTag = heute;
    state.auszahlungSumme = 0;
    state.auszahlungen = [];
  }
  const genutzt = state.auszahlungSumme || 0;
  return {
    tag: heute,
    genutzt,
    limit: CFG.AUSZAHLUNG_LIMIT,
    frei: Math.max(0, CFG.AUSZAHLUNG_LIMIT - genutzt),
    buchungen: state.auszahlungen || [],
  };
}

/**
 * Tatsächlicher Absatz, aus dem eigenen Verlauf gemessen.
 *
 * salesPerMinute aus der API ist eine Momentangröße und trifft nicht zu:
 * Verkauft wird schubweise, alle paar Minuten. Wer damit hochrechnet, bekommt
 * eine Reichweite, die um ein Vielfaches danebenliegt. Deshalb zählen wir
 * selbst, wie viel über die Zeit wirklich abfließt.
 *
 * Gezählt werden nur Rückgänge; eine Lieferung füllt auf und ist kein Absatz.
 */
const VERLAUF_MAX = 180;                 // Stützstellen, bei 60 s Takt = 3 Std.

function merkeLager(state, lager) {
  if (typeof lager !== 'number') return;
  state.lagerVerlauf = [...(state.lagerVerlauf || []), { t: Date.now(), lager }]
    .slice(-VERLAUF_MAX);
}

function gemessenerAbsatz(state, minutenFenster = 60) {
  const verlauf = (state.lagerVerlauf || []).filter(
    x => Date.now() - x.t <= minutenFenster * MIN);
  if (verlauf.length < 3) return null;

  const spanne = verlauf[verlauf.length - 1].t - verlauf[0].t;
  if (spanne < 10 * MIN) return null;    // zu kurz für eine belastbare Aussage

  let abgeflossen = 0, schuebe = 0, groessterSchub = 0;
  for (let i = 1; i < verlauf.length; i++) {
    const delta = verlauf[i - 1].lager - verlauf[i].lager;
    if (delta > 0) {
      abgeflossen += delta; schuebe++;
      if (delta > groessterSchub) groessterSchub = delta;
    }
  }
  if (!abgeflossen) {
    return { proMinute: 0, abgeflossen: 0, schuebe: 0, groessterSchub: 0, minuten: spanne / MIN };
  }

  return {
    proMinute: abgeflossen / (spanne / MIN),
    abgeflossen,
    schuebe,
    groessterSchub,
    minuten: spanne / MIN,
  };
}

// Namen, unter denen ein Schalter für den Nachkauf stehen könnte. Ob die API
// so einen liefert, ist offen – deshalb wird zusätzlich an den Buchungen
// abgelesen, und die haben Vorrang, wenn es kein Feld gibt.
const NACHKAUF_FELDER = ['autoBuy', 'autoRestock', 'restock', 'autoPurchase',
                         'buyEnabled', 'nachkauf', 'autoRefill', 'autoBuyEnabled'];

/**
 * Läuft der automatische Nachkauf?
 *
 * Solange er läuft, füllt sich das Lager selbst – eine Reichweite wäre dann
 * eine Zahl ohne Bedeutung. Erkannt wird er an einem ausdrücklichen Feld,
 * sonst daran, dass das System vor Kurzem eingekauft hat.
 */
function nachkaufStand(f, state) {
  for (const k of NACHKAUF_FELDER) {
    if (typeof f?.[k] === 'boolean') return { an: f[k], quelle: 'Anzeige' };
    if (typeof f?.stock?.[k] === 'boolean') return { an: f.stock[k], quelle: 'Anzeige' };
  }
  if (state.letzterEinkauf) {
    const her = Date.now() - state.letzterEinkauf;
    return { an: her <= CFG.NACHKAUF_FENSTER_MIN * MIN, quelle: 'Einkäufe', her };
  }
  return { an: null, quelle: 'unbekannt' };
}

/** Wie lange der Bestand bei gemessenem Absatz noch reicht – oder null. */
function reichweite(state, bestand) {
  const a = gemessenerAbsatz(state);
  if (!a || !a.proMinute) return null;
  return { ms: bestand / a.proMinute * MIN, ...a };
}

/**
 * Beschreibt den Absatz für eine Meldung: gemessen, wenn genug Verlauf da ist,
 * sonst ehrlich als unbekannt. Die Angabe der API wird nicht hochgerechnet.
 */
function absatzText(state, f) {
  const lager = f.stock?.total ?? 0;
  const r = reichweite(state, lager);
  if (r) {
    return `${r.proMinute.toFixed(1)}/Min gemessen über ${Math.round(r.minuten)} Min ` +
      `– reicht noch ${dauer(r.ms)}.`;
  }
  const a = gemessenerAbsatz(state);
  if (a && a.proMinute === 0) return 'In der letzten Stunde ging nichts raus.';
  return `noch nicht gemessen (API meldet ${f.stock?.salesPerMinute ?? '?'}/Min, ` +
    'was schubweise verkauft wird und sich nicht hochrechnen lässt).';
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
    Gewinn: state.gewinn === null ? '–' : fmt(state.gewinn),
  };
}

/**
 * Meldet, wenn im beobachteten Betrieb nichts mehr zu holen ist. Die Meldung
 * geht ans ganze Team – wer gerade spielt, kann nachfüllen.
 */
async function pruefeBetrieb(state) {
  if (!CFG.BETRIEB) return;
  let stand;
  try {
    stand = betriebStand(await betriebeFrisch());
  } catch (e) {
    // Die Betriebe sind Beiwerk: schlägt der Abruf fehl, stört das den Rest
    // der Überwachung nicht.
    log('Betrieb nicht abrufbar:', e.message);
    return;
  }
  if (!stand.gefunden || stand.bestand === null) return;

  state.betriebBestand = stand.bestand;

  if (stand.bestand <= 0) {
    await push('betrieb_leer', `🔴 ${stand.name} ist leer`,
      `Im ${stand.name} ist nichts mehr zu holen.\n` +
      'Wer gerade spielt, kann nachfüllen.', state, 'high');
    return;
  }

  if (stand.bestand <= CFG.BETRIEB_SCHWELLE) {
    await push('betrieb_knapp', `⚠️ ${stand.name} wird knapp`,
      `Noch ${stand.bestand} von ${stand.max}.\nNachfüllen, bevor nichts mehr da ist.`,
      state, 'default');
  } else {
    // Wieder aufgefüllt: die Sperre lösen, damit die nächste Warnung kommt.
    state.lastPush.betrieb_knapp = 0;
    state.lastPush.betrieb_leer = 0;
  }
}

/**
 * Fasst nach, solange ein Vorfall offen ist.
 *
 * Ein Vorfall hat eine Frist – bei einer Abwerbung etwa zehn Minuten. Die
 * erste Meldung geht unter, wenn gerade niemand hinsieht; deshalb kommt nach
 * einer einstellbaren Zeit eine zweite, mit der verbleibenden Frist.
 *
 * Jede Erinnerung bekommt ein eigenes Thema, sonst würde die Sperre gegen
 * Wiederholungen sie verschlucken.
 */
async function erinnereAnVorfall(state, ereignis) {
  const schluessel = vorfallSchluessel(ereignis);
  const offen = state.offenerVorfall;

  // Ein anderer Vorfall als zuletzt: von vorn zählen.
  if (!offen || offen.schluessel !== schluessel) {
    state.offenerVorfall = { schluessel, seit: Date.now(), zuletzt: Date.now(), runde: 0 };
    return;
  }

  const regel = empfaenger(schluessel, ladeRegeln());
  const abstand = regel.erinnerung ?? CFG.VORFALL_ERINNERUNG_MIN;
  if (!abstand || offen.runde >= CFG.VORFALL_ERINNERUNG_MAX) return;
  if (Date.now() - offen.zuletzt < abstand * MIN) return;

  offen.runde++;
  offen.zuletzt = Date.now();

  const minuten = ereignis?.minutesLeft ?? ereignis?.minutes;
  const frist = minuten !== null && minuten !== undefined
    ? `\n⏳ Noch ${minuten} ${minuten === 1 ? 'Minute' : 'Minuten'} Zeit.`
    : '';

  await push(`${schluessel}_nachfass_${offen.runde}`,
    '⏰ Vorfall ist immer noch offen',
    ereignisText(ereignis) + frist +
    `\n\nOffen seit ${dauer(Date.now() - offen.seit)}.`,
    state, 'urgent');
}

async function pruefeAusschuettung(state) {
  const ziel = CFG.AUSSCHUETTUNG_STD * 3_600_000;

  // Wie oft der Zwischenstand kommt, ist über /melden einstellbar: 1 = jede
  // Stunde, 3 = alle drei, 0 = gar nicht (nur die fertige Ausschüttung).
  const takt = ladeRegeln()['ausschuettung_std_']?.takt
    ?? (CFG.AUSSCHUETTUNG_STUNDENMELDUNG ? 1 : 0);

  const stunden = Math.floor(state.teamOnlineMs / 3_600_000);
  if (takt > 0 && stunden % takt === 0
      && stunden > (state.gemeldeteStunde || 0) && stunden < CFG.AUSSCHUETTUNG_STD) {
    state.gemeldeteStunde = stunden;
    const wer = Object.entries(state.spieler).filter(([, p]) => p.online).map(([n]) => n);
    await push(`ausschuettung_std_${stunden}`,
      `⏱️ ${stunden} von ${CFG.AUSSCHUETTUNG_STD} Std. bis zur Ausschüttung`,
      `Team-Onlinezeit: ${dauer(state.teamOnlineMs)}\n` +
      `Noch ${dauer(ziel - state.teamOnlineMs)} bis zur nächsten Ausschüttung.` +
      (state.gewinn !== null ? `\nGewinn bisher: ${fmt(state.gewinn)}` : '') +
      (wer.length ? `\n\nGerade online: ${wer.join(', ')}` : ''),
      state, 'low', {
        // Das Team sieht den Fortschritt, aber keine Beträge.
        teamText:
          `Team-Onlinezeit: ${dauer(state.teamOnlineMs)}\n` +
          `Noch ${dauer(ziel - state.teamOnlineMs)} bis zur nächsten Ausschüttung.` +
          (wer.length ? `\n\nGerade online: ${wer.join(', ')}` : ''),
      });
  }

  if (state.teamOnlineMs >= ziel && !state.faelligGemeldet) {
    state.faelligGemeldet = true;
    await push('ausschuettung_faellig', '💰 Ausschüttung ist fällig',
      `${CFG.AUSSCHUETTUNG_STD} Std. Team-Onlinezeit erreicht (${dauer(state.teamOnlineMs)}).` +
      (state.gewinn !== null ? `\nAktueller Gewinn: ${fmt(state.gewinn)}` : ''),
      state, 'high', {
        teamText: `${CFG.AUSSCHUETTUNG_STD} Std. Team-Onlinezeit erreicht ` +
          `(${dauer(state.teamOnlineMs)}). Die Ausschüttung kann gemacht werden.`,
      });
  }
}

/* ========================= VORFÄLLE ========================= */

// Das Ereignis der Firma lesbar machen, ohne seinen Aufbau zu kennen.
// Felder, die das Spiel mitschickt, die aber niemand lesen will: technische
// Kennungen und Flaggen. Der Rest wird benannt statt roh ausgegeben.
const EREIGNIS_EGAL = ['type', 'interactive', 'id', 'eventid', 'key'];

/**
 * Themenschlüssel eines Vorfalls, mit der Art im Namen: 'event_ABWERBUNG_…'.
 *
 * So lässt sich über /melden je Art einstellen, was passieren soll – der
 * Vergleich nach längstem Anfang lässt 'event_ABWERBUNG' die allgemeine Regel
 * 'event_' schlagen. Der angehängte Teil unterscheidet zwei Vorfälle
 * derselben Art voneinander, damit der zweite nicht als Wiederholung des
 * ersten gilt.
 */
function vorfallArt(ev) {
  const roh = sauber(ev?.type ?? ev?.name ?? ev?.title ?? '') || 'UNBEKANNT';
  return roh.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
}

function vorfallSchluessel(ev) {
  // Kurze Quersumme über das ganze Ereignis statt der ersten Zeichen: zwei
  // Abwerbungen unterscheiden sich erst in der Beschreibung, und ein
  // abgeschnittener Anfang hätte die zweite als Wiederholung der ersten
  // gelten lassen – sie wäre nie gemeldet worden.
  const roh = JSON.stringify(ev) || '';
  let summe = 0;
  for (let i = 0; i < roh.length; i++) summe = (summe * 31 + roh.charCodeAt(i)) >>> 0;
  return `event_${vorfallArt(ev)}_${summe.toString(36)}`;
}

function ereignisText(ev) {
  if (!ev) return '';
  if (typeof ev === 'string') return sauber(ev);

  const teile = [];
  const name = sauber(ev.name || ev.title || '');
  const text = sauber(ev.description || ev.text || '');
  if (name) teile.push(`**${name}**`);
  if (text) teile.push(text);

  // Die Frist ist das Wichtigste am Vorfall – sie kommt ans Ende, gut sichtbar.
  const minuten = ev.minutesLeft ?? ev.minutes ?? null;
  if (minuten !== null && minuten !== undefined) {
    teile.push(`⏳ Noch ${minuten} ${minuten === 1 ? 'Minute' : 'Minuten'} Zeit`);
  }

  // Alles, was das Spiel sonst noch mitschickt, geht nicht verloren – aber
  // erst nach dem, was man wirklich liest.
  const rest = [];
  for (const [k, v] of Object.entries(ev)) {
    if (v === null || typeof v === 'object') continue;
    if (EREIGNIS_EGAL.includes(k.toLowerCase())) continue;
    if (['name', 'title', 'description', 'text', 'minutesleft', 'minutes'].includes(k.toLowerCase())) continue;
    let wert = v;
    if (/ms$/i.test(k) && typeof v === 'number' && v > 1000) wert = dauer(v);
    else if (/(endsAt|expires|until|bis)/i.test(k) && typeof v === 'number' && v > 1e12)
      wert = new Date(v).toLocaleTimeString('de-DE');
    rest.push(`${k}: ${typeof wert === 'string' ? sauber(wert) : wert}`);
  }
  if (rest.length) teile.push(rest.join('\n'));

  return teile.join('\n\n');
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

/* ========================= WIKI ========================= */

// Kategorien und Artikel sind öffentlich – hier braucht es keinen Zugang.
async function holeWiki() {
  const res = await fetch(CFG.API + '/api/wiki/categories',
    { headers: { 'User-Agent': CFG.USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error('WIKI ' + res.status);
  const { categories = [] } = await res.json();

  const artikel = {};
  for (const k of categories) {
    const r = await fetch(`${CFG.API}/api/wiki/categories/${k.slug}/articles`,
      { headers: { 'User-Agent': CFG.USER_AGENT, Accept: 'application/json' } });
    if (!r.ok) { log('Wiki-Kategorie nicht lesbar:', k.slug, r.status); continue; }
    const { articles = [] } = await r.json();
    for (const a of articles) {
      artikel[a.id] = {
        titel: a.title,
        kategorie: k.name,
        slug: k.slug,
        updatedAt: a.updatedAt,
        laenge: (a.content || '').length,
      };
    }
  }
  return artikel;
}

const wikiLink = a => `https://unicacity.eu/wiki/${a.slug}/${a.id ?? ''}`;

// Gibt zurück, ob sich am Wiki etwas geändert hat.
async function pruefeWiki(state) {
  if (!CFG.WIKI) return false;
  const faellig = Date.now() - (state.wikiGeprueft || 0) >= CFG.WIKI_INTERVALL_STD * 3_600_000;
  if (!faellig) return false;

  let jetzt;
  try { jetzt = await holeWiki(); }
  catch (e) { log('Wiki nicht abrufbar:', e.message); return false; }

  const anzahl = Object.keys(jetzt).length;
  if (!anzahl) { log('Wiki lieferte keine Artikel – Prüfung übersprungen'); return false; }

  state.wikiGeprueft = Date.now();
  const vorher = state.wiki;
  state.wiki = jetzt;

  if (!vorher) {                       // erster Lauf: nur Stand merken
    info(`Wiki-Ausgangsstand gespeichert: ${anzahl} Artikel`);
    return false;
  }

  const neu = [], geaendert = [], entfernt = [];
  for (const [id, a] of Object.entries(jetzt)) {
    const v = vorher[id];
    if (!v) neu.push({ id, ...a });
    else if (v.updatedAt !== a.updatedAt || v.laenge !== a.laenge)
      geaendert.push({ id, ...a, vorherLaenge: v.laenge });
  }
  for (const [id, v] of Object.entries(vorher)) if (!jetzt[id]) entfernt.push({ id, ...v });

  if (!neu.length && !geaendert.length && !entfernt.length) {
    log(`Wiki unverändert (${anzahl} Artikel)`);
    return false;
  }

  const teile = [];
  if (neu.length) teile.push(`${neu.length} neu`);
  if (geaendert.length) teile.push(`${geaendert.length} geändert`);
  if (entfernt.length) teile.push(`${entfernt.length} entfernt`);

  const block = (titel, liste, mitDelta) => !liste.length ? '' :
    `\n\n${titel}\n` + liste.slice(0, 15).map(a => {
      // "(0 Zeichen)" wäre irreführend – dann wurde nur der Zeitstempel berührt
      const delta = mitDelta && a.vorherLaenge !== undefined && a.laenge !== a.vorherLaenge
        ? ` (${a.laenge > a.vorherLaenge ? '+' : ''}${a.laenge - a.vorherLaenge} Zeichen)` : '';
      return `• ${a.kategorie} · ${a.titel}${delta}\n  ${wikiLink(a)}`;
    }).join('\n') + (liste.length > 15 ? `\n… und ${liste.length - 15} weitere` : '');

  await push(`wiki_${new Date().toISOString().slice(0, 10)}`,
    `📚 Wiki: ${teile.join(', ')}`,
    `Stand: ${anzahl} Artikel in ${new Set(Object.values(jetzt).map(a => a.kategorie)).size} Kategorien` +
    block('🆕 Neu', neu) +
    block('✏️ Geändert', geaendert, true) +
    block('🗑️ Entfernt', entfernt),
    state, 'default');

  return true;      // löst den Notion-Abgleich sofort aus
}

/* ==================== NOTION-ABGLEICH ==================== */

const NOTION_VERSION = '2022-06-28';

// Notion akzeptiert die ID mit Bindestrichen zuverlässiger
const mitStrichen = id => {
  const r = String(id).replace(/-/g, '');
  return r.length === 32
    ? `${r.slice(0,8)}-${r.slice(8,12)}-${r.slice(12,16)}-${r.slice(16,20)}-${r.slice(20)}`
    : id;
};

async function notion(pfad) {
  const res = await fetch('https://api.notion.com/v1' + pfad, {
    headers: {
      Authorization: 'Bearer ' + CFG.NOTION_TOKEN,
      'Notion-Version': NOTION_VERSION,
      'Accept': 'application/json',
    },
  });
  if (res.status === 401) throw new Error('NOTION_TOKEN');
  if (res.status === 404) throw new Error('NOTION_FREIGABE');   // nicht freigegeben
  if (!res.ok) throw new Error('NOTION ' + res.status);
  return res.json();
}

// Titel vergleichbar machen: Groß/Klein, Mehrfach-Leerzeichen, Bindestrich-Arten
const schluessel = t => String(t).toLowerCase()
  .replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/[·•]/g, '').trim();

// Unterseiten einer Notion-Seite, mit Bearbeitungszeitpunkt
async function notionUnterseiten(seiteId) {
  const raus = [];
  let cursor = null;
  do {
    const d = await notion(`/blocks/${mitStrichen(seiteId)}/children?page_size=100` +
      (cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''));
    for (const b of d.results || []) {
      if (b.type === 'child_page') {
        raus.push({ id: b.id, titel: b.child_page.title, bearbeitet: b.last_edited_time });
      }
    }
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return raus;
}

// Der gesamte Text einer Notion-Seite. Die Artikel stehen dort als
// Überschriften innerhalb der Kategorieseite, nicht als Unterseiten –
// deshalb reicht es nicht, nur die Unterseiten zu betrachten.
async function notionSeitentext(seiteId, tiefe = 0) {
  if (tiefe > 2) return '';
  let text = '';
  let cursor = null;
  do {
    const d = await notion(`/blocks/${mitStrichen(seiteId)}/children?page_size=100` +
      (cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''));
    for (const b of d.results || []) {
      const inhalt = b[b.type];
      if (inhalt && Array.isArray(inhalt.rich_text)) {
        text += inhalt.rich_text.map(t => t.plain_text || '').join('') + '\n';
      }
      if (b.type === 'child_page') text += b.child_page.title + '\n';
      // Verschachteltes (Toggles, Spalten) mitnehmen
      if (b.has_children && b.type !== 'child_page') {
        text += await notionSeitentext(b.id, tiefe + 1);
      }
    }
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return text;
}

// Steht der Artikeltitel im Text? Mit Wortgrenzen, damit "Farm" nicht in
// "Farmer" gefunden wird.
function titelImText(titel, text) {
  const t = schluessel(titel);
  if (!t) return false;
  const muster = new RegExp(`(^|[^a-z0-9äöüß])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9äöüß]|$)`);
  return muster.test(text);
}

async function vergleicheNotion(state, wikiArtikel) {
  const kategorienNotion = await notionUnterseiten(CFG.NOTION_WIKI);
  const nachName = new Map(kategorienNotion.map(k => [schluessel(k.titel), k]));

  const wikiNachKat = new Map();
  for (const [id, a] of Object.entries(wikiArtikel)) {
    if (!wikiNachKat.has(a.kategorie)) wikiNachKat.set(a.kategorie, []);
    wikiNachKat.get(a.kategorie).push({ id, ...a });
  }

  const fehlen = [], veraltet = [], katFehlen = [];

  for (const [kategorie, artikel] of wikiNachKat) {
    const nk = nachName.get(schluessel(kategorie));
    if (!nk) { katFehlen.push(kategorie); continue; }

    // Hat die Kategorie Unterseiten je Artikel, ist deren Bearbeitungsstand
    // die genaue Quelle. Sonst behelfen wir uns mit dem Text der Seite und
    // ihrem Gesamtstand – dann ist die Aussage gröber.
    const unterseiten = await notionUnterseiten(nk.id);
    // Eine Unterseite darf einen erklärenden Zusatz im Titel tragen, etwa
    // "test (zweite Fassung Calderón Kartell)" für den Wiki-Artikel "test".
    // Deshalb steht sie zusätzlich unter ihrem Titel ohne den geklammerten
    // Zusatz im Verzeichnis. Der Zusatz muss geklammert am Ende stehen, damit
    // "Farm" nicht plötzlich "Farmer (Nebenjob)" trifft. Die genauen Titel
    // kommen zuletzt hinein und haben damit Vorrang.
    const nachTitel = new Map();
    for (const u of unterseiten) {
      const k = schluessel(u.titel);
      const basis = k.replace(/\s*\([^()]*\)$/, '');
      if (basis && basis !== k && !nachTitel.has(basis)) nachTitel.set(basis, u);
    }
    for (const u of unterseiten) nachTitel.set(schluessel(u.titel), u);
    const text = unterseiten.length ? '' : schluessel(await notionSeitentext(nk.id));

    for (const a of artikel) {
      const seite = nachTitel.get(schluessel(a.titel));
      const gefunden = seite || (text && titelImText(a.titel, text));
      if (!gefunden) { fehlen.push(a); continue; }

      const stand = seite ? seite.bearbeitet : nk.bearbeitet;
      if (new Date(a.updatedAt) > new Date(stand)) {
        veraltet.push({ ...a, notionStand: stand, genau: !!seite });
      }
    }
  }

  return { fehlen, veraltet, ueberzaehlig: [], katFehlen,
           kategorienNotion: kategorienNotion.length };
}

async function pruefeNotion(state, wikiArtikel, sofort = false) {
  if (!CFG.NOTION_TOKEN) return;
  // Nach einer Wiki-Änderung sofort, sonst im eingestellten Takt.
  const faellig = sofort ||
    Date.now() - (state.notionGeprueft || 0) >= CFG.NOTION_INTERVALL_STD * 3_600_000;
  if (!faellig) return;
  if (!wikiArtikel || !Object.keys(wikiArtikel).length) return;

  let e;
  try { e = await vergleicheNotion(state, wikiArtikel); }
  catch (err) {
    if (err.message === 'NOTION_TOKEN' || err.message === 'NOTION_FREIGABE') {
      await push('notion_zugang', '🔑 Notion nicht erreichbar',
        err.message === 'NOTION_TOKEN'
          ? 'Der Notion-Zugangsschlüssel wird abgelehnt. UC_NOTION_TOKEN prüfen.'
          : 'Die Wiki-Seite ist für die Integration nicht freigegeben.\n' +
            'In Notion: Seite öffnen → ••• → Verbindungen → Integration hinzufügen.',
        state, 'high');
    } else log('Notion-Abgleich fehlgeschlagen:', err.message);
    return;
  }

  state.notionGeprueft = Date.now();

  if (!e.fehlen.length && !e.veraltet.length && !e.katFehlen.length) {
    return log('Notion ist auf dem Stand des Wikis');
  }

  const liste = (titel, eintraege, zeile) => !eintraege.length ? '' :
    `\n\n${titel} (${eintraege.length})\n` +
    eintraege.slice(0, 12).map(zeile).join('\n') +
    (eintraege.length > 12 ? `\n… und ${eintraege.length - 12} weitere` : '');

  const teile = [];
  if (e.fehlen.length) teile.push(`${e.fehlen.length} fehlen`);
  if (e.veraltet.length) teile.push(`${e.veraltet.length} veraltet`);


  await push(`notion_${new Date().toISOString().slice(0, 10)}`,
    `📋 Notion-Abgleich: ${teile.join(', ') || 'Unterschiede'}`,
    `Wiki: ${Object.keys(wikiArtikel).length} Artikel · Notion: ${e.kategorienNotion} Kategorien` +
    liste('🆕 Fehlen in Notion', e.fehlen,
      a => `• ${a.kategorie} · ${a.titel}\n  ${wikiLink(a)}`) +
    liste('⏰ Veraltet (Wiki ist neuer)', e.veraltet,
      a => `• ${a.kategorie} · ${a.titel}\n  Wiki ${a.updatedAt.slice(0, 10)}, ` +
           `Notion ${String(a.notionStand).slice(0, 10)}${a.genau ? '' : ' (Kategoriestand)'}`) +

    (e.katFehlen.length ? `\n\n📁 Kategorien fehlen in Notion:\n• ${e.katFehlen.join('\n• ')}` : ''),
    state, 'default');
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
    const treffer = /(\d+)\s*x/i.exec(sauber(e.detail));
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
    const kat = sauber(b.category).toLowerCase();
    const detail = sauber(b.detail);

    // Ausschüttung: Zähler exakt zurücksetzen
    if (kat.includes('ausschütt') || kat.includes('ausschuett')) {
      state.letzteAusschuettung = b.stamp;
      state.teamOnlineMs = 0;
      state.gemeldeteStunde = 0;
      state.faelligGemeldet = false;
      state.lastPush.ausschuettung_faellig = 0;
      await push(`ausschuettung_${b.stamp}`, '💰 Ausschüttung erfolgt',
        `Betrag: ${fmt(Math.abs(b.amount))}\n${detail}\n` +
        `Zähler läuft neu: 0 von ${CFG.AUSSCHUETTUNG_STD} Std. Team-Onlinezeit.`,
        state, 'default');
      continue;
    }

    // Eindeutige Vorfälle
    if (VORFALL_KATEGORIEN.some(w => kat.includes(w))) {
      const bericht = onlineBericht(state);
      await push(`vorfall_${b.stamp}`, `🚨 ${sauber(b.category)}`,
        `${detail}\nBetrag: ${fmt(b.amount)}\nKassenstand danach: ${fmt(b.balance)}` +
        (bericht.length ? `\n\nOnline zu dem Zeitpunkt:\n${bericht.join('\n')}` : ''),
        state, 'urgent', {
          // Falls diese Meldung in einen geteilten Kanal gestellt wird: der
          // Vorfall und der Betrag dürfen dort stehen, der Kassenstand der
          // Firma und die Namensliste nicht.
          teamText: `${detail}\nBetrag: ${fmt(b.amount)}`,
        });
      continue;
    }

    // Ein Einkauf des Systems belegt, dass der Nachkauf läuft.
    if (kat.includes('einkauf')) {
      state.letzterEinkauf = b.stamp;
      log('Einkauf gesehen:', fmt(b.amount));
    }

    // Gehälter und Auszahlungen zehren am 35k-Topf – mitzählen, solange die
    // Buchung vorbeikommt. Das Kassenbuch liefert nur die letzten Einträge,
    // deshalb wird summiert statt später nachgerechnet.
    if (AUSZAHLUNG_KATEGORIEN.some(w => kat.includes(w))) {
      auszahlungTopf(state);                    // setzt bei Tageswechsel zurück
      state.auszahlungSumme = (state.auszahlungSumme || 0) + Math.abs(b.amount);
      state.auszahlungen = [...(state.auszahlungen || []),
        { stamp: b.stamp, kategorie: sauber(b.category), detail, betrag: Math.abs(b.amount) }
      ].slice(-20);
      log('Auszahlung gezählt:', sauber(b.category), fmt(Math.abs(b.amount)));
      continue;
    }

    // Unbekannte Kategorien landen nur im Log. Als Meldung waren sie vor allem
    // Lärm – sie treten häufig auf und es gibt nie etwas zu tun.
    if (!NORMALE_KATEGORIEN.some(w => kat.includes(w))) {
      log('Unbekannte Buchung:', sauber(b.category), fmt(b.amount), detail);
      if (CFG.UNBEKANNTE_BUCHUNGEN) {
        await push(`unbekannt_${kat}`, `❔ Unbekannte Buchung: ${sauber(b.category)}`,
          `${detail}\nBetrag: ${fmt(b.amount)}\nKassenstand danach: ${fmt(b.balance)}\n` +
          '\nDiese Kategorie kennt der Watcher noch nicht.', state, 'default');
      }
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
    if (e.message === 'AUTH' || e.message === 'KEIN_COOKIE') {
      await push('auth', '🔑 UnicaCity: Zugang abgelaufen',
        'Der Watcher kommt nicht mehr an die API – das Cookie ist vermutlich abgelaufen.\n' +
        'Neues Cookie aus dem Browser holen und in die .env eintragen, dann:\n' +
        'sudo systemctl restart uc-watcher', state, 'urgent');
    } else {
      // Server nicht erreichbar oder Netz weg. Das repariert sich meistens von
      // selbst, also erst melden, wenn es wirklich länger anhält – und ohne
      // Handlungsaufforderung, denn es gibt nichts zu tun.
      state.apiWegSeit ||= Date.now();
      const weg = Date.now() - state.apiWegSeit;
      log('Abruf fehlgeschlagen:', e.message, `(seit ${dauer(weg)})`);
      if (weg >= CFG.API_WEG_MELDUNG_MIN * MIN) {
        await push('apiweg', '📡 UnicaCity nicht erreichbar',
          `Der Watcher erreicht die Seite seit ${dauer(weg)} nicht (${e.message}).\n` +
          'Das ist meist der Server selbst und geht von allein vorbei – ' +
          'du musst nichts tun. Sobald es wieder läuft, bleibt es still.',
          state, 'default');
      }
    }
    sichereZugang(state);
    save(state);
    return;
  }

  if (state.apiWegSeit) {
    info(`Wieder erreichbar nach ${dauer(Date.now() - state.apiWegSeit)}`);
    state.apiWegSeit = 0;
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
      `Status: ${sauber(f.status)}\n` +
      (f.wagesUnpaid ? 'Die Löhne konnten nicht gezahlt werden.\n' : '') +
      `Online: ${members.filter(m => m.online).map(m => m.name).join(', ')}\n\n` +
      'Der Zähler für die Ausschüttung läuft solange nicht weiter.', state, 'high');
  }

  // --- 1) Lager ---
  const lager = f.stock?.total;
  merkeLager(state, lager);
  if (typeof lager === 'number') {
    // Plötzlicher Einbruch: Ein Rückgang, den der normale Absatz nicht erklärt,
    // ist ein Vorfall – etwa ein Einbruch. Nur prüfen, wenn der Watcher
    // durchgehend lief, sonst wäre jede Ausfallzeit ein Fehlalarm.
    const jetzt = Date.now();
    const seitLetzter = state.letzterLagerTick ? jetzt - state.letzterLagerTick : 0;
    if (state.lager !== null && seitLetzter > 0 && seitLetzter <= CFG.LUECKE_MIN * MIN) {
      const verlust = state.lager - lager;
      const minuten = seitLetzter / MIN;
      // Großzügig gerechnet: anderthalbfacher Absatz plus etwas Spielraum.
      // Gemessen, nicht aus salesPerMinute hochgerechnet – und mindestens so
      // viel wie der größte bisher beobachtete Schub, denn verkauft wird
      // stoßweise. Sonst gilt ein ganz normaler Verkauf als Einbruch.
      const gemessen = gemessenerAbsatz(state, 120);
      const proMinute = gemessen?.proMinute ?? (f.stock.salesPerMinute || 0);
      const laufenderAbsatz = Math.max(
        proMinute * minuten * 1.5,
        (gemessen?.groessterSchub || 0) * 1.5,
      ) + 5;

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
            (bewegung.einnahmen
              ? `Verbucht: ${fmt(bewegung.einnahmen)} für ${bewegung.abgegeben} Einheiten – ` +
                `der Rest bleibt unerklärt.\n\n`
              : `Keine Einnahme in dieser Zeit – es war also kein Verkauf.\n\n`) +
            (bericht.length
              ? `Online zum Zeitpunkt:\n${bericht.join('\n')}`
              : 'Niemand aus dem Team war online.'),
            state, 'urgent', {
              // Wer anwesend war, ist ein Verdacht und gehört nicht in einen
              // geteilten Kanal. Die Zahlen dürfen dort stehen.
              teamText: `Lager: ${state.lager} → ${lager} (${verlust} Einheiten, ` +
                `${prozent.toFixed(1)} %)\n` +
                `Erklärbar wären höchstens ${Math.round(erklaerbar)} in ` +
                `${Math.round(minuten)} Min.`,
            });
        }
      }
    }
    state.letzterLagerTick = jetzt;

    if (lager < CFG.LAGER_SCHWELLE) {
      await push('lager', '⚠️ Lagerbestand niedrig',
        `Lager: ${lager} / ${f.stock.capacity} (Schwelle ${CFG.LAGER_SCHWELLE})\n` +
        `Absatz: ${absatzText(state, f)}`,
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

  // --- 2b) Nachkauf: setzt er aus, während Bestand abfließt? ---
  // Das ist der Fall, der wirklich zählt. Läuft der Nachkauf, füllt sich das
  // Lager selbst und eine Reichweite wäre bedeutungslos.
  if (typeof lager === 'number') {
    const nk = nachkaufStand(f, state);
    const abfluss = gemessenerAbsatz(state, CFG.NACHKAUF_FENSTER_MIN);

    if (nk.an === false && nk.quelle === 'Einkäufe' && abfluss?.abgeflossen > 0) {
      const r = reichweite(state, lager);
      await push('nachkauf_aus', '⏹️ Nachkauf scheint auszusetzen',
        `Seit ${dauer(nk.her)} hat das System nichts eingekauft, ` +
        `es sind aber ${abfluss.abgeflossen} Einheiten abgeflossen.\n` +
        `Bestand: ${lager}` + (r ? `, reicht noch ${dauer(r.ms)}.` : '.') + '\n\n' +
        'Entweder ist der Nachkauf aus oder die Kasse reicht nicht.',
        state, 'high');
    } else if (nk.an === true) {
      // Läuft wieder: Sperre lösen, damit die nächste Aussetzer-Meldung kommt.
      state.lastPush.nachkauf_aus = 0;
    }
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
    // Art und Anzahl mitschreiben, damit /melden sie zur Auswahl anbieten kann.
    const art = vorfallArt(f.event);
    state.vorfallArten = { ...(state.vorfallArten || {}),
      [art]: {
        anzahl: (state.vorfallArten?.[art]?.anzahl || 0) + 1,
        zuletzt: Date.now(),
        name: sauber(f.event?.name || f.event?.title || art),
      } };

    await push(vorfallSchluessel(f.event), '🚨 Vorfall im Unternehmen',
      ereignisText(f.event) +
      (ex.maxSlots
        ? `\n\nExpresslieferung: ${ex.freeSlots ?? '?'} von ${ex.maxSlots} Plätzen frei` +
          `, Aufschlag ${Math.round((ex.surcharge || 0) * 100)} %` +
          (ex.cooldownLeftMs ? `, wieder möglich in ${dauer(ex.cooldownLeftMs)}` : '')
        : '') +
      (bericht.length ? `\n\nOnline zum Zeitpunkt:\n${bericht.join('\n')}` : ''),
      state, 'urgent', {
        // Wer online war, ist eine Frage für den Inhaber, nicht fürs Team.
        teamText: ereignisText(f.event) +
          (ex.maxSlots
            ? `\n\nExpresslieferung: ${ex.freeSlots ?? '?'} von ${ex.maxSlots} Plätzen frei` +
              `, Aufschlag ${Math.round((ex.surcharge || 0) * 100)} %`
            : ''),
      });

    await erinnereAnVorfall(state, f.event);
  } else if (state.offenerVorfall) {
    // Der Vorfall ist weg – erledigt oder abgelaufen. Ruhe geben.
    info(`Vorfall erledigt nach ${dauer(Date.now() - state.offenerVorfall.seit)}`);
    state.offenerVorfall = null;
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
        state, 'high', {
          teamText: `Einkaufspreise im Schnitt +${aenderung.toFixed(0)} %\n\n` +
            teuerste.join('\n') +
            (ex.maxSlots
              ? `\n\nExpresslieferung: ${ex.freeSlots ?? '?'} von ${ex.maxSlots} Plätzen frei` +
                `, Aufschlag ${Math.round((ex.surcharge || 0) * 100)} %`
              : ''),
        });
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

  // --- 5b) Betrieb (Zoohandlung): Bestand im Auge behalten ---
  await pruefeBetrieb(state);

  // --- 6) Ausschüttung ---
  await pruefeAusschuettung(state);

  // --- 7) Wiki (höchstens einmal je Intervall) ---
  const wikiGeaendert = await pruefeWiki(state);

  // --- 8) Notion abgleichen: sofort nach einer Wiki-Änderung, sonst im Takt ---
  await pruefeNotion(state, state.wiki, wikiGeaendert);

  sichereZugang(state);
  save(state);
  log('geprüft', { lager: state.lager, personal: state.personal, kasse: state.kasse,
                   gewinn: state.gewinn, laeuft, teamOnline: dauer(state.teamOnlineMs),
                   online: members.filter(m => m.online).map(m => m.name) });
}

/* ========================= DISCORD-BEFEHLE ========================= */

const tabelle = (zeilen) => zeilen.length ? '```\n' + zeilen.join('\n') + '\n```' : '_keine Daten_';

// Die Firma wird für mehrere Befehle gebraucht. Ein kurzer Puffer verhindert,
// dass fünf Leute hintereinander fünf API-Abfragen auslösen.
let firmaPuffer = { zeit: 0, daten: null };
async function firmaFrisch() {
  if (firmaPuffer.daten && Date.now() - firmaPuffer.zeit < 20_000) return firmaPuffer.daten;
  const daten = await holeFirma();
  firmaPuffer = { zeit: Date.now(), daten: daten.company };
  return firmaPuffer.daten;
}

// Wie bei der Firma: kurz puffern, damit mehrere Leute hintereinander nicht
// mehrere Abfragen auslösen.
let betriebPuffer = { zeit: 0, daten: null };
async function betriebeFrisch() {
  if (betriebPuffer.daten && Date.now() - betriebPuffer.zeit < 20_000) return betriebPuffer.daten;
  const daten = await holeBetriebe();
  betriebPuffer = { zeit: Date.now(), daten };
  return daten;
}

const BEFEHLE = {
  firma: {
    beschreibung: 'Zustand der Firma: Status, Lager, Personal, wer online ist',
    oeffentlich: true,
    async ausfuehren({ darf, oeffentlich }) {
      const f = await firmaFrisch();
      const online = (f.members || []).filter(m => m.online);
      let t = `**${f.name}** · Level ${f.level} · ${sauber(f.status)}\n` +
        `Lager: ${f.stock?.total} / ${f.stock?.capacity}\n` +
        `Personal: ${Array.isArray(f.employees) ? f.employees.length : '?'} / ${f.maxEmployees ?? '?'}\n` +
        `Team online: ${online.length} von ${(f.members || []).length}` +
        (online.length ? ` (${online.map(m => m.name).join(', ')})` : '');
      if (f.wagesUnpaid) t += '\n⚠️ Die Löhne konnten nicht gezahlt werden.';
      if (f.rentStrikes > 0) t += `\n⚠️ Mietmahnungen: ${f.rentStrikes} von ${f.rentStrikesMax}`;
      // Beträge nur für den Inhaber.
      // Wer /kasse benutzen darf, sieht die Beträge auch hier – sonst wäre
      // die Zurückhaltung an dieser Stelle sinnlos.
      // Im offenen Kanal nie Beträge, auch wenn der Fragende sie dürfte –
      // sonst stünden sie für alle da, nur weil der Falsche getippt hat.
      if (darf('kasse') && !oeffentlich) {
        t += `\n\nKasse: ${fmt(f.kasse?.balance)} · Gewinn: ${fmt(f.kasse?.profitSincePayout)}`;
      }
      return t;
    },
  },

  lager: {
    beschreibung: 'Lagerbestand, Absatz und wie lange der Bestand noch reicht',
    oeffentlich: true,
    async ausfuehren() {
      const f = await firmaFrisch();
      const st = load();
      const bestand = f.stock?.total ?? 0, kapazitaet = f.stock?.capacity ?? 0;
      const anteil = kapazitaet ? Math.round(bestand / kapazitaet * 100) : 0;
      // Ein Balken sagt auf dem Handy mehr als eine Zahl.
      const balken = '█'.repeat(Math.round(anteil / 5)) + '░'.repeat(20 - Math.round(anteil / 5));

      let t = `**Lager:** ${bestand} / ${kapazitaet} (${anteil} %)\n` + '`' + balken + '`';

      // Läuft der Nachkauf, füllt sich das Lager selbst – dann sagt eine
      // Reichweite nichts aus und bleibt weg.
      const nk = nachkaufStand(f, st);
      if (nk.an === true) {
        t += '\n\n🔄 **Nachkauf läuft** – der Bestand füllt sich selbst auf.';
        if (nk.quelle === 'Einkäufe' && nk.her) {
          t += `\nLetzter Einkauf vor ${dauer(nk.her)}.`;
        }
        if (bestand < CFG.LAGER_SCHWELLE) {
          t += `\n\n⚠️ Trotzdem unter der Schwelle von ${CFG.LAGER_SCHWELLE} – ` +
               'entweder reicht das Geld nicht oder der Nachkauf kommt nicht hinterher.';
        }
        return t;
      }

      if (nk.an === false) {
        t += '\n\n⏹️ **Nachkauf ist aus.**' +
          (nk.quelle === 'Einkäufe' && nk.her
            ? ` Seit ${dauer(nk.her)} hat das System nichts eingekauft.`
            : '');
      }

      // Gemessen statt hochgerechnet: verkauft wird schubweise, die Angabe der
      // API lässt sich nicht auf die Minute umlegen.
      const r = reichweite(st, bestand);
      const a = gemessenerAbsatz(st);
      if (r) {
        t += `\n\n**Reicht noch ${dauer(r.ms)}**\n` +
          `${r.proMinute.toFixed(1)} Einheiten/Min, gemessen über ${Math.round(r.minuten)} Min ` +
          `(${r.abgeflossen} Stück in ${r.schuebe} Schüben).`;
      } else if (a) {
        t += '\n\nIn der letzten Stunde ging nichts raus – keine Reichweite berechenbar.';
      } else {
        t += '\n\nReichweite noch unbekannt: der Watcher misst den Absatz selbst ' +
          'und braucht dafür etwa 10 Minuten Laufzeit.';
      }

      if (bestand < CFG.LAGER_SCHWELLE) {
        t += `\n\n⚠️ Unter der Schwelle von ${CFG.LAGER_SCHWELLE} – nachfüllen.`;
      }
      return t;
    },
  },

  ausschuettung: {
    beschreibung: 'Wie weit ist die Team-Onlinezeit bis zur nächsten Ausschüttung',
    oeffentlich: true,
    async ausfuehren({ darf, oeffentlich }) {
      const st = load();
      const ziel = CFG.AUSSCHUETTUNG_STD * 3_600_000;
      const anteil = Math.min(100, Math.round(st.teamOnlineMs / ziel * 100));
      const balken = '█'.repeat(Math.round(anteil / 5)) + '░'.repeat(20 - Math.round(anteil / 5));
      let t = `**Ausschüttung:** ${dauer(st.teamOnlineMs)} von ${CFG.AUSSCHUETTUNG_STD} Std. (${anteil} %)\n` +
        '`' + balken + '`\n' +
        (st.teamOnlineMs >= ziel
          ? '✅ Ziel erreicht – die Ausschüttung kann gemacht werden.'
          : `Noch ${dauer(ziel - st.teamOnlineMs)}.`);
      const zahlen = darf('kasse') && !oeffentlich;
      if (zahlen && st.gewinn !== null) t += `\n\nGewinn bisher: ${fmt(st.gewinn)}`;
      if (zahlen && st.letzteAusschuettung) {
        t += `\nLetzte Ausschüttung: ${new Date(st.letzteAusschuettung).toLocaleString('de-DE')}`;
      }
      return t;
    },
  },

  zeiten: {
    beschreibung: 'Wer ist gerade online, und wie lange war ich heute da',
    oeffentlich: true,
    async ausfuehren({ nutzer, oeffentlich }) {
      const st = load();
      const eintraege = Object.entries(st.spieler || {});
      const online = eintraege.filter(([, p]) => p.online).map(([n]) => n);

      // Wer gerade spielt, darf jeder wissen – das steht ohnehin im Spiel.
      // Wie lange wer da war, gehört in den Tagesbericht, nicht hierhin.
      let t = online.length
        ? `🟢 **Gerade online (${online.length}):** ${online.join(', ')}`
        : '⚪ **Gerade ist niemand aus der Firma online.**';

      t += `\n\nTeam-Onlinezeit bis zur Ausschüttung: ${dauer(st.teamOnlineMs)} ` +
           `von ${CFG.AUSSCHUETTUNG_STD} Std.`;

      // Die eigene Zeit nur in einer privaten Antwort – im offenen Kanal
      // würde sie jeden angehen.
      if (!oeffentlich) {
        const meinName = ladeZuordnung()[nutzer.id];
        if (meinName) {
          const p = st.spieler[Object.keys(st.spieler || {})
            .find(k => k.toLowerCase() === String(meinName).toLowerCase()) || ''];
          t += p
            ? `\n\n**Du (${meinName}):** heute ${dauer(p.gesamtMs || 0)}`
            : `\n\n_Für **${meinName}** liegen heute noch keine Zeiten vor._`;
        } else {
          t += '\n\n_Für deine eigene Zeit muss dein Konto zugeordnet sein – ' +
               'sag dem Inhaber Bescheid._';
        }
      }
      return t;
    },
  },

  betrieb: {
    beschreibung: 'Bestand der Zoohandlung – was wirklich entnommen werden kann',
    oeffentlich: true,
    async ausfuehren() {
      let daten;
      try {
        daten = await betriebeFrisch();
      } catch (e) {
        return e.message.startsWith('BETRIEB_PFAD_UNBEKANNT')
          ? '❌ Der Watcher findet die Betriebsübersicht nicht. Auf dem Server ' +
            '`node --env-file=.env watcher.mjs --betrieb-probe` ausführen.'
          : `❌ Abruf fehlgeschlagen: ${e.message}`;
      }

      const st = betriebStand(daten);
      if (!st.gefunden) return `❌ Einen Betrieb namens **${CFG.BETRIEB}** gibt es dort nicht.`;
      if (st.bestand === null) {
        return `❌ **${st.name}** gefunden, aber der Bestand steht in keinem bekannten Feld. ` +
               '`--betrieb-probe` zeigt, wie die Antwort aussieht.';
      }

      const striche = Math.round(Math.min(100, st.anteil) / 5);
      const balken = '█'.repeat(striche) + '░'.repeat(20 - striche);
      let t = `**${st.name}: ${st.bestand} von ${st.max}**\n` + '`' + balken + '`';
      if (!CFG.BETRIEB_ID && CFG.BETRIEB_ABZUG) {
        t += `\nGelesen ${st.angezeigt}, abzüglich ${CFG.BETRIEB_ABZUG}.`;
      }

      if (st.bestand <= 0) t += '\n\n🔴 **Leer.** Es kann nichts mehr entnommen werden.';
      else if (st.bestand <= CFG.BETRIEB_SCHWELLE) t += `\n\n⚠️ Wird knapp – unter ${CFG.BETRIEB_SCHWELLE}.`;
      return t;
    },
  },

  gehalt: {
    beschreibung: 'Wie viel vom Tagesbudget für Auszahlungen und Gehälter noch frei ist',
    oeffentlich: true,
    async ausfuehren() {
      const st = load();
      const topf = auszahlungTopf(st);
      const anteil = Math.round(topf.genutzt / topf.limit * 100);
      const balken = '█'.repeat(Math.round(anteil / 5)) + '░'.repeat(20 - Math.round(anteil / 5));

      let t = `**Noch frei: ${fmt(topf.frei)}**\n` +
        '`' + balken + '`\n' +
        `${fmt(topf.genutzt)} von ${fmt(topf.limit)} sind heute raus (${anteil} %).`;

      if (!topf.frei) t += '\n\n🔴 Das Tagesbudget ist aufgebraucht.';
      else if (anteil >= 80) t += '\n\n⚠️ Es wird knapp.';

      // Bewusst nur die Summe: wer wann wie viel gezogen hat, ist für die
      // Frage "wie viel geht noch" ohne Belang und macht die Antwort lang.
      return t + `\n\n_Setzt sich täglich um ${String(CFG.AUSZAHLUNG_RESET_STD).padStart(2, '0')}:00 Uhr zurück._`;
    },
  },

  kasse: {
    beschreibung: 'Kassenstand, Gewinn und die letzten Buchungen (nur Inhaber)',
    nurChef: true,
    async ausfuehren() {
      const f = await firmaFrisch();
      let t = `**Kasse:** ${fmt(f.kasse?.balance)}\n` +
        `Gewinn seit der letzten Ausschüttung: ${fmt(f.kasse?.profitSincePayout)}`;
      try {
        const l = await holeLedger(f.id);
        const letzte = (l.entries || []).slice(-5).reverse()
          .map(b => `${new Date(b.stamp).toLocaleTimeString('de-DE').slice(0, 5)} ` +
                    `${sauber(b.category).padEnd(20).slice(0, 20)} ${fmt(b.amount).padStart(14)}`);
        if (letzte.length) t += '\n\n**Letzte Buchungen**\n' + tabelle(letzte);
      } catch (e) { t += `\n\n_Kassenbuch nicht abrufbar: ${e.message}_`; }
      return t;
    },
  },

  tagesbericht: {
    beschreibung: 'Onlinezeiten des Spieltags als Übersicht (nur Inhaber)',
    nurChef: true,
    async ausfuehren() {
      const st = load();
      const zeilen = Object.entries(st.spieler || {})
        .sort((a, b) => (b[1].gesamtMs || 0) - (a[1].gesamtMs || 0))
        .map(([name, p]) => `${p.online ? '🟢' : '⚪'} ${name.padEnd(18)} ` +
          `${dauer(p.gesamtMs || 0).padStart(14)}  ${p.rolle || ''}`);
      const gesamt = Object.values(st.spieler || {}).reduce((n, p) => n + (p.gesamtMs || 0), 0);
      return `**Spieltag ${st.tag || '?'}** (04:00 bis 04:00)\n` + tabelle(zeilen) +
        `\nSumme: ${dauer(gesamt)} · davon Firma gelaufen: ${dauer(st.teamOnlineMs)}`;
    },
  },

  watcher: {
    beschreibung: 'Läuft der Watcher, und wann war der letzte Abruf (nur Inhaber)',
    nurChef: true,
    async ausfuehren() {
      const st = load();
      const seit = process.uptime();
      return `**Watcher läuft** seit ${dauer(seit * 1000)}\n` +
        `Intervall: ${CFG.INTERVALL_MS / 1000}s\n` +
        `Token gültig bis: ${zugang.exp ? new Date(zugang.exp).toLocaleTimeString('de-DE') : 'unbekannt'}\n` +
        `UnicaCity erreichbar: ${st.apiWegSeit ? `nein, seit ${dauer(Date.now() - st.apiWegSeit)}` : 'ja'}\n` +
        `Wiki-Artikel bekannt: ${Object.keys(st.wiki || {}).length}`;
    },
  },

  zuordnen: {
    beschreibung: 'Ein Discord-Konto einem UnicaCity-Namen zuordnen',
    nurChef: true,
    optionen: [
      { name: 'nutzer', description: 'Wen im Discord?', type: 6, required: false },
      { name: 'name', description: 'Wie heißt die Person in UnicaCity?', type: 3, required: false },
      { name: 'entfernen', description: 'Die Zuordnung dieser Person löschen', type: 5, required: false },
    ],

    async ausfuehren({ optionen }) {
      const zuordnung = { ...zuordnungEigen() };
      const ausEnv = ladeZuordnung();
      const st = load();
      const spieler = st.spieler || {};
      const istOnline = (n) => Object.entries(spieler)
        .find(([k]) => k.toLowerCase() === String(n).toLowerCase())?.[1]?.online;

      // Ohne Angaben: zeigen, was zugeordnet ist.
      if (!optionen.nutzer) {
        const alle = Object.entries(ausEnv);
        if (!alle.length) {
          return '_Noch niemand zugeordnet._\n\n' +
            'Zuordnen mit `/zuordnen nutzer:@Name name:UC-Name`. Danach kannst du ' +
            'Meldungen so einstellen, dass nur angepingt wird, wer gerade spielt: ' +
            '`/melden thema:… ping:nur wer gerade ingame online ist`';
        }
        const zeilen = alle.map(([id, name]) => {
          const on = istOnline(name);
          const woher = zuordnung[id] ? '' : ' _(aus der .env)_';
          return `${on ? '🟢' : on === false ? '⚪' : '·'} <@${id}> → **${name}**${woher}`;
        });
        return `**Zuordnungen** (${alle.length})\n` + zeilen.join('\n') +
          '\n\n🟢 spielt gerade · ⚪ offline · · dem Watcher noch nicht begegnet';
      }

      const id = String(optionen.nutzer);

      if (optionen.entfernen) {
        if (!zuordnung[id]) {
          return ausEnv[id]
            ? `<@${id}> steht in \`UC_DISCORD_SPIELER\` in der .env – das kann ich ` +
              'hier nicht löschen. Entweder dort entfernen, oder mit ' +
              '`/zuordnen` einen anderen Namen setzen, der sie überschreibt.'
            : `Für <@${id}> war nichts eingetragen.`;
        }
        const weg = zuordnung[id];
        delete zuordnung[id];
        speichereZuordnung(zuordnung);
        return `✅ Zuordnung von <@${id}> zu **${weg}** entfernt.`;
      }

      // Nur den Nutzer genannt: dessen Eintrag zeigen.
      if (!optionen.name) {
        return ausEnv[id]
          ? `<@${id}> → **${ausEnv[id]}**${istOnline(ausEnv[id]) ? ' (spielt gerade)' : ''}`
          : `Für <@${id}> ist nichts eingetragen.\n\n` +
            '_Setzen mit `/zuordnen nutzer:… name:UC-Name`._';
      }

      const name = optionen.name.trim();
      if (!name) return '❌ Der Name ist leer.';

      // Denselben Namen zweimal zu vergeben wäre ein Tippfehler, kein Wunsch.
      const schonVergeben = Object.entries(ausEnv)
        .find(([anderer, n]) => anderer !== id && String(n).toLowerCase() === name.toLowerCase());
      if (schonVergeben) {
        return `❌ **${name}** ist schon <@${schonVergeben[0]}> zugeordnet. ` +
          'Erst dort entfernen (`/zuordnen nutzer:… entfernen:True`), dann neu setzen.';
      }

      const vorher = zuordnung[id];
      zuordnung[id] = name;
      speichereZuordnung(zuordnung);

      let t = vorher && vorher !== name
        ? `✅ <@${id}> → **${name}** (vorher ${vorher})`
        : `✅ <@${id}> → **${name}**`;

      // Der Watcher kennt nur Namen, die er im Team schon gesehen hat. Ein
      // unbekannter Name ist meist ein Tippfehler – aber nicht immer, bei einer
      // Neueinstellung ist er einfach noch nicht aufgetaucht.
      const bekannt = Object.keys(spieler).find(k => k.toLowerCase() === name.toLowerCase());
      if (!bekannt) {
        t += '\n\n⚠️ Diesen Namen hat der Watcher im Team noch nicht gesehen. ' +
             'Prüfe die Schreibweise – oder ignoriere den Hinweis, wenn die Person ' +
             'gerade erst eingestellt wurde.';
        const aehnlich = Object.keys(spieler)
          .filter(k => k.toLowerCase().startsWith(name.slice(0, 3).toLowerCase()))
          .slice(0, 5);
        if (aehnlich.length) t += `\nIm Team gibt es: ${aehnlich.join(', ')}`;
      } else if (spieler[bekannt].online) {
        t += '\n\nSpielt gerade – wird bei „nur wer online ist" also angepingt.';
      }
      return t + '\n\n_Gilt sofort, auch nach einem Neustart._';
    },
  },

  rechte: {
    beschreibung: 'Vergeben, wer die vorbehaltenen Befehle benutzen darf',
    nurChef: true,
    nichtUebertragbar: true,     // Rechte vergeben bleibt beim Inhaber
    optionen: [
      { name: 'befehl', description: 'Welcher Befehl?', type: 3, required: false,
        choices: [
          { name: '/kasse – Kassenstand, Gewinn, letzte Buchungen', value: 'kasse' },
          { name: '/tagesbericht – Onlinezeiten des ganzen Teams',  value: 'tagesbericht' },
          { name: '/watcher – läuft der Watcher, Technik',          value: 'watcher' },
          { name: '/melden – Meldungen umstellen',                  value: 'melden' },
          { name: '/zuordnen – Spieler zuordnen',                   value: 'zuordnen' },
        ] },
      { name: 'rolle', description: 'Recht an eine ganze Rolle geben', type: 8, required: false },
      { name: 'nutzer', description: 'Recht an eine einzelne Person geben', type: 6, required: false },
      { name: 'entfernen', description: 'Das Recht wieder wegnehmen', type: 5, required: false },
    ],

    async ausfuehren({ optionen }) {
      const rechte = ladeRechte();

      const zeigeAlles = () => {
        const zeilen = ['kasse', 'tagesbericht', 'watcher', 'melden', 'zuordnen'].map(b => {
          const r = rechte[b] || {};
          const wer = [
            ...(r.rollen || []).map(id => `<@&${id}>`),
            ...(r.nutzer || []).map(id => `<@${id}>`),
          ];
          return `**/${b}** – ${wer.length ? wer.join(', ') : '_nur du_'}`;
        });
        return '**Wer darf welchen Befehl?**\n' + zeilen.join('\n') +
          '\n\nDie übrigen Befehle (/firma, /lager, /ausschuettung, /zeiten, /hilfe) ' +
          'kann ohnehin jeder benutzen.\n' +
          'Vergeben: `/rechte befehl:… rolle:…` oder `nutzer:…`';
      };

      if (!optionen.befehl) return zeigeAlles();
      if (!optionen.rolle && !optionen.nutzer) {
        const r = rechte[optionen.befehl] || {};
        const wer = [
          ...(r.rollen || []).map(id => `<@&${id}>`),
          ...(r.nutzer || []).map(id => `<@${id}>`),
        ];
        return `**/${optionen.befehl}** darf: ${wer.length ? wer.join(', ') : '_nur du_'}\n\n` +
          '_Zum Ändern zusätzlich `rolle:` oder `nutzer:` angeben._';
      }

      const eintrag = rechte[optionen.befehl] || { rollen: [], nutzer: [] };
      eintrag.rollen ||= []; eintrag.nutzer ||= [];
      const art = optionen.rolle ? 'rollen' : 'nutzer';
      const id = String(optionen.rolle || optionen.nutzer);
      const anzeige = optionen.rolle ? `<@&${id}>` : `<@${id}>`;

      if (optionen.entfernen) {
        if (!eintrag[art].includes(id)) return `${anzeige} hatte dieses Recht gar nicht.`;
        eintrag[art] = eintrag[art].filter(x => x !== id);
        rechte[optionen.befehl] = eintrag;
        speichereRechte(rechte);
        return `✅ ${anzeige} darf **/${optionen.befehl}** nicht mehr benutzen.`;
      }

      if (eintrag[art].includes(id)) return `${anzeige} darf **/${optionen.befehl}** bereits.`;
      eintrag[art].push(id);
      rechte[optionen.befehl] = eintrag;
      speichereRechte(rechte);

      let t = `✅ ${anzeige} darf ab jetzt **/${optionen.befehl}** benutzen.`;
      // Sagen, was damit wirklich sichtbar wird – ein Recht zu vergeben, ohne
      // dessen Umfang zu kennen, ist die Art Fehler, die man später bereut.
      const umfang = {
        kasse: 'Kassenstand, Gewinn und die letzten Buchungen – und damit auch ' +
               'die Beträge in /firma und /ausschuettung.',
        tagesbericht: 'die Onlinezeiten aller Angestellten – und damit auch die ' +
               'volle Liste in /zeiten statt nur der eigenen Zeit.',
        watcher: 'den technischen Zustand: Laufzeit, Token-Ablauf, Erreichbarkeit.',
        melden: 'das Umstellen aller Meldungen – auch das Abschalten und das ' +
               'Verschieben in andere Kanäle.',
        zuordnen: 'das Zuordnen von Discord-Konten zu Spielernamen.',
      }[optionen.befehl];
      if (umfang) t += `\n\nDamit sieht ${anzeige} ${umfang}`;
      return t + '\n\n_Gilt sofort, auch nach einem Neustart._';
    },
  },

  testvorfall: {
    beschreibung: 'Einen Vorfall vortäuschen, um Kanal und Ping zu prüfen',
    nurChef: true,
    optionen: [
      { name: 'art', description: 'Welche Vorfallsart soll geprüft werden?',
        type: 3, required: false, autocomplete: true },
    ],

    vorschlaege(feld, eingabe) {
      return feld === 'art' ? BEFEHLE.melden.vorschlaege('vorfallart', eingabe) : [];
    },

    async ausfuehren({ optionen }) {
      const art = String(optionen.art || 'ABWERBUNG').toUpperCase().replace(/[^A-Z0-9]+/g, '_');

      // Ein echtes Ereignis nachbauen, damit Schlüssel, Regel und Ping genau
      // so bestimmt werden wie im Ernstfall. Nur der Inhalt sagt, dass es
      // eine Probe ist – niemand soll wegen einer Übung in Panik geraten.
      const ereignis = {
        type: art,
        name: `Probe: ${art}`,
        description: 'Das ist ein Testvorfall des Watchers. Es ist nichts passiert.',
        minutesLeft: 10,
      };

      const state = load();
      const schluessel = vorfallSchluessel(ereignis);
      const regel = empfaenger(schluessel, ladeRegeln());

      // Die Sperre gegen Wiederholungen darf eine Probe nicht verschlucken.
      delete state.lastPush[schluessel];

      const gepingt = regel.ping === 'online' ? onlineDiscordIds(state) : [];

      await push(schluessel, '🧪 Testvorfall (keine echte Meldung)',
        ereignisText(ereignis) +
        '\n\nWenn du das siehst, kommen Vorfälle hier an.',
        state, 'urgent');
      // Bewusst nicht speichern: eine Probe soll den Zustand nicht verändern.

      // Bericht, damit man nicht raten muss, was passiert ist.
      let t = `✅ Testvorfall **${art}** verschickt.\n\n` +
        `**Regel:** ${regelText(regel)}`;

      if (regel.ziel === 'aus') {
        t += '\n\n⚠️ Diese Art ist abgeschaltet – es wurde nichts verschickt.';
        return t;
      }

      if (regel.ping === 'online') {
        const zuordnung = ladeZuordnung();
        const online = Object.entries(state.spieler || {})
          .filter(([, p]) => p.online).map(([n]) => n);
        t += `\n\n**Ping:** ${gepingt.length} Konto${gepingt.length === 1 ? '' : 'en'}`;
        if (gepingt.length) {
          t += ` – ${gepingt.map(id => `<@${id}>`).join(', ')}`;
        } else if (!online.length) {
          t += '\n⚠️ Gerade ist niemand aus der Firma ingame online – deshalb ' +
               'wurde niemand gepingt. Das ist richtig so, sagt aber nichts ' +
               'darüber, ob die Zuordnung stimmt.';
        } else if (!Object.keys(zuordnung).length) {
          t += '\n⚠️ Online sind: ' + online.join(', ') + ' – aber **niemand ist ' +
               'zugeordnet**. Mit `/zuordnen nutzer:… name:…` nachholen, sonst ' +
               'pingt diese Einstellung nie.';
        } else {
          t += '\n⚠️ Online sind: ' + online.join(', ') + ' – davon ist keiner ' +
               'einem Discord-Konto zugeordnet. `/zuordnen` prüfen, die ' +
               'Schreibweise der Namen muss passen.';
        }
      } else if (regel.ping && regel.ping !== 'keiner') {
        t += '\n\n**Ping:** ' + (regel.ping === 'everyone' ? '@everyone'
          : regel.ping === 'here' ? '@here' : `<@&${regel.ping}>`) +
          '\nKam er nicht an, fehlt dem Bot im Kanal das Recht „Everyone erwähnen".';
      } else {
        t += '\n\n**Ping:** keiner – so ist es eingestellt.';
      }

      return t + '\n\n_Die Probe verändert nichts: keine Erinnerung, keine ' +
        'gespeicherte Sperre, kein Eintrag in den Vorfallsarten._';
    },
  },

  melden: {
    beschreibung: 'Einstellen, wer welche Meldung sieht und ob gepingt wird',
    nurChef: true,
    optionen: [
      { name: 'thema', description: 'Welche Meldung?', type: 3, required: false,
        choices: THEMEN.map(([k, name]) => ({ name: name.slice(0, 100), value: k })) },
      { name: 'ziel', description: 'Wer soll sie sehen?', type: 3, required: false,
        choices: [
          { name: 'nur ich',              value: 'chef' },
          { name: 'nur das Team',         value: 'team' },
          { name: 'ich und das Team',     value: 'beide' },
          { name: 'ein bestimmter Kanal',       value: 'kanal' },
          { name: 'ein bestimmter Kanal und ich', value: 'kanal_chef' },
          { name: 'gar nicht (aus)',      value: 'aus' },
          { name: 'zurück auf Standard',  value: 'standard' },
        ] },
      { name: 'kanal', description: 'Kanal, wenn ziel = ein bestimmter Kanal', type: 7, required: false },
      { name: 'ping', description: 'Wer wird benachrichtigt?', type: 3, required: false,
        choices: [
          { name: 'niemand',                           value: 'keiner' },
          { name: 'nur wer gerade ingame online ist',  value: 'online' },
          { name: '@everyone',                         value: 'everyone' },
          { name: '@here',                             value: 'here' },
          { name: 'eine Rolle (Feld rolle ausfüllen)', value: 'rolle' },
        ] },
      { name: 'rolle', description: 'Rolle, wenn ping = eine Rolle', type: 8, required: false },
      { name: 'wiederholung', description: 'Wie lange Ruhe, bevor dieselbe Meldung wiederkommt?',
        type: 3, required: false,
        choices: [
          { name: 'nach 15 Minuten',   value: '15' },
          { name: 'nach 30 Minuten',   value: '30' },
          { name: 'nach 1 Stunde',     value: '60' },
          { name: 'nach 3 Stunden',    value: '180' },
          { name: 'nach 12 Stunden',   value: '720' },
          { name: 'erst am nächsten Tag', value: '1440' },
        ] },
      { name: 'vorfallart', description: 'Nur bei Vorfällen: Art wählen oder eintippen, z. B. ABWERBUNG',
        type: 3, required: false, autocomplete: true },
      { name: 'erinnerung', description: 'Nur bei Vorfällen: nachfassen, solange er offen ist',
        type: 3, required: false,
        choices: [
          { name: 'nicht nachfassen',      value: '0' },
          { name: 'nach 2 Minuten',        value: '2' },
          { name: 'nach 3 Minuten',        value: '3' },
          { name: 'nach 5 Minuten',        value: '5' },
          { name: 'nach 10 Minuten',       value: '10' },
        ] },
      { name: 'takt', description: 'Nur beim Zwischenstand der Ausschüttung: wie oft?',
        type: 3, required: false,
        choices: [
          { name: 'jede Stunde',                   value: '1' },
          { name: 'alle zwei Stunden',             value: '2' },
          { name: 'alle drei Stunden',             value: '3' },
          { name: 'alle sechs Stunden',            value: '6' },
          { name: 'nur wenn die Ausschüttung fällig ist', value: '0' },
        ] },
    ],

    // Was der Watcher bisher an Vorfallsarten gesehen hat, plus alles, wofür
    // schon eine Regel besteht – damit man eine Einstellung wiederfindet,
    // auch wenn die Art länger nicht vorkam.
    vorschlaege(feld, eingabe) {
      if (feld !== 'vorfallart') return [];
      const gesehen = load().vorfallArten || {};
      const ausRegeln = Object.keys(ladeRegeln())
        .filter(k => k.startsWith('event_') && k !== 'event_')
        .map(k => k.slice('event_'.length));

      const such = String(eingabe || '').toLowerCase();
      const arten = [...new Set([...Object.keys(gesehen), ...ausRegeln, ...VORFALL_BEKANNT])]
        .filter(a => a.toLowerCase().includes(such))
        .sort((a, b) => (gesehen[b]?.zuletzt || 0) - (gesehen[a]?.zuletzt || 0));

      const liste = arten.map(a => ({
        name: (gesehen[a] ? `${a} (${gesehen[a].anzahl}× gesehen)`
              : ausRegeln.includes(a) ? `${a} (eingestellt)`
              : `${a} (bekannte Art)`).slice(0, 100),
        value: a,
      }));

      // Getipptes immer anbieten: der Watcher kennt nur Arten, die er selbst
      // schon gesehen hat – ohne das wäre das Feld vor dem ersten Vorfall
      // leer und damit unbenutzbar.
      const eigen = String(eingabe || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      if (eigen && !liste.some(x => x.value === eigen)) {
        liste.unshift({ name: `${eigen} (so übernehmen)`.slice(0, 100), value: eigen });
      }
      return liste;
    },

    async ausfuehren({ optionen }) {
      const regeln = ladeRegeln();

      // Ohne Thema: zeigen, was gerade gilt.
      if (!optionen.thema) {
        const zeilen = THEMEN.map(([k, name]) => {
          const eigen = !!regeln[k];
          return `${eigen ? '✏️' : '·'} **${name}**\n   ${regelText(empfaenger(k, regeln))}`;
        });

        // Regeln für einzelne Vorfallsarten stehen nicht in THEMEN – sie
        // entstehen erst, wenn man eine anlegt.
        for (const k of Object.keys(regeln).filter(x => x.startsWith('event_') && x !== 'event_')) {
          zeilen.push(`✏️ **Vorfall: ${k.slice('event_'.length)}**\n   ${regelText(regeln[k])}`);
        }
        return '**Wer sieht welche Meldung?**\n' + zeilen.join('\n') +
          '\n\n✏️ = von dir geändert · · = Voreinstellung' +
          '\n\nÄndern: `/melden thema:… ziel:… ping:…`';
      }

      // Mit einer Vorfallsart gilt die Regel nur für diese – sie schlägt die
      // allgemeine, weil der längere Themenanfang gewinnt.
      if (optionen.vorfallart && optionen.thema !== 'event_') {
        return '❌ `vorfallart:` gibt es nur beim Vorfall im Unternehmen.';
      }
      const art = optionen.vorfallart
        ? String(optionen.vorfallart).toUpperCase().replace(/[^A-Z0-9]+/g, '_')
        : '';
      const thema = art ? `event_${art}` : optionen.thema;
      const name = art ? `Vorfall: ${art}` : themaName(optionen.thema);

      // Nur ein Thema genannt: dessen Regel zeigen.
      if (!optionen.ziel && !optionen.ping && !optionen.takt &&
          !optionen.wiederholung && !optionen.erinnerung) {
        return `**${name}**\n${regelText(empfaenger(thema, regeln))}\n\n` +
          '_Zum Ändern zusätzlich `ziel:` oder `ping:` angeben._';
      }

      if (optionen.ziel === 'standard') {
        delete regeln[thema];
        speichereRegeln(regeln);
        return `**${name}** steht wieder auf der Voreinstellung:\n` +
          regelText(empfaenger(thema, regeln));
      }

      const regel = { ...(regeln[thema] || empfaenger(thema, regeln)) };

      if (optionen.ziel) {
        const inKanal = optionen.ziel === 'kanal' || optionen.ziel === 'kanal_chef';
        if (inKanal && !optionen.kanal) {
          return '❌ Bei einem Kanal als Ziel musst du auch `kanal:` angeben.';
        }
        regel.ziel = inKanal ? 'kanal' : optionen.ziel;
        if (inKanal) {
          regel.kanal = optionen.kanal;
          // "und ich" heißt: der Kanal bekommt die gekürzte Fassung, du die
          // vollständige mit Beträgen und Namen.
          if (optionen.ziel === 'kanal_chef') regel.auchChef = true;
          else delete regel.auchChef;
        } else {
          delete regel.kanal; delete regel.auchChef;
        }
      }

      if (optionen.ping) {
        if (optionen.ping === 'rolle' && !optionen.rolle) {
          return '❌ Bei `ping: eine Rolle` musst du auch `rolle:` angeben.';
        }
        regel.ping = optionen.ping === 'rolle' ? optionen.rolle : optionen.ping;
      }

      if (optionen.wiederholung !== undefined) regel.wiederholung = Number(optionen.wiederholung);

      if (optionen.takt !== undefined) {
        if (thema !== 'ausschuettung_std_') {
          return '❌ `takt:` gibt es nur beim Zwischenstand der Ausschüttung.';
        }
        regel.takt = Number(optionen.takt);
      }

      if (optionen.erinnerung !== undefined) {
        if (thema !== 'event_') {
          return '❌ `erinnerung:` gibt es nur beim Vorfall im Unternehmen – ' +
                 'nur der bleibt offen, bis jemand handelt.';
        }
        regel.erinnerung = Number(optionen.erinnerung);
      }

      regeln[thema] = regel;
      speichereRegeln(regeln);

      let t = `✅ **${name}**\n${regelText(regel)}`;
      if (regel.erinnerung !== undefined) {
        t += regel.erinnerung === 0
          ? '\n\nEs wird nicht mehr nachgefasst – nur die erste Meldung.'
          : `\n\nBleibt der Vorfall offen, kommt nach ${regel.erinnerung} Minuten ` +
            `eine Erinnerung, höchstens ${CFG.VORFALL_ERINNERUNG_MAX}-mal.`;
      }
      if (regel.wiederholung !== undefined) {
        const w = regel.wiederholung;
        t += `\n\nDieselbe Meldung kommt frühestens ` +
          (w >= 1440 ? 'am nächsten Tag' : w >= 60 ? `nach ${w / 60} Std.` : `nach ${w} Min.`) +
          ' wieder.';
      }
      if (regel.takt !== undefined) {
        t += regel.takt === 0
          ? '\n\nKein Zwischenstand mehr – es kommt nur noch die Meldung, ' +
            'wenn die Ausschüttung fällig ist.'
          : `\n\nZwischenstand ${regel.takt === 1 ? 'jede Stunde' : `alle ${regel.takt} Stunden`}.`;
      }

      // Bei den Meldungen mit Namen oder Beträgen einmal deutlich sagen, was
      // da künftig mitliest. Der Inhaber darf das entscheiden – aber nicht
      // versehentlich.
      const heikel = {
        'lagerverlust_': 'Namen aller Anwesenden zum Zeitpunkt des Verlusts',
        'personal_':     'Namen der Anwesenden',
        'vorfall_':      'Beträge, Kassenstand und Namen der Anwesenden',
        'tagesbericht_': 'die Onlinezeiten aller Angestellten',
        'ausschuettung_': 'den ausgeschütteten Betrag',
        'auth':          'Hinweise auf deinen Zugang',
      }[thema];
      if (heikel && ['team', 'beide', 'kanal'].includes(regel.ziel)) {
        t += `\n\n⚠️ Diese Meldung enthält ${heikel}. Das lesen ab jetzt alle mit, ` +
             'die den Kanal sehen können.';
      }
      if (regel.ziel === 'aus') {
        t += '\n\n⚠️ Diese Meldung bekommt ab jetzt **niemand** – auch du nicht.';
      }
      if (regel.ping === 'online') {
        const zu = Object.keys(ladeZuordnung()).length;
        t += zu
          ? `\n\nAngepingt werden nur zugeordnete Konten, die gerade spielen ` +
            `(${zu} zugeordnet). Ist niemand online, kommt die Meldung ohne Ping.`
          : '\n\n⚠️ Noch ist niemand zugeordnet – so pingt das nie jemanden. ' +
            'Zuordnen mit `/zuordnen nutzer:@Name name:UC-Name`.';
      }
      if (regel.ping === 'everyone') {
        t += '\n\nDamit @everyone wirklich klingelt, braucht der Bot im Kanal das ' +
             'Recht „Everyone erwähnen".';
      }
      return t + '\n\n_Gilt sofort, auch nach einem Neustart._';
    },
  },

  hilfe: {
    beschreibung: 'Welche Befehle es gibt',
    async ausfuehren({ istChef, darf }) {
      const erlaubt = Object.entries(BEFEHLE).filter(([name, b]) => !b.nurChef || darf(name));
      const gesperrt = Object.keys(BEFEHLE).length - erlaubt.length;
      return '**Befehle des UC-Watchers**\n' +
        erlaubt.map(([name, b]) => `/${name} – ${b.beschreibung}`).join('\n') +
        (gesperrt && !istChef
          ? `\n\n_${gesperrt} weitere sind dem Firmeninhaber vorbehalten._`
          : '');
    },
  },
};

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

if (args.includes('--api-suche')) {
  // Die Seite ist eine JavaScript-Anwendung; die API-Adressen stehen als
  // Zeichenketten in ihrem Programmcode. Statt zu raten, lesen wir sie dort.
  const seite = args[args.indexOf('--api-suche') + 1] ||
                'https://unicacity.eu/dashboard/businesses';
  const kopf = { 'User-Agent': CFG.USER_AGENT, 'Accept': '*/*' };

  console.log('Lade', seite, '…');
  const html = await (await fetch(seite, { headers: kopf })).text();

  // Script-Dateien einsammeln, auch die vorgeladenen Module.
  const quellen = new Set();
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) quellen.add(m[1]);
  for (const m of html.matchAll(/<link[^>]+rel=["'](?:modulepreload|preload)["'][^>]+href=["']([^"']+\.js)["']/gi)) {
    quellen.add(m[1]);
  }
  for (const m of html.matchAll(/["']([^"']*\/assets\/[^"']+\.js)["']/gi)) quellen.add(m[1]);

  if (!quellen.size) {
    console.log('Keine JavaScript-Dateien in der Seite gefunden.');
    process.exit(1);
  }
  console.log(`${quellen.size} Skriptdatei(en) gefunden.\n`);

  const pfade = new Map();   // Pfad -> in welcher Datei
  const warteschlange = [...quellen];
  const erledigt = new Set();
  const GRENZE = 200;        // Sicherheitsnetz gegen endloses Nachladen

  // Die Ansicht für die Betriebe wird erst bei Bedarf nachgeladen. Ihre
  // Adresse steht deshalb nicht in der Hauptdatei, sondern in einem eigenen
  // Paket, auf das die Hauptdatei nur verweist. Also den Verweisen folgen.
  while (warteschlange.length && erledigt.size < GRENZE) {
    const roh = warteschlange.shift();
    let url;
    try { url = new URL(roh, seite).href; } catch { continue; }
    if (erledigt.has(url)) continue;
    erledigt.add(url);

    let text;
    try {
      const res = await fetch(url, { headers: kopf });
      if (!res.ok) continue;
      text = await res.text();
    } catch { continue; }

    const datei = url.split('/').pop();
    for (const m of text.matchAll(/["'`](\/api\/[^"'`\s]{2,80})["'`]/g)) {
      if (!pfade.has(m[1])) pfade.set(m[1], datei);
    }
    // Weitere Pakete, auf die diese Datei verweist
    for (const m of text.matchAll(/["'`]((?:\.{0,2}\/)?assets\/[A-Za-z0-9._-]+\.js)["'`]/g)) {
      const naechste = new URL(m[1].replace(/^\.\//, ''), url).href;
      if (!erledigt.has(naechste)) warteschlange.push(naechste);
    }
  }
  console.log(`${erledigt.size} Datei(en) durchsucht.\n`);

  if (!pfade.size) {
    console.log('Keine /api/-Adressen im Programmcode gefunden.');
    console.log('Vermutlich werden sie aus Teilen zusammengesetzt.');
    process.exit(1);
  }

  const alle = [...pfade.keys()].sort();
  const passend = alle.filter(p => /business|betrieb/i.test(p));

  if (passend.length) {
    console.log('🎯 Passt zu "Betrieb":');
    for (const p of passend) console.log(`   ${p}   (aus ${pfade.get(p)})`);
    console.log('');
  }
  console.log(`Alle gefundenen Adressen (${alle.length}):`);
  for (const p of alle) console.log(`   ${p}`);

  if (passend.length) {
    console.log('\nDie passendste in die .env eintragen, z. B.:');
    console.log(`   UC_BETRIEB_PFAD=${passend[0]}`);
    console.log('Danach: node --env-file=.env watcher.mjs --betrieb-probe');
  }
  process.exit(0);
}

if (args.includes('--events-probe')) {
  const s0 = load(); ladeZugang(s0);
  try { await erneuere(); } catch (e) { console.error('Kein Zugang:', e.message); process.exit(1); }

  const sekunden = +(args[args.indexOf('--events-probe') + 1] || 60);
  console.log(`Höre ${sekunden} s am Ereignisstrom mit …`);
  console.log('(In der Zeit im Spiel oder im Dashboard etwas anfassen, damit');
  console.log(' sich etwas tut – etwa die Zoohandlung öffnen.)\n');

  // Der Strom nimmt den Token in der Adresse, weil ein EventSource im Browser
  // keine Kopfzeilen setzen kann. Wir machen es genauso.
  const res = await fetch(`${CFG.API}/api/auth/events?token=${encodeURIComponent(zugang.token)}`, {
    headers: {
      Accept: 'text/event-stream', Cookie: zugang.cookie || '',
      'User-Agent': CFG.USER_AGENT, 'Origin': 'https://unicacity.eu',
      'Referer': 'https://unicacity.eu/',
    },
  });
  if (!res.ok) { console.error('Strom nicht erreichbar:', res.status); process.exit(1); }

  const felder = (o, tiefe = 0) => {
    if (Array.isArray(o)) return o.length ? `[${o.length}× ${felder(o[0], tiefe + 1)}]` : '[]';
    if (o && typeof o === 'object') {
      const k = Object.keys(o);
      return tiefe > 2 ? `{${k.slice(0, 10).join(', ')}}` :
        '{' + k.slice(0, 14).map(n => `${n}: ${felder(o[n], tiefe + 1)}`).join(', ') + '}';
    }
    return typeof o;
  };

  const gesehen = new Map();
  let zooGefunden = null;
  const ende = setTimeout(() => {
    console.log('\n--- Zusammenfassung ---');
    if (!gesehen.size) {
      console.log('Nichts empfangen. Entweder schickt der Strom nur bei Änderungen');
      console.log('etwas, oder die Betriebe laufen nicht darüber.');
    }
    for (const [art, anzahl] of gesehen) console.log(`${anzahl}× ${art}`);
    if (zooGefunden) {
      console.log(`\n✅ "${CFG.BETRIEB}" kommt im Strom vor, im Ereignis "${zooGefunden}".`);
      console.log('   Schick mir diese Zeile, dann lese ich den Bestand von dort.');
    }
    process.exit(0);
  }, sekunden * 1000);
  ende.unref?.();

  const leser = res.body.getReader();
  const roh = new TextDecoder();
  let puffer = '';
  while (true) {
    const { done, value } = await leser.read();
    if (done) break;
    puffer += roh.decode(value, { stream: true });

    // Ein Ereignis endet mit einer Leerzeile.
    let trenner;
    while ((trenner = puffer.indexOf('\n\n')) !== -1) {
      const block = puffer.slice(0, trenner);
      puffer = puffer.slice(trenner + 2);

      let art = 'message', daten = '';
      for (const zeile of block.split('\n')) {
        if (zeile.startsWith('event:')) art = zeile.slice(6).trim();
        else if (zeile.startsWith('data:')) daten += zeile.slice(5).trim();
      }
      if (!daten) continue;

      gesehen.set(art, (gesehen.get(art) || 0) + 1);
      let inhalt; try { inhalt = JSON.parse(daten); } catch { inhalt = daten; }
      console.log(`\n📨 ${art}`);
      console.log('   ' + (typeof inhalt === 'string'
        ? inhalt.slice(0, 300) : felder(inhalt).slice(0, 700)));

      // Steckt die Zoohandlung darin?
      if (daten.toLowerCase().includes(String(CFG.BETRIEB).toLowerCase())) {
        zooGefunden ||= art;
        console.log(`   ⭐ enthält "${CFG.BETRIEB}"`);
      }
    }
  }
  clearTimeout(ende);
  process.exit(0);
}

if (args.includes('--betrieb-probe')) {
  const s0 = load(); ladeZugang(s0);
  try { await erneuere(); } catch (e) { console.error('Kein Zugang:', e.message); process.exit(1); }

  const felder = (o, tiefe = 0) => {
    if (Array.isArray(o)) return o.length ? `[${o.length}× ${felder(o[0], tiefe + 1)}]` : '[]';
    if (o && typeof o === 'object') {
      const k = Object.keys(o);
      return tiefe > 2 ? `{${k.slice(0, 10).join(', ')}}` :
        '{' + k.slice(0, 14).map(n => `${n}: ${felder(o[n], tiefe + 1)}`).join(', ') + '}';
    }
    return typeof o;
  };

  console.log('Suche die Betriebsübersicht …\n');

  // Absichtlich ohne api(): dort werden 401 und 403 zu "AUTH" zusammengefasst,
  // und ein 404 sähe anders aus als ein 403. Genau dieser Unterschied sagt uns,
  // ob der Pfad falsch ist oder nur die Rechte fehlen.
  const roh = async (pfad) => {
    const res = await fetch(CFG.API + pfad, {
      headers: {
        Authorization: 'Bearer ' + zugang.token,
        Cookie: zugang.cookie || '',
        'User-Agent': CFG.USER_AGENT,
        'Accept': 'application/json',
        'Origin': 'https://unicacity.eu',
        'Referer': 'https://unicacity.eu/',
      },
    });
    let koerper = null;
    try { koerper = await res.json(); } catch { /* kein JSON */ }
    return { status: res.status, koerper };
  };

  let gefunden = null;
  const trefferListe = [];
  const statistik = {};
  for (const pfad of BETRIEB_PFADE) {
    try {
      const { status, koerper } = await roh(pfad);
      statistik[status] = (statistik[status] || 0) + 1;
      if (status === 200 && koerper) {
        console.log(`✅ ${status} ${pfad}`);
        console.log('   ' + felder(koerper).slice(0, 900) + '\n');
        gefunden ||= { pfad, daten: koerper };
        trefferListe.push([pfad, koerper]);
      } else {
        const grund = { 401: 'nicht angemeldet', 403: 'keine Rechte',
                        404: 'gibt es nicht', 500: 'Serverfehler' }[status] || '';
        console.log(`❌ ${status} ${pfad}${grund ? ' – ' + grund : ''}`);
      }
    } catch (e) {
      console.log(`❌ ${pfad} — ${e.message}`);
    }
  }

  // Was die Statuscodes über die API verraten
  if (gefunden) {
    // Wurde ein Wert mitgegeben, suchen wir genau den – als Zahl, als Text und
    // als Summe einer Liste. Sonst listen wir alles Zahlenartige auf.
    const gesucht = Number(args[args.indexOf('--betrieb-probe') + 1]);
    const suchen = Number.isFinite(gesucht);

    for (const [pfad, daten] of trefferListe) {
      const funde = [], summen = [], alles = [];
      const gesehen = new WeakSet();

      const geh = (o, weg) => {
        if (!o || typeof o !== 'object') return;
        if (gesehen.has(o)) return;      // Ringe im Datensatz abfangen
        gesehen.add(o);

        if (Array.isArray(o)) {
          // Summiert sich die Liste auf den gesuchten Wert?
          if (suchen) {
            const zahlen = o.map(x => typeof x === 'number' ? x : null).filter(x => x !== null);
            if (zahlen.length && Math.abs(zahlen.reduce((a, b) => a + b, 0) - gesucht) <= 1) {
              summen.push(`${weg} (Summe von ${zahlen.length} Zahlen)`);
            }
            // Auch Listen von Objekten: jedes Zahlenfeld einzeln aufsummieren
            const felder = new Set();
            for (const x of o) if (x && typeof x === 'object' && !Array.isArray(x)) {
              for (const [k, v] of Object.entries(x)) if (typeof v === 'number') felder.add(k);
            }
            for (const f of felder) {
              const summe = o.reduce((a, x) => a + (typeof x?.[f] === 'number' ? x[f] : 0), 0);
              if (Math.abs(summe - gesucht) <= 1) summen.push(`Summe von ${weg}[].${f} = ${summe}`);
            }
          }
          o.forEach((x, i) => geh(x, `${weg}[${i}]`));
          return;
        }

        for (const [k, v] of Object.entries(o)) {
          const pfadHier = `${weg}.${k}`;
          if (typeof v === 'number') {
            alles.push(`${pfadHier} = ${v}`);
            if (suchen && Math.abs(v - gesucht) <= 1) funde.push(`${pfadHier} = ${v}`);
          } else if (typeof v === 'string') {
            if (suchen && v.replace(/[^0-9]/g, '') === String(gesucht)) {
              funde.push(`${pfadHier} = "${v}"  (als Text)`);
            }
          } else geh(v, pfadHier);
        }
      };
      geh(daten, '');

      console.log(`\n=== ${pfad} ===`);
      if (suchen) {
        if (funde.length) {
          console.log(`🎯 ${gesucht} steht hier:`);
          for (const f of funde) console.log('   ' + f);
        }
        if (summen.length) {
          console.log(`🎯 ${gesucht} ergibt sich als Summe:`);
          for (const f of summen) console.log('   ' + f);
        }
        if (!funde.length && !summen.length) console.log(`   ${gesucht} kommt nicht vor.`);
      }
      console.log(`   (${alles.length} Zahlenfelder insgesamt)`);
      if (!suchen || (!funde.length && !summen.length)) {
        const auswahl = alles.filter(z => {
          const n = Number(z.split(' = ').pop());
          return n > 20 && n < 100_000;
        });
        console.log('   ' + (auswahl.slice(0, 60).join('\n   ') || '(keine passenden)'));
      }
    }

    if (!suchen) {
      console.log('\nTipp: Den gesuchten Wert direkt mitgeben, dann wird gezielt');
      console.log('gesucht – auch als Text und als Summe einer Liste:');
      console.log('   node --env-file=.env watcher.mjs --betrieb-probe 219');
    }
  }

  if (!gefunden) {
    console.log('\nAntworten: ' + Object.entries(statistik)
      .map(([k, v]) => `${v}× ${k}`).join(', '));
    if (statistik[404]) {
      console.log('Immerhin: ein 404 zeigt, dass unbekannte Pfade als solche');
      console.log('gemeldet werden. Die Adresse ist also schlicht eine andere.');
    } else if (statistik[401] || statistik[403]) {
      console.log('Alle Pfade werden abgewiesen, keiner als "gibt es nicht".');
      console.log('Die API antwortet unbekannten Pfaden also mit 401/403 – durch');
      console.log('Raten kommen wir nicht weiter, die echte Adresse muss her.');
    }
  }

  if (!gefunden) {
    console.log('\nKeine der Adressen hat geantwortet. Öffne die Seite');
    console.log('https://unicacity.eu/dashboard/businesses im Browser, drücke F12,');
    console.log('gehe auf "Netzwerk", lade neu und schau, welche Adresse mit /api/');
    console.log('abgefragt wird. Die dann eintragen: UC_BETRIEB_PFAD=/api/…');
    process.exit(1);
  }

  console.log(`\nBrauchbar: ${gefunden.pfad}`);
  const st = betriebStand(gefunden.daten);
  if (!st.gefunden) {
    console.log(`\n⚠️ Ein Betrieb namens "${CFG.BETRIEB}" kommt darin nicht vor.`);
    console.log('   Vorhandene Namen:');
    const namen = [];
    const suche = (o, t = 0) => {
      if (!o || t > 6) return;
      if (Array.isArray(o)) return o.forEach(x => suche(x, t + 1));
      if (typeof o !== 'object') return;
      const n = o.name ?? o.title ?? o.businessName;
      if (typeof n === 'string') namen.push(sauber(n));
      for (const v of Object.values(o)) suche(v, t + 1);
    };
    suche(gefunden.daten);
    console.log('   ' + ([...new Set(namen)].join(', ') || '(keine gefunden)'));
    console.log('\n   Passenden Namen eintragen: UC_BETRIEB=…');
  } else if (st.bestand === null) {
    console.log(`\n⚠️ "${st.name}" gefunden, aber kein bekanntes Bestandsfeld.`);
    console.log('   Der Eintrag sieht so aus:');
    console.log('   ' + felder(findeBetrieb(gefunden.daten, CFG.BETRIEB)).slice(0, 600));
    console.log('\n   Schick mir diese Zeile, dann ergänze ich das Feld.');
  } else {
    console.log(`\n✅ ${st.name}: angezeigt ${st.angezeigt}, entnehmbar ${st.bestand} von ${st.max}`);
    console.log(`   (Abzug ${CFG.BETRIEB_ABZUG}, Warnschwelle ${CFG.BETRIEB_SCHWELLE})`);
    if (gefunden.pfad !== BETRIEB_PFADE[0]) {
      console.log(`\n   Zum Festlegen in die .env: UC_BETRIEB_PFAD=${gefunden.pfad}`);
    }
  }
  process.exit(0);
}

if (args.includes('--gehalt')) {
  const st = load();
  const topf = auszahlungTopf(st);
  console.log(`Topf für Auszahlungen und Gehälter – Tag ${topf.tag}`);
  console.log(`  Zurücksetzung um ${String(CFG.AUSZAHLUNG_RESET_STD).padStart(2, '0')}:00 Uhr`);
  console.log(`  Grenze:  ${fmt(topf.limit)}`);
  console.log(`  Genutzt: ${fmt(topf.genutzt)}`);
  console.log(`  Frei:    ${fmt(topf.frei)}`);
  // Hier – anders als in Discord – mit Einzelposten, denn damit lässt sich
  // prüfen, ob die richtigen Kategorien gezählt werden.
  if (topf.buchungen.length) {
    console.table(topf.buchungen.map(b => ({
      Zeit: new Date(b.stamp).toLocaleTimeString('de-DE'),
      Kategorie: b.kategorie, Detail: b.detail, Betrag: fmt(b.betrag),
    })));
  } else console.log('\n  Heute wurde noch nichts entnommen.');
  console.log('\nGezählt werden Buchungen der Kategorien: ' + AUSZAHLUNG_KATEGORIEN.join(', '));
  console.log('Anpassbar über UC_AUSZAHLUNG_KATEGORIEN und UC_AUSZAHLUNG_LIMIT.');
  process.exit(0);
}

if (args.includes('--zuordnung')) {
  const st = load();
  const zu = ladeZuordnung();
  const eigen = zuordnungEigen();
  const wuerdenGepingt = onlineDiscordIds(st);

  if (!Object.keys(zu).length) {
    console.log('Keine Zuordnung eingetragen.');
    console.log('Im Discord: /zuordnen nutzer:@Name name:UC-Name');
    process.exit(0);
  }
  const zeilen = {};
  for (const [id, name] of Object.entries(zu)) {
    const treffer = Object.keys(st.spieler || {}).find(k => k.toLowerCase() === name.toLowerCase());
    zeilen[id] = {
      'UC-Name': name,
      'im Team gefunden': treffer ? (treffer === name ? 'ja' : `ja, als "${treffer}"`) : 'NEIN',
      Online: treffer ? (st.spieler[treffer].online ? 'ja' : 'nein') : '?',
      'wird gepingt': wuerdenGepingt.includes(id) ? 'ja' : 'nein',
      Quelle: eigen[id] ? '/zuordnen' : '.env',
    };
  }
  console.table(zeilen);
  console.log(`Bei "nur wer online ist" würden jetzt ${wuerdenGepingt.length} Leute gepingt.`);
  const fehlend = Object.values(zu).filter(n =>
    !Object.keys(st.spieler || {}).some(k => k.toLowerCase() === n.toLowerCase()));
  if (fehlend.length) {
    console.log(`\nNicht im Team gefunden: ${fehlend.join(', ')}`);
    console.log('Entweder Tippfehler, oder die Person war noch nie online, seit der');
    console.log('Watcher läuft. Im Team bekannt sind: ' +
      (Object.keys(st.spieler || {}).join(', ') || '(noch niemand)'));
  }
  process.exit(0);
}

if (args.includes('--discord-pruefe')) {
  const t = pruefeToken();
  console.log('Prüfung von UC_DISCORD_TOKEN (der Token selbst wird nicht angezeigt)\n');

  if (!t.gesetzt) {
    console.log('❌ UC_DISCORD_TOKEN ist leer oder steht nicht in der .env.');
    console.log('   Der Wert kommt aus dem Developer Portal → links "Bot" → "Reset Token".');
    process.exit(1);
  }

  const zeile = (ok, text) => console.log(`${ok ? '✅' : '❌'} ${text}`);
  zeile(!t.anfuehrungszeichen, t.anfuehrungszeichen
    ? 'Der Wert kommt mit Anführungszeichen an – die gehören nicht dazu.'
    : 'keine Anführungszeichen');
  zeile(!t.randLeerzeichen, t.randLeerzeichen
    ? 'Leerzeichen am Anfang oder Ende – entfernen.'
    : 'keine Leerzeichen am Rand');
  zeile(!t.leerzeichenInnen, t.leerzeichenInnen
    ? 'Leerzeichen oder Zeilenumbruch mitten im Wert – beim Kopieren zerrissen.'
    : 'keine Umbrüche im Wert');
  zeile(t.teile === 3, `${t.teile} durch Punkte getrennte Teile (ein Bot-Token hat 3)`);
  zeile(t.laenge >= 55 && t.laenge <= 100, `${t.laenge} Zeichen lang (üblich sind 60–75)`);

  if (t.nurZiffern) {
    console.log('\n❌ Der Wert besteht nur aus Ziffern. Das ist die Client-ID (die');
    console.log('   öffentliche Anwendungs-ID), nicht der Bot-Token.');
  }
  if (t.anwendungsId) {
    console.log(`\n✅ Der Token gehört zur Anwendung ${t.anwendungsId}.`);
    console.log('   Form ist in Ordnung. Wird er trotzdem abgelehnt (401/4004), wurde er');
    console.log('   inzwischen zurückgesetzt – dann im Developer Portal einen neuen holen.');
    process.exit(0);
  }

  console.log('\n❌ Aus dem ersten Teil lässt sich keine Anwendungs-ID lesen.');
  console.log('   Das ist kein Bot-Token. Häufigste Verwechslungen:');
  console.log('   • Client-ID (nur Ziffern) – falsch');
  console.log('   • Client-Secret (ein Block, ~32 Zeichen) – falsch');
  console.log('   • die Einladungs-URL – falsch');
  console.log('\n   Richtig: Developer Portal → deine Anwendung → links "Bot" →');
  console.log('   "Reset Token" → der angezeigte Wert (3 Teile, durch Punkte getrennt).');
  process.exit(1);
}

if (args.includes('--discord-test')) {
  if (!discordAktiv()) {
    console.error('UC_DISCORD_TOKEN ist nicht gesetzt – siehe DISCORD.md.');
    process.exit(1);
  }
  console.log('Registriere Befehle …');
  await discordStart(BEFEHLE, { ohneGateway: true });
  console.log('Schicke je eine Probemeldung …');
  await discordSende({
    ziel: 'chef', prio: 'default',
    titel: '🔔 Probe: Meldung für den Inhaber',
    text: 'Wenn du das siehst, kommen die Meldungen an, die nur dich betreffen ' +
          '(Kasse, Personal, Zugang, Technik).',
  });
  await discordSende({
    ziel: 'team', prio: 'default',
    titel: '🔔 Probe: Meldung fürs Team',
    text: 'Wenn das im Team-Kanal steht, sind die Betriebsmeldungen richtig ' +
          'eingerichtet (Lager, Lieferengpass, Ausschüttung, Vorfälle).',
  });
  if (process.env.UC_DISCORD_VORFALL_KANAL) {
    await discordSende({
      ziel: 'kanal', kanal: process.env.UC_DISCORD_VORFALL_KANAL, prio: 'default',
      titel: '🔔 Probe: Meldung für Vorfälle',
      text: 'Hier landen Vorfälle im Unternehmen, Kassenvorfälle und unbekannte ' +
            'Buchungen – ohne Kassenstand und ohne Namenslisten. Die vollständige ' +
            'Fassung bekommt nur der Inhaber.',
    });
    console.log('Gesendet. Prüfe alle drei Kanäle.');
  } else {
    console.log('Gesendet. Prüfe beide Kanäle – und dass im Team-Kanal *nur* die zweite steht.');
  }
  // Kurz warten, damit die Zustellung durch ist, dann Verbindung schließen.
  await new Promise(r => setTimeout(r, 1500));
  discordStop();
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

// Sucht die Wiki-Endpunkte, die Anmeldung verlangen. Einmalig zum Erkunden.
if (args.includes('--notion')) {
  const st = load();
  if (!CFG.NOTION_TOKEN) { console.error('UC_NOTION_TOKEN ist nicht gesetzt.'); process.exit(1); }
  console.log('Wiki wird abgerufen …');
  const artikel = await holeWiki();
  console.log(`${Object.keys(artikel).length} Artikel. Notion wird verglichen …\n`);
  try {
    const e = await vergleicheNotion(st, artikel);
    const zeig = (t, l, f) => { console.log(`\n${t}: ${l.length}`); l.slice(0, 40).forEach(x => console.log('   ' + f(x))); };
    zeig('Fehlen in Notion', e.fehlen, a => `${a.kategorie} · ${a.titel}  →  ${wikiLink(a)}`);
    zeig('Veraltet', e.veraltet, a => `${a.kategorie} · ${a.titel}  (Wiki ${a.updatedAt.slice(0,10)}, Notion ${String(a.notionStand).slice(0,10)})`);

    if (e.katFehlen.length) zeig('Kategorien fehlen', e.katFehlen, k => k);
  } catch (err) {
    console.error(
      err.message === 'NOTION_TOKEN' ? '❌ Zugangsschlüssel abgelehnt.' :
      err.message === 'NOTION_FREIGABE' ? '❌ Seite ist für die Integration nicht freigegeben.' :
      '❌ ' + err.message);
    process.exit(1);
  }
  process.exit(0);
}

if (args.includes('--wiki-probe')) {
  const s0 = load(); ladeZugang(s0);
  try { await erneuere(); } catch (e) { console.error('Kein Zugang:', e.message); process.exit(1); }

  const kandidaten = [
    '/api/wiki', '/api/wiki/pages', '/api/wiki/articles', '/api/wiki/index',
    '/api/wiki/recent', '/api/wiki/changes', '/api/wiki/updates',
    '/api/wiki/articles?categoryId=16', '/api/wiki/articles?category=befehlsliste',
    '/api/wiki/categories/befehlsliste', '/api/wiki/category/16',
    '/api/wiki/article/arena-108', '/api/wiki/articles/arena-108',
  ];

  const felder = (o, tiefe = 0) => {
    if (Array.isArray(o)) return o.length ? `[${o.length}× ${felder(o[0], tiefe + 1)}]` : '[]';
    if (o && typeof o === 'object') {
      const k = Object.keys(o);
      return tiefe > 1 ? `{${k.slice(0, 8).join(', ')}}` :
        '{' + k.slice(0, 12).map(n => `${n}: ${felder(o[n], tiefe + 1)}`).join(', ') + '}';
    }
    return typeof o;
  };

  for (const pfad of kandidaten) {
    try {
      const d = await api(pfad);
      console.log(`\n✅ ${pfad}`);
      console.log('   ' + felder(d).slice(0, 600));
    } catch (e) {
      console.log(`❌ ${pfad} — ${e.message}`);
    }
  }
  const s1 = load(); sichereZugang(s1); save(s1);
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
      e.message === 'REFRESH_OHNE_TOKEN' ? '❌ Erneuerung lieferte kein Token – Cookie abgelaufen?' :
      e.message === 'AUTH' ? '❌ Zugang abgelehnt (401/403) – Cookie abgelaufen.' :
      e.message.startsWith('HTTP') ? `❌ Seite antwortet nicht (${e.message}) – meist der Server selbst, geht von allein vorbei.` :
      '❌ Fehler: ' + e.message);
    process.exit(1);
  }
  process.exit(0);
}

info(`UC-Watcher läuft – Intervall ${CFG.INTERVALL_MS / 1000}s, Zustand: ${CFG.STATE_FILE}`);

if (discordAktiv()) {
  // Schlägt die Anmeldung fehl, läuft der Watcher trotzdem weiter – die
  // Überwachung ist wichtiger als der Bot.
  discordStart(BEFEHLE).catch(e => console.error('Discord-Start fehlgeschlagen:', e.message));
} else {
  info('Discord nicht eingerichtet (UC_DISCORD_TOKEN fehlt) – Meldungen gehen nur an ntfy.');
}

// systemd schickt beim Neustart SIGTERM. Dann die Gateway-Verbindung ordentlich
// schließen, statt sie abreißen zu lassen.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { info('Beende …'); discordStop(); process.exit(0); });
}

await durchlauf();
setInterval(() => durchlauf().catch(e => console.error('Fehler:', e)), CFG.INTERVALL_MS);
