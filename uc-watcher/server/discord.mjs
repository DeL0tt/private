/**
 * Discord-Anbindung für den UC-Watcher.
 *
 * Bewusst ohne Bibliothek: Node 22 bringt fetch und WebSocket mit, und das
 * Projekt hat bisher keine einzige Abhängigkeit. Das soll so bleiben, damit
 * auf dem Server weiterhin "git pull" und ein Neustart genügen – kein
 * npm install, keine Paketpflege.
 *
 * Zwei Richtungen:
 *   raus  – Meldungen als Embed in einen Kanal oder als DM (REST)
 *   rein  – Slash-Commands über das Gateway (WebSocket)
 *
 * Für Slash-Commands braucht das Gateway keine Intents (0). Wir lesen also
 * keine Nachrichten mit, sondern bekommen nur die Befehle, die an unseren
 * Bot gerichtet sind.
 */

import fs from 'node:fs';

// Die Adresse ist überschreibbar, damit die Zustellung gegen einen lokalen
// Server geprüft werden kann, ohne echte Nachrichten zu verschicken.
const API = process.env.UC_DISCORD_API || 'https://discord.com/api/v10';

// Hier landen die über /melden und /zuordnen gesetzten Einstellungen.
const REGELN_DATEI = process.env.UC_DISCORD_REGELN || './uc-watcher-regeln.json';

const CFG = {
  TOKEN:      process.env.UC_DISCORD_TOKEN || '',
  APP_ID:     process.env.UC_DISCORD_APP_ID || '',
  GUILD:      process.env.UC_DISCORD_GUILD || '',
  TEAM_KANAL:    process.env.UC_DISCORD_TEAM_KANAL || '',
  CHEF_KANAL:    process.env.UC_DISCORD_CHEF_KANAL || '',
  VORFALL_KANAL: process.env.UC_DISCORD_VORFALL_KANAL || '',
  // Kanal, in dem Befehlsantworten für alle sichtbar sind statt nur für den
  // Fragenden. Anderswo bleibt jede Antwort privat.
  BEFEHL_KANAL:  process.env.UC_DISCORD_BEFEHL_KANAL || '',
  CHEF_ID:    process.env.UC_DISCORD_CHEF_ID || '',
};

const log  = (...a) => process.env.UC_DEBUG && console.log(new Date().toISOString(), 'discord:', ...a);
const info = (...a) => console.log(new Date().toISOString(), 'discord:', ...a);

export const discordAktiv = () => !!CFG.TOKEN;

// Die Anwendungs-ID steckt im Bot-Token: der erste Teil vor dem Punkt ist die
// ID in base64. Damit muss man sie nicht zusätzlich in die .env schreiben.
function appId() {
  if (CFG.APP_ID) return CFG.APP_ID;
  try {
    const id = Buffer.from(CFG.TOKEN.split('.')[0], 'base64url').toString('utf8');
    if (/^\d{15,25}$/.test(id)) return id;
  } catch { /* fällt unten durch */ }
  return '';
}

/* ========================= REGELSPEICHER ========================= */

/**
 * Was im Discord eingestellt wird, steht in einer eigenen Datei, nicht im
 * großen Zustand. Grund: durchlauf() lädt den Zustand am Anfang und schreibt
 * ihn am Ende zurück. Eine Einstellung, die in der Zwischenzeit gesetzt wird,
 * wäre mit der älteren Kopie wieder verschwunden. Eine eigene Datei kann das
 * nicht passieren.
 *
 * Aufbau: {
 *   regeln:    { '<themenanfang>': {…} },
 *   zuordnung: { '<discordId>': 'UC-Name' },
 *   rechte:    { '<befehl>': { rollen: [...], nutzer: [...] } }
 * }
 */
let cache = { stand: -1, inhalt: null };

function lade() {
  try {
    const stand = fs.statSync(REGELN_DATEI).mtimeMs;
    if (stand === cache.stand && cache.inhalt) return cache.inhalt;
    const rohdaten = JSON.parse(fs.readFileSync(REGELN_DATEI, 'utf8'));
    // Ältere Dateien enthielten die Regeln ohne Umschlag, direkt als
    // Themen-Zuordnung. Die werden weiter gelesen.
    const inhalt = rohdaten.regeln || rohdaten.zuordnung || rohdaten.rechte
      ? { regeln: rohdaten.regeln || {}, zuordnung: rohdaten.zuordnung || {},
          rechte: rohdaten.rechte || {} }
      : { regeln: rohdaten, zuordnung: {}, rechte: {} };
    cache = { stand, inhalt };
    return inhalt;
  } catch {
    return { regeln: {}, zuordnung: {}, rechte: {} };   // noch nie etwas eingestellt
  }
}

function speichere(inhalt) {
  const tmp = REGELN_DATEI + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(inhalt, null, 2));
  fs.renameSync(tmp, REGELN_DATEI);
  cache = { stand: -1, inhalt: null };      // beim nächsten Lesen neu holen
}

export const ladeRegeln = () => lade().regeln;
export const speichereRegeln = (regeln) => speichere({ ...lade(), regeln });

/**
 * Discord-Konto -> Name in UnicaCity. Was über /zuordnen gesetzt wurde, hat
 * Vorrang vor der Liste aus UC_DISCORD_SPIELER, damit man eine falsche
 * Zeile aus der .env im Discord überschreiben kann, ohne sie anzufassen.
 */
export function ladeZuordnung() {
  const ausEnv = Object.fromEntries(
    (process.env.UC_DISCORD_SPIELER || '').split(',')
      .map(e => e.split(':').map(t => t.trim()))
      .filter(([id, name]) => id && name));
  return { ...ausEnv, ...lade().zuordnung };
}

export const speichereZuordnung = (zuordnung) => speichere({ ...lade(), zuordnung });

/** Nur die im Discord gesetzten Einträge – für „aus der .env" vs. „von dir". */
export const zuordnungEigen = () => lade().zuordnung;

/**
 * Wer darf welchen sonst dem Inhaber vorbehaltenen Befehl benutzen?
 * Vergeben wird an Rollen (gilt für alle, die sie tragen) oder an einzelne
 * Konten. Der Inhaber darf immer alles.
 */
export const ladeRechte = () => lade().rechte;
export const speichereRechte = (rechte) => speichere({ ...lade(), rechte });

export function darfNutzen(befehl, { istChef, nutzerId, rollen = [] }) {
  if (istChef) return true;
  const r = ladeRechte()[befehl];
  if (!r) return false;
  if ((r.nutzer || []).includes(String(nutzerId))) return true;
  return (r.rollen || []).some(rolle => rollen.map(String).includes(String(rolle)));
}

/* ========================= EMPFÄNGER ========================= */

/**
 * Wer bekommt welche Meldung?
 *
 * Grundregel: Betriebliches, auf das das Team reagieren kann, geht in den
 * Team-Kanal. Geld, Personalstand, Arbeitszeiten und alles Technische sind
 * Sache des Inhabers – das steht in keinem geteilten Kanal.
 *
 * Verglichen wird der Anfang des Themas, weil viele Themen eine laufende
 * Nummer anhängen ('event_...', 'ausschuettung_std_3').
 */
const TEAM_THEMEN = [
  'lager',                   // Bestand niedrig – das Team kann nachfüllen
  'preissprung',             // Lieferengpass – betrifft den Einkauf
  'pausiert_trotz_online',   // Firma steht – jemand muss sie anwerfen
  'ausschuettung_std_',      // Zwischenstand bis zur Ausschüttung
  'ausschuettung_faellig',   // Ziel erreicht
  'event_',                  // Vorfall im Unternehmen
  'betrieb_',                // Zoohandlung leer oder knapp – da kann jeder ran
  'nachkauf_aus',            // ohne Nachkauf läuft das Lager leer
];

// 'lagerverlust_' beginnt mit 'lager', meint aber einen Diebstahlverdacht samt
// Namen der Anwesenden – das darf nie im Team-Kanal landen. Solche Ausnahmen
// werden vor der Team-Liste geprüft.
const NUR_CHEF = ['lagerverlust_', 'personal_'];

// Vorfälle bekommen einen eigenen Kanal, wenn einer eingerichtet ist. Sie
// gehen zusätzlich an den Inhaber, weil dort die vollständige Fassung mit
// Kassenstand und Anwesenheitsliste steht – im geteilten Kanal die gekürzte.
// Ohne UC_DISCORD_VORFALL_KANAL bleibt alles beim Inhaber.
const VORFALL_THEMEN = ['event_', 'vorfall_'];

// Wo von Haus aus gepingt wird. Ein Vorfall hat eine Frist und eine pausierte
// Firma kostet laufend Geld – beides muss jemanden erreichen, der gerade
// spielen ist. Gepingt wird nur, wer per /zuordnen bekannt ist; ohne
// Zuordnung bleibt es still. Über /melden änderbar.
const PING_VOREINSTELLUNG = {
  'event_': 'online',
  'pausiert_trotz_online': 'online',
  'betrieb_leer': 'online',        // leer heißt: jemand muss jetzt nachfüllen
};

const standardPing = (t) => {
  const treffer = Object.keys(PING_VOREINSTELLUNG)
    .filter(k => t.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return treffer ? { ping: PING_VOREINSTELLUNG[treffer] } : {};
};

// Mit UC_DISCORD_TEAM_THEMEN lässt sich die Team-Liste komplett ersetzen, etwa
// auf 'lager,event_', wenn dem Team weniger zugestellt werden soll.
const TEAM_LISTE = (process.env.UC_DISCORD_TEAM_THEMEN || '').trim()
  ? process.env.UC_DISCORD_TEAM_THEMEN.split(',').map(t => t.trim()).filter(Boolean)
  : TEAM_THEMEN;

/**
 * Alle Meldungsarten mit sprechendem Namen. Der Schlüssel ist der Anfang des
 * Themas, wie push() es vergibt. Die Liste ist das, was /melden zur Auswahl
 * anbietet – Discord erlaubt höchstens 25 Einträge.
 */
export const THEMEN = [
  ['lagerverlust_',          'Plötzlicher Lagerverlust (mit Namen)'],
  ['lager',                  'Lagerbestand niedrig'],
  ['nachkauf_aus',           'Nachkauf setzt aus'],
  ['betrieb_leer',           'Betrieb ist leer (Zoohandlung)'],
  ['betrieb_knapp',          'Betrieb wird knapp (Zoohandlung)'],
  ['preissprung',            'Lieferengpass, Einkauf teurer'],
  ['pausiert_trotz_online',  'Firma pausiert, obwohl jemand online ist'],
  ['ausschuettung_std_',     'Ausschüttung: Zwischenstand'],
  ['ausschuettung_faellig',  'Ausschüttung ist fällig'],
  ['ausschuettung_',         'Ausschüttung erfolgt (mit Betrag)'],
  ['event_',                 'Vorfall im Unternehmen'],
  ['vorfall_',               'Kassenvorfall (mit Betrag und Namen)'],
  ['personal_',              'Personal abgeworben oder unvollständig'],
  ['loehne',                 'Löhne nicht bezahlt'],
  ['miete',                  'Mietrückstand'],
  ['tagesbericht_',          'Tagesbericht mit Onlinezeiten'],
  ['auth',                   'Zugang abgelaufen'],
  ['apiweg',                 'UnicaCity nicht erreichbar'],
  ['wiki_',                  'Wiki-Änderungen'],
  ['notion_zugang',          'Notion nicht erreichbar'],
  ['notion_',                'Notion-Abgleich'],
  ['selftest',               'Probemeldung'],
];

export const themaName = (schluessel) =>
  THEMEN.find(([k]) => k === schluessel)?.[1] || schluessel;

/**
 * Bestimmt, wer eine Meldung bekommt und ob dabei gepingt wird.
 *
 * Reihenfolge: eine ausdrücklich über /melden gesetzte Regel gewinnt, sonst
 * gelten die Voreinstellungen. Beim Vergleich zählt der längste passende
 * Anfang, damit 'ausschuettung_faellig' nicht von 'ausschuettung_' verdeckt
 * wird.
 *
 * regeln: { '<themenanfang>': { ziel, kanal, ping } } – aus dem Zustand.
 */
export function empfaenger(thema, regeln = {}) {
  const t = String(thema || '');

  const treffer = Object.keys(regeln || {})
    .filter(k => t.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (treffer) return { ...regeln[treffer] };

  if (NUR_CHEF.some(x => t.startsWith(x))) return { ziel: 'chef' };
  if (CFG.VORFALL_KANAL && VORFALL_THEMEN.some(x => t.startsWith(x))) {
    return { ziel: 'kanal', kanal: CFG.VORFALL_KANAL, auchChef: true, ...standardPing(t) };
  }
  return { ziel: TEAM_LISTE.some(x => t.startsWith(x)) ? 'beide' : 'chef', ...standardPing(t) };
}

/** Beschreibt eine Regel in einem Satz, für die Anzeige in Discord. */
export function regelText(regel) {
  const wohin = {
    chef: 'nur an dich', team: 'nur ins Team', beide: 'an dich und ins Team',
    kanal: regel.kanal
      ? `in <#${regel.kanal}>${regel.auchChef ? ' und an dich' : ''}`
      : 'in einen Kanal (fehlt!)',
    aus: 'gar nicht',
  }[regel.ziel] || regel.ziel;
  const ping = !regel.ping || regel.ping === 'keiner' ? ''
    : regel.ping === 'online' ? ' · pingt, wer gerade ingame online ist'
    : regel.ping === 'everyone' ? ' · pingt @everyone'
    : regel.ping === 'here' ? ' · pingt @here'
    : ` · pingt <@&${regel.ping}>`;
  const takt = regel.takt === undefined ? ''
    : regel.takt === 0 ? ' · kein Zwischenstand'
    : regel.takt === 1 ? ' · stündlich'
    : ` · alle ${regel.takt} Std.`;
  const nachfassen = regel.erinnerung === undefined ? ''
    : regel.erinnerung === 0 ? ' · ohne Nachfassen'
    : ` · fasst nach ${regel.erinnerung} Min. nach`;
  const ruhe = regel.wiederholung === undefined ? ''
    : regel.wiederholung >= 1440 ? ' · höchstens einmal am Tag'
    : regel.wiederholung >= 60 ? ` · frühestens nach ${regel.wiederholung / 60} Std. wieder`
    : ` · frühestens nach ${regel.wiederholung} Min. wieder`;
  return wohin + ping + takt + nachfassen + ruhe;
}

/**
 * Beschreibt den eingetragenen Token, ohne ihn auszugeben. Gedacht für den
 * Fall, dass Discord ihn ablehnt und man wissen will, warum.
 */
export function pruefeToken() {
  const roh = process.env.UC_DISCORD_TOKEN ?? '';
  const t = roh.trim();
  const teile = t.split('.');
  let id = '';
  try { id = Buffer.from(teile[0], 'base64url').toString('utf8'); } catch { /* bleibt leer */ }

  return {
    gesetzt: !!t,
    laenge: t.length,
    teile: teile.length,
    anfuehrungszeichen: /^["']|["']$/.test(t),
    // Leerzeichen am Rand fängt trim() ab; mittendrin deutet auf einen
    // Zeilenumbruch beim Kopieren hin.
    leerzeichenInnen: /\s/.test(t),
    randLeerzeichen: roh !== t,
    anwendungsId: /^\d{15,25}$/.test(id) ? id : '',
    nurZiffern: /^\d+$/.test(t),
  };
}

/* ========================= REST ========================= */

// Discord bremst bei zu vielen Anfragen mit 429 und sagt dabei, wie lange man
// warten soll. Einmal warten und wiederholen reicht in der Praxis.
async function rest(pfad, methode = 'GET', koerper, zweiterVersuch = false) {
  const res = await fetch(API + pfad, {
    method: methode,
    headers: {
      Authorization: 'Bot ' + CFG.TOKEN,
      'Content-Type': 'application/json',
      'User-Agent': 'UC-Watcher (https://github.com/DeL0tt/private, 3.2)',
    },
    body: koerper === undefined ? undefined : JSON.stringify(koerper),
  });

  if (res.status === 429 && !zweiterVersuch) {
    const wie = await res.json().catch(() => ({}));
    const warten = Math.min((wie.retry_after || 1) * 1000, 10_000);
    log('429, warte', warten, 'ms');
    await new Promise(r => setTimeout(r, warten));
    return rest(pfad, methode, koerper, true);
  }
  if (!res.ok) {
    // Der Token darf nie im Log landen, die Fehlerantwort von Discord enthält
    // ihn auch nicht – der Pfad ist unbedenklich.
    const hinweis =
      res.status === 401 ? ' — der Token wird abgelehnt, siehe --discord-pruefe'
      : res.status === 403 ? ' — der Bot darf in diesem Kanal nicht schreiben'
      : res.status === 404 ? ' — diesen Kanal gibt es nicht, Kanal-ID prüfen'
      : '';
    throw new Error(`Discord ${res.status} bei ${methode} ${pfad}${hinweis}: ` +
      (await res.text().catch(() => '')).slice(0, 300));
  }
  return res.status === 204 ? null : res.json();
}

// DM-Kanäle wechseln nicht, also einmal öffnen und merken.
let dmKanal = '';
async function chefKanal() {
  if (CFG.CHEF_KANAL) return CFG.CHEF_KANAL;
  if (!CFG.CHEF_ID) return '';
  if (dmKanal) return dmKanal;
  const k = await rest('/users/@me/channels', 'POST', { recipient_id: CFG.CHEF_ID });
  dmKanal = k.id;
  return dmKanal;
}

/* ========================= AUSGABE ========================= */

const FARBE = {
  urgent:  0xd9342b,   // rot
  high:    0xe8a33d,   // orange
  default: 0x4b7bec,   // blau
  low:     0x7f8c8d,   // grau
  min:     0x7f8c8d,
};

// Discord begrenzt eine Embed-Beschreibung auf 4096 Zeichen. Unsere längsten
// Meldungen (Notion-Abgleich mit Titelliste) können das reißen.
const kappen = (t, max = 4000) =>
  t.length <= max ? t : t.slice(0, max - 20) + '\n… (gekürzt)';

function embed(titel, text, prio, fuss) {
  return {
    title: kappen(titel, 250),
    description: kappen(text),
    color: FARBE[prio] ?? FARBE.default,
    timestamp: new Date().toISOString(),
    ...(fuss ? { footer: { text: fuss } } : {}),
  };
}

// Ein Ping steht als Text über dem Embed – in Embeds selbst benachrichtigt
// Discord niemanden. allowed_mentions muss es ausdrücklich erlauben, sonst
// steht die Erwähnung nur da, ohne zu klingeln.
function pingTeile(ping, nutzer) {
  if (!ping || ping === 'keiner') return {};

  // Nur die anpingen, die gerade in UnicaCity online sind. Wer nicht spielt,
  // kann ohnehin nichts tun und soll nicht aus dem Feierabend geholt werden.
  // Ist niemand online, geht die Meldung ohne Ping raus.
  if (ping === 'online') {
    const ids = (nutzer || []).map(String).slice(0, 100);   // Discord erlaubt 100
    if (!ids.length) return {};
    return {
      content: ids.map(id => `<@${id}>`).join(' '),
      allowed_mentions: { users: ids },
    };
  }

  if (ping === 'everyone') return { content: '@everyone', allowed_mentions: { parse: ['everyone'] } };
  if (ping === 'here')     return { content: '@here',     allowed_mentions: { parse: ['everyone'] } };
  return { content: `<@&${ping}>`, allowed_mentions: { roles: [String(ping)] } };
}

async function inKanal(kanal, titel, text, prio, fuss, ping, pingNutzer) {
  if (!kanal) return;
  try {
    await rest(`/channels/${kanal}/messages`, 'POST',
      { embeds: [embed(titel, text, prio, fuss)], ...pingTeile(ping, pingNutzer) });
  } catch (e) { console.error('  Discord-Meldung fehlgeschlagen:', e.message); }
}

/**
 * Verschickt eine Meldung an die vorgesehenen Empfänger.
 *
 * ziel: 'chef'  – nur an dich (DM oder Chef-Kanal)
 *       'team'  – nur in den Team-Kanal
 *       'beide' – an beide, das Team bekommt teamText/teamTitel, falls gesetzt
 */
export async function discordSende({ ziel, kanal, auchChef, ping, pingNutzer, titel, text,
                                     prio = 'high', teamTitel, teamText }) {
  if (!discordAktiv() || ziel === 'aus') return;

  if (ziel === 'chef' || ziel === 'beide' || (ziel === 'kanal' && auchChef)) {
    // Geht die Meldung in einen eigenen Kanal, darf dort auch gepingt werden.
    // In einer DM wäre ein Ping sinnlos: sie erreicht ohnehin nur dich, und
    // @everyone gibt es in einer DM nicht.
    const eigenerKanal = !!CFG.CHEF_KANAL;
    await inKanal(await chefKanal(), titel, text, prio,
                  'nur für den Firmeninhaber', eigenerKanal ? ping : undefined, pingNutzer);
  }
  if (ziel === 'team' || ziel === 'beide') {
    await inKanal(CFG.TEAM_KANAL, teamTitel || titel, teamText || text, prio,
                  undefined, ping, pingNutzer);
  }
  if (ziel === 'kanal') {
    // Ein frei gewählter Kanal bekommt die Team-Fassung: dort können Leute
    // mitlesen, die nicht der Inhaber sind.
    await inKanal(kanal, teamTitel || titel, teamText || text, prio,
                  undefined, ping, pingNutzer);
  }
}

/* ========================= SLASH-COMMANDS ========================= */

// Die Befehle werden je Server registriert, nicht global: das gilt sofort,
// während globale Befehle bis zu eine Stunde brauchen.
export async function registriereBefehle(befehle) {
  const app = appId();
  if (!app) {
    throw new Error(
      'Aus dem Token lässt sich keine Anwendungs-ID lesen. Das ist fast immer ein ' +
      'falscher Wert in UC_DISCORD_TOKEN – etwa die Client-ID oder das Client-Secret ' +
      'statt des Bot-Tokens. Prüfen mit: node --env-file=.env watcher.mjs --discord-pruefe');
  }
  const liste = Object.entries(befehle).map(([name, b]) => ({
    name,
    description: b.beschreibung.slice(0, 100),
    type: 1,
    ...(b.optionen ? { options: b.optionen } : {}),
  }));
  const pfad = CFG.GUILD
    ? `/applications/${app}/guilds/${CFG.GUILD}/commands`
    : `/applications/${app}/commands`;
  await rest(pfad, 'PUT', liste);
  info(`${liste.length} Befehle registriert${CFG.GUILD ? ' (Server ' + CFG.GUILD + ')' : ' (global)'}`);
}

async function antworte(interaktion, inhalt, nurFuerDenFragenden) {
  const app = appId();
  const daten = typeof inhalt === 'string'
    ? { content: kappen(inhalt, 1900) }
    : { embeds: [inhalt] };
  if (nurFuerDenFragenden) daten.flags = 64;          // 64 = nur sichtbar für den Aufrufer
  await rest(`/webhooks/${app}/${interaktion.token}/messages/@original`, 'PATCH', daten);
}

// Eine Antwort muss binnen drei Sekunden raus. Da unsere Befehle die
// UnicaCity-API abfragen, sagen wir erst "arbeite dran" und liefern nach.
async function aufschieben(interaktion, nurFuerDenFragenden) {
  await rest(`/interactions/${interaktion.id}/${interaktion.token}/callback`, 'POST',
    { type: 5, ...(nurFuerDenFragenden ? { data: { flags: 64 } } : {}) });
}

/**
 * Beantwortet die Vorschlagsliste, während jemand tippt. Discord erwartet die
 * Antwort binnen drei Sekunden und nimmt höchstens 25 Einträge.
 */
export async function schlageVor(interaktion, befehle) {
  const b = befehle[interaktion.data?.name];
  const offen = (interaktion.data?.options || []).find(o => o.focused);
  if (!b?.vorschlaege || !offen) return;

  let choices = [];
  try {
    choices = (await b.vorschlaege(offen.name, String(offen.value || ''))) || [];
  } catch (e) { console.error('  Vorschläge fehlgeschlagen:', e.message); }
  log(`Vorschläge für ${offen.name}: ${choices.length}`);

  await rest(`/interactions/${interaktion.id}/${interaktion.token}/callback`, 'POST',
    { type: 8, data: { choices: choices.slice(0, 25) } }).catch(e => log('Vorschlag:', e.message));
}

// Exportiert, damit die Rechteprüfung ohne echtes Gateway geprüft werden kann.
export async function fuehreAus(interaktion, befehle) {
  const name = interaktion.data?.name;
  const b = befehle[name];
  if (!b) return;

  const nutzer = interaktion.member?.user || interaktion.user || {};
  const rollen = interaktion.member?.roles || [];
  const istChef = !!CFG.CHEF_ID && nutzer.id === CFG.CHEF_ID;
  // Antworten sind privat – außer der Befehl ist dafür freigegeben und wird im
  // Befehlskanal benutzt. Dann liest das ganze Team mit, was gewollt ist.
  const imBefehlKanal = !!CFG.BEFEHL_KANAL && interaktion.channel_id === CFG.BEFEHL_KANAL;
  const oeffentlich = !!b.oeffentlich && imBefehlKanal;
  const heimlich = !oeffentlich;

  // Ein vorbehaltener Befehl lässt sich per /rechte an Rollen oder einzelne
  // Konten weitergeben – außer er ist ausdrücklich nicht übertragbar.
  const darf = (welcher) => befehle[welcher]?.nichtUebertragbar
    ? istChef
    : darfNutzen(welcher, { istChef, nutzerId: nutzer.id, rollen });

  await aufschieben(interaktion, heimlich);

  if (b.nurChef && !darf(name)) {
    await antworte(interaktion,
      b.nichtUebertragbar
        ? '🔒 Diesen Befehl kann nur der Firmeninhaber benutzen.'
        : '🔒 Dafür fehlen dir die Rechte. Der Firmeninhaber kann sie mit ' +
          '`/rechte` vergeben.', heimlich);
    return;
  }

  try {
    const optionen = {};
    for (const o of interaktion.data?.options || []) optionen[o.name] = o.value;
    const ergebnis = await b.ausfuehren({ istChef, nutzer, rollen, optionen, darf, oeffentlich });
    await antworte(interaktion, ergebnis, heimlich);
    log('Befehl', name, 'von', nutzer.username || nutzer.id);
  } catch (e) {
    console.error('  Befehl', name, 'fehlgeschlagen:', e.message);
    await antworte(interaktion,
      '❌ Das hat nicht funktioniert: ' + e.message, heimlich);
  }
}

/* ========================= GATEWAY ========================= */

let ws = null, herzschlag = null, folge = null, sitzung = '', fortsetzUrl = '';
let aufgeben = false, versuche = 0;

export function discordStop() {
  aufgeben = true;
  clearInterval(herzschlag);
  try { ws?.close(1000); } catch { /* egal */ }
}

export function verbinde(befehle) {
  if (!discordAktiv() || aufgeben) return;

  const url = (fortsetzUrl || 'wss://gateway.discord.gg') + '/?v=10&encoding=json';
  ws = new WebSocket(url);

  const senden = (op, d) => { try { ws.send(JSON.stringify({ op, d })); } catch { /* gleich weg */ } };

  ws.addEventListener('open', () => log('Gateway verbunden'));

  ws.addEventListener('message', ev => {
    let p; try { p = JSON.parse(ev.data); } catch { return; }
    if (p.s !== null && p.s !== undefined) folge = p.s;

    switch (p.op) {
      case 10:                                        // Hello
        clearInterval(herzschlag);
        herzschlag = setInterval(() => senden(1, folge), p.d.heartbeat_interval);
        if (sitzung && fortsetzUrl) {
          senden(6, { token: CFG.TOKEN, session_id: sitzung, seq: folge });
        } else {
          // intents 0: wir lesen nichts mit, uns erreichen nur unsere Befehle.
          senden(2, {
            token: CFG.TOKEN, intents: 0,
            properties: { os: 'linux', browser: 'uc-watcher', device: 'uc-watcher' },
          });
        }
        break;

      case 0:                                         // Dispatch
        if (p.t === 'READY') {
          versuche = 0;
          sitzung = p.d.session_id;
          fortsetzUrl = p.d.resume_gateway_url || '';
          info(`angemeldet als ${p.d.user?.username} – Befehle stehen bereit`);
        } else if (p.t === 'RESUMED') {
          versuche = 0;
          log('Sitzung fortgesetzt');
        } else if (p.t === 'INTERACTION_CREATE' && p.d?.type === 2) {
          fuehreAus(p.d, befehle).catch(e => console.error('  Interaktion:', e.message));
        } else if (p.t === 'INTERACTION_CREATE' && p.d?.type === 4) {
          // Jemand tippt in einem Feld mit Vorschlagsliste.
          schlageVor(p.d, befehle).catch(e => log('Vorschläge:', e.message));
        }
        break;

      case 7:                                         // Discord bittet um Neuverbindung
        log('Neuverbindung angefordert');
        try { ws.close(4900); } catch { /* egal */ }
        break;

      case 9:                                         // Sitzung ungültig – von vorn
        log('Sitzung ungültig, melde neu an');
        sitzung = ''; fortsetzUrl = '';
        try { ws.close(4900); } catch { /* egal */ }
        break;
    }
  });

  ws.addEventListener('error', e => log('Gateway-Fehler:', e.message || e.type));

  ws.addEventListener('close', ev => {
    clearInterval(herzschlag);
    if (aufgeben) return;

    // 4004 = Token falsch. Dann hilft kein Wiederholen, das muss ein Mensch
    // richten – also nicht endlos gegen die Wand laufen.
    if (ev.code === 4004) {
      console.error('Discord lehnt den Token ab (4004) – UC_DISCORD_TOKEN prüfen. Bot bleibt aus.');
      aufgeben = true;
      return;
    }
    // Bei diesen Codes ist die Sitzung nicht fortsetzbar.
    if ([4007, 4009].includes(ev.code)) { sitzung = ''; fortsetzUrl = ''; }

    const wartezeit = Math.min(1000 * 2 ** versuche++, 60_000);
    info(`Gateway getrennt (${ev.code}) – neuer Versuch in ${Math.round(wartezeit / 1000)}s`);
    setTimeout(() => verbinde(befehle), wartezeit);
  });
}

/**
 * Startet den Bot: Befehle registrieren, dann Gateway verbinden.
 *
 * ohneGateway: nur registrieren und senden, keine Dauerverbindung. Das braucht
 * der Probelauf über --discord-test, der sich gleich wieder beendet.
 */
export async function discordStart(befehle, { ohneGateway = false } = {}) {
  if (!discordAktiv()) return false;
  if (!CFG.CHEF_ID && !CFG.CHEF_KANAL) {
    console.warn('discord: weder UC_DISCORD_CHEF_ID noch UC_DISCORD_CHEF_KANAL gesetzt – ' +
                 'Chef-Meldungen können nicht zugestellt werden.');
  }
  try {
    await registriereBefehle(befehle);
  } catch (e) {
    console.error('discord: Befehle konnten nicht registriert werden:', e.message);
  }
  if (!ohneGateway) verbinde(befehle);
  return true;
}
