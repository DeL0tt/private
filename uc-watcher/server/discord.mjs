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

// Mindestabstand zwischen zwei Befehlen derselben Person. Jeder Befehl löst
// Abfragen bei UnicaCity mit dem Zugang des Inhabers aus; ohne Bremse könnte
// eine Handvoll Leute den Zugang in die Begrenzung treiben.
const BEFEHL_PAUSE_MS = +(process.env.UC_DISCORD_BEFEHL_PAUSE_S || 5) * 1000;
const letzterBefehl = new Map();

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

/** Ist das der Firmeninhaber? Für Knöpfe, die nur er bedienen darf. */
export const istInhaber = (id) => !!CFG.CHEF_ID && String(id) === CFG.CHEF_ID;

/** Welche Kanäle eingerichtet sind – für Hinweise in der Schaltzentrale. */
export const kanaele = () => ({
  team: CFG.TEAM_KANAL, chef: CFG.CHEF_KANAL,
  vorfall: CFG.VORFALL_KANAL, befehl: CFG.BEFEHL_KANAL,
});

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
 *   erledigt:  { '<vorfallschlüssel>': { wer, name, zeit } }
 * }
 *
 * Auch das Erledigt-Zeichen gehört hierher, nicht in den Zustand: es entsteht
 * durch einen Knopfdruck, also mitten in einem Durchlauf, und wäre mit der
 * älteren Zustandskopie wieder weg.
 */
let cache = { stand: -1, inhalt: null };

function lade() {
  try {
    const stand = fs.statSync(REGELN_DATEI).mtimeMs;
    if (stand === cache.stand && cache.inhalt) return cache.inhalt;
    const rohdaten = JSON.parse(fs.readFileSync(REGELN_DATEI, 'utf8'));
    // Ältere Dateien enthielten die Regeln ohne Umschlag, direkt als
    // Themen-Zuordnung. Die werden weiter gelesen.
    const inhalt = rohdaten.regeln || rohdaten.zuordnung || rohdaten.erledigt
      ? { regeln: rohdaten.regeln || {}, zuordnung: rohdaten.zuordnung || {},
          erledigt: rohdaten.erledigt || {} }
      : { regeln: rohdaten, zuordnung: {}, erledigt: {} };
    cache = { stand, inhalt };
    return inhalt;
  } catch {
    return { regeln: {}, zuordnung: {}, erledigt: {} };   // noch nie etwas eingestellt
  }
}

function speichere(inhalt) {
  const tmp = REGELN_DATEI + '.tmp';
  // 0600 wie beim Zustand: die Datei bestimmt, wohin Meldungen gehen und wer
  // welche Befehle darf – wer sie ändern kann, ändert die Berechtigungen.
  fs.writeFileSync(tmp, JSON.stringify(inhalt, null, 2), { mode: 0o600 });
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
/* ========================= ERLEDIGTE VORFÄLLE ========================= */

// Wie lange ein Erledigt-Zeichen aufgehoben wird. Länger als jede Frist eines
// Vorfalls; danach kann der Eintrag weg, sonst wächst die Datei endlos.
const ERLEDIGT_BEHALTEN_MS = 12 * 3_600_000;

export const ladeErledigt = () => lade().erledigt || {};

/** Ist dieser Vorfall als erledigt gekennzeichnet? Gibt den Eintrag zurück. */
export function istErledigt(schluessel) {
  const e = ladeErledigt()[schluessel];
  if (!e) return null;
  return Date.now() - (e.zeit || 0) > ERLEDIGT_BEHALTEN_MS ? null : e;
}

/**
 * Einen Vorfall als erledigt kennzeichnen. Gibt zurück, ob das neu war –
 * damit ein zweiter Knopfdruck etwas anderes antworten kann als der erste.
 */
export function merkeErledigt(schluessel, wer, name) {
  const erledigt = { ...ladeErledigt() };
  const schonDa = !!erledigt[schluessel];
  if (!schonDa) erledigt[schluessel] = { wer, name, zeit: Date.now() };

  const grenze = Date.now() - ERLEDIGT_BEHALTEN_MS;
  for (const [k, v] of Object.entries(erledigt)) {
    if ((v.zeit || 0) < grenze) delete erledigt[k];
  }
  speichere({ ...lade(), erledigt });
  return { neu: !schonDa, eintrag: erledigt[schluessel] };
}

/* ========================= EMPFÄNGER ========================= */

/**
 * Wer bekommt welche Meldung?
 *
 * Grundregel: Betriebliches, auf das das Team reagieren kann, geht in den
 * Team-Kanal. Geld, Personalstand, Arbeitszeiten und alles Technische sind
 * Sache des Inhabers – das steht in keinem geteilten Kanal.
 *
 * Was in einem Kanal steht, bekommt der Inhaber nicht zusätzlich in seinen
 * eigenen: Er sieht die Kanäle ohnehin, und eine zweite Nachricht wäre nur
 * Lärm. Wer die ausführliche Fassung zusätzlich will, stellt in /melden
 * "ein bestimmter Kanal und ich" oder "ich und das Team" ein. Unabhängig
 * davon geht die vollständige Fassung weiterhin per ntfy aufs Handy.
 *
 * Verglichen wird der Anfang des Themas, weil viele Themen eine laufende
 * Nummer anhängen ('event_...', 'ausschuettung_std_3').
 */
const TEAM_THEMEN = [
  'lager',                   // Bestand niedrig – das Team kann nachfüllen
  'preissprung',             // Lieferengpass – betrifft den Einkauf
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

// Gepingt wird nur bei Vorfällen, und immer nur, wer gerade in UnicaCity
// online ist. Alles andere hat keine Frist: bei einem niedrigen Lagerbestand
// jemanden aus dem Feierabend zu holen, wäre eine Belästigung. @everyone,
// @here und Rollen-Pings gibt es deshalb nicht mehr – sie erreichten
// verlässlich die Falschen.
const PINGBAR = ['event_', 'vorfall_'];

// Nachgefasst wird, wenn überhaupt, nach fünf Minuten. Eine Auswahl aus fünf
// Abständen war eine Entscheidung, die niemand treffen wollte: bei einer Frist
// von zehn Minuten ist alles andere entweder zu früh oder zu spät.
export const ERINNERUNG_MIN = +(process.env.UC_VORFALL_ERINNERUNG_MIN || 5);

// Ein Vorfall im Unternehmen hat eine Frist und pingt darum von selbst. Der
// Kassenvorfall ist bereits passiert – dort ist nichts mehr zu retten, also
// still, bis jemand es anders einstellt.
const PING_VON_SELBST = ['event_'];

const istPingbar = (t) => PINGBAR.some(x => t.startsWith(x));

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
  ['ausschuettung_std_',     'Ausschüttung: Zwischenstand (alle 3 Std.)'],
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
/**
 * Gilt die Regel für den Schlüssel `k` auch für die Meldung `t`?
 *
 * Gesucht wird über den Anfang, weil viele Themen eine laufende Nummer
 * anhängen ('vorfall_1758…'). Dabei fangen sich kurze Themen aber längere
 * mit ein: 'lagerverlust_' beginnt mit 'lager', 'ausschuettung_std_' mit
 * 'ausschuettung_'. Ohne diese Prüfung hätte eine Regel für den niedrigen
 * Lagerbestand („ans Team") auch den Diebstahlverdacht samt Namensliste ins
 * Team geschickt – eine Meldung, die ausdrücklich nur den Inhaber angeht.
 *
 * Deshalb: k gilt nicht, wenn die Meldung zu einem eigenen, genaueren Thema
 * gehört, das selbst mit k beginnt. Vorfallsarten wie 'event_ABWERBUNG' sind
 * kein solches Thema – dort ist genau das Durchgreifen von 'event_' gewollt.
 */
function regelPasst(k, t) {
  if (!t.startsWith(k)) return false;
  return !THEMEN.some(([m]) => m !== k && m.startsWith(k) && t.startsWith(m));
}

export function empfaenger(thema, regeln = {}) {
  const t = String(thema || '');

  const treffer = Object.keys(regeln || {})
    .filter(k => regelPasst(k, t))
    .sort((a, b) => b.length - a.length)[0];
  const eigen = treffer ? regeln[treffer] : null;

  // Abgeschaltet heißt abgeschaltet – auch kein ntfy aufs Handy.
  if (eigen?.aus) return { ziel: 'aus' };

  // Ping nur bei Vorfällen, und nur online. Eine eigene Einstellung schlägt
  // die Voreinstellung; ohne Einstellung pingt, was von selbst pingt.
  const ping = istPingbar(t)
    ? ((eigen?.ping ?? PING_VON_SELBST.some(x => t.startsWith(x))) ? 'online' : undefined)
    : undefined;

  // Ein selbst gesetzter Kanal gilt vor allem anderen.
  if (eigen?.kanal) return { ziel: 'kanal', kanal: eigen.kanal, ping };

  // In einer DM erreicht ein Ping niemanden außer dem Inhaber selbst.
  if (NUR_CHEF.some(x => t.startsWith(x))) return { ziel: 'chef' };

  if (CFG.VORFALL_KANAL && VORFALL_THEMEN.some(x => t.startsWith(x))) {
    return { ziel: 'kanal', kanal: CFG.VORFALL_KANAL, ping };
  }
  return { ziel: TEAM_LISTE.some(x => t.startsWith(x)) ? 'team' : 'chef', ping };
}

/** Pingt dieses Thema, wie es gerade eingestellt ist? Für /melden und /hilfe. */
export const pingtJetzt = (thema, regeln = {}) =>
  empfaenger(thema, regeln).ping === 'online';

/** Darf man für dieses Thema überhaupt einen Ping einstellen? */
export const pingbar = (thema) => istPingbar(String(thema || ''));

/** Beschreibt eine Regel in einem Satz, für die Anzeige in Discord. */
export function regelText(regel) {
  if (regel.ziel === 'aus') return 'gar nicht – abgeschaltet';

  // Die Kanäle mit Namen nennen, nicht nur „ins Team". Sonst liest man
  // „nur ins Team" und denkt an den Kanal, den man dafür angelegt hat –
  // während die Meldung tatsächlich im allgemeinen Kanal landet.
  const team = CFG.TEAM_KANAL ? `ins Team (<#${CFG.TEAM_KANAL}>)` : 'ins Team (Kanal fehlt!)';
  const dich = CFG.CHEF_KANAL ? `an dich (<#${CFG.CHEF_KANAL}>)` : 'an dich (als DM)';
  const wohin = regel.ziel === 'kanal'
    ? (regel.kanal ? `in <#${regel.kanal}>` : 'in einen Kanal (fehlt!)')
    : regel.ziel === 'chef' ? `nur ${dich}`
    : regel.ziel === 'team' ? `nur ${team}`
    : String(regel.ziel);

  const ping = regel.ping === 'online' ? ' · pingt, wer gerade ingame online ist' : '';
  const nachfassen = regel.erinnerung === undefined ? ''
    : regel.erinnerung ? ` · fasst nach ${ERINNERUNG_MIN} Min. nach` : ' · ohne Nachfassen';
  return wohin + ping + nachfassen;
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
  // Darf nicht werfen: ein Fehler hier würde sonst bis in den Durchlauf des
  // Watchers durchschlagen und dessen restliche Prüfungen samt Speichern
  // abbrechen. Ohne Kanal wird die Meldung still übersprungen – inKanal()
  // behandelt den leeren Wert bereits.
  try {
    const k = await rest('/users/@me/channels', 'POST', { recipient_id: CFG.CHEF_ID });
    dmKanal = k.id;
    return dmKanal;
  } catch (e) {
    console.error('  Discord: DM-Kanal zum Inhaber nicht erreichbar:', e.message);
    return '';
  }
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

/**
 * Ein Knopf unter der Nachricht. Gedacht für „erledigt, keine Erinnerung
 * mehr": ein Druck erreicht jeden, der die Nachricht sieht, ohne dass jemand
 * einen Befehl kennen muss.
 *
 * custom_id trägt die Kennung mit, denn Discord schickt beim Druck nur sie
 * zurück – höchstens 100 Zeichen.
 */
const KNOPF_ID_MAX = 100;

const kuerze = (t, n) => String(t ?? '').slice(0, n);

/**
 * Baut die Reihen unter einer Nachricht aus einer knappen Beschreibung.
 *
 * Eine Reihe ist entweder ein Auswahlmenü oder bis zu fünf Knöpfe; Discord
 * erlaubt fünf Reihen. Beschrieben wird das als Liste von Listen:
 *
 *   [[{ knopf: 'Aus', id: 'x', stil: 4 }, { knopf: 'An', id: 'y' }],
 *    [{ auswahl: 'Thema wählen', id: 'z', optionen: [{ name, value, beschreibung? }] }],
 *    [{ kanalwahl: 'Kanal wählen', id: 'k' }]]
 *
 * Stile: 1 blau, 2 grau, 3 grün, 4 rot.
 */
export function reihen(spec = []) {
  const zeilen = (spec || []).filter(Boolean).slice(0, 5).map(reihe => {
    const teile = (Array.isArray(reihe) ? reihe : [reihe]).filter(Boolean);
    const erstes = teile[0] || {};

    if (erstes.auswahl !== undefined) {
      return { type: 1, components: [{
        type: 3,                                   // Auswahlmenü mit Texten
        custom_id: kuerze(erstes.id, KNOPF_ID_MAX),
        placeholder: kuerze(erstes.auswahl, 150),
        options: (erstes.optionen || []).slice(0, 25).map(o => ({
          label: kuerze(o.name, 100),
          value: kuerze(o.value, 100),
          ...(o.beschreibung ? { description: kuerze(o.beschreibung, 100) } : {}),
          ...(o.emoji ? { emoji: { name: o.emoji } } : {}),
          ...(o.gewaehlt ? { default: true } : {}),
        })),
      }] };
    }

    if (erstes.kanalwahl !== undefined) {
      return { type: 1, components: [{
        type: 8,                                   // Auswahlmenü für Kanäle
        custom_id: kuerze(erstes.id, KNOPF_ID_MAX),
        placeholder: kuerze(erstes.kanalwahl, 150),
        channel_types: [0, 5],                     // Text und Ankündigungen
      }] };
    }

    return { type: 1, components: teile.slice(0, 5).map(k => ({
      type: 2,
      style: k.stil || 2,
      label: kuerze(k.knopf, 80),
      custom_id: kuerze(k.id, KNOPF_ID_MAX),
      ...(k.emoji ? { emoji: { name: k.emoji } } : {}),
      ...(k.gesperrt ? { disabled: true } : {}),
    })) };
  });
  return zeilen.filter(z => z.components.length);
}

/**
 * Ein Knopf unter der Nachricht. Gedacht für „erledigt, keine Erinnerung
 * mehr": ein Druck erreicht jeden, der die Nachricht sieht, ohne dass jemand
 * einen Befehl kennen muss.
 *
 * custom_id trägt die Kennung mit, denn Discord schickt beim Druck nur sie
 * zurück – höchstens 100 Zeichen.
 */
function knopfTeile(knopf) {
  if (!knopf?.id) return {};
  return { components: reihen([[{
    knopf: knopf.text || 'Erledigt', id: knopf.id, stil: knopf.stil || 3,
    emoji: knopf.emoji,
  }]]) };
}

async function inKanal(kanal, titel, text, prio, fuss, ping, pingNutzer, knopf) {
  if (!kanal) return;
  try {
    await rest(`/channels/${kanal}/messages`, 'POST',
      { embeds: [embed(titel, text, prio, fuss)], ...pingTeile(ping, pingNutzer),
        ...knopfTeile(knopf) });
  } catch (e) { console.error('  Discord-Meldung fehlgeschlagen:', e.message); }
}

/**
 * Verschickt eine Meldung an die vorgesehenen Empfänger.
 *
 * ziel: 'chef'  – nur an dich (DM oder Chef-Kanal)
 *       'team'  – nur in den Team-Kanal
 *       'beide' – an beide
 */
export async function discordSende(auftrag) {
  // Nichts aus dieser Funktion darf nach oben durchschlagen: sie wird mitten
  // im Durchlauf des Watchers aufgerufen, und ein geworfener Fehler würde
  // dort alle folgenden Prüfungen und das Speichern des Zustands verhindern.
  try {
    await sendeIntern(auftrag);
  } catch (e) {
    console.error('  Discord-Zustellung fehlgeschlagen:', e.message);
  }
}

async function sendeIntern({ ziel, kanal, auchChef, ping, pingNutzer, titel, text,
                            prio = 'high', knopf }) {
  if (!discordAktiv() || ziel === 'aus') return;

  if (ziel === 'chef' || ziel === 'beide' || (ziel === 'kanal' && auchChef)) {
    // Geht die Meldung in einen eigenen Kanal, darf dort auch gepingt werden.
    // In einer DM wäre ein Ping sinnlos: sie erreicht ohnehin nur dich, und
    // @everyone gibt es in einer DM nicht.
    const eigenerKanal = !!CFG.CHEF_KANAL;
    await inKanal(await chefKanal(), titel, text, prio,
                  'nur für den Firmeninhaber', eigenerKanal ? ping : undefined, pingNutzer,
                  knopf);   // der Knopf geht auch in einer DM
  }
  if (ziel === 'team' || ziel === 'beide') {
    await inKanal(CFG.TEAM_KANAL, titel, text, prio,
                  undefined, ping, pingNutzer, knopf);
  }
  if (ziel === 'kanal') {
    // Ein frei gewählter Kanal bekommt die Team-Fassung: dort können Leute
    // mitlesen, die nicht der Inhaber sind.
    await inKanal(kanal, titel, text, prio, undefined, ping, pingNutzer, knopf);
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
  // default_member_permissions: '0' blendet einen Befehl für alle aus, die
  // im Server keine Verwaltungsrechte haben – er taucht bei ihnen gar nicht
  // erst in der Liste auf. Ohne das sieht jeder alle Befehle samt
  // Beschreibung, auch wenn der Bot sie ihm verweigert.
  const liste = Object.entries(befehle).map(([name, b]) => ({
    name,
    description: b.beschreibung.slice(0, 100),
    type: 1,
    ...(b.verbergen ? { default_member_permissions: '0' } : {}),
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
  // Eine Befehlsantwort darf niemanden anpingen. In ihr stehen Namen aus
  // UnicaCity und selbst eingetippte Zuordnungen – stünde dort "@everyone",
  // würde eine harmlose Abfrage den halben Server aus dem Bett holen.
  const daten = typeof inhalt === 'string'
    ? { content: kappen(inhalt, 1900), allowed_mentions: { parse: [] } }
    : { embeds: [inhalt], allowed_mentions: { parse: [] } };
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

/**
 * Jemand hat einen Knopf gedrückt.
 *
 * `handler(id, nutzer)` entscheidet, was das bedeutet, und gibt
 * { text, oeffentlich?, fussnote? } zurück:
 *   text       – Antwort an den, der gedrückt hat
 *   fussnote   – wird an die ursprüngliche Nachricht gehängt, für alle sichtbar
 *   knopfWeg   – true entfernt den Knopf, damit niemand zweimal drückt
 *
 * Die ursprüngliche Nachricht wird mit Antworttyp 7 bearbeitet: so verschwindet
 * der Knopf für jeden, und im Kanal steht, wer sich gekümmert hat. Ohne das
 * würden fünf Leute nacheinander drücken, ohne voneinander zu wissen.
 */
/**
 * Jemand hat einen Knopf gedrückt, etwas aus einem Menü gewählt oder ein
 * Eingabefenster abgeschickt.
 *
 * `handler(id, nutzer, werte)` entscheidet, was das bedeutet. `werte` sind die
 * gewählten Einträge eines Menüs oder die Eingaben eines Fensters. Zurück
 * kommt eines von:
 *
 *   { text, fussnote?, knopfWeg? }  – Rückmeldung nur an den Drückenden; die
 *                                     Nachricht behält ihren Inhalt, der Knopf
 *                                     verschwindet (knopfWeg: false lässt ihn)
 *   { tafel: { titel, text, reihen } } – die Nachricht wird neu gezeichnet
 *   { fenster: { id, titel, felder } } – ein Eingabefenster geht auf
 *
 * Die Nachricht wird mit Antworttyp 7 bearbeitet: so bleibt eine einzige
 * Nachricht die Schaltzentrale, statt bei jedem Klick eine neue zu schicken.
 */
export async function behandleKnopf(interaktion, handler) {
  const id = interaktion.data?.custom_id;
  if (!id || typeof handler !== 'function') return;

  const nutzer = interaktion.member?.user || interaktion.user || {};
  const name = interaktion.member?.nick || nutzer.global_name || nutzer.username || 'jemand';

  // Aus einem Menü kommen die gewählten Werte, aus einem Eingabefenster die
  // Texte – beides als flache Liste, damit der Handler nicht zwei Formen
  // unterscheiden muss.
  const werte = interaktion.data?.values
    || (interaktion.data?.components || [])
         .flatMap(r => (r.components || []).map(f => f.value))
         .filter(v => v !== undefined);

  let ergebnis;
  try {
    ergebnis = await handler(id, { ...nutzer, anzeigename: name }, werte);
  } catch (e) {
    console.error('  Interaktion', id, 'fehlgeschlagen:', e.message);
    ergebnis = { text: '❌ Das hat nicht funktioniert: ' + e.message };
  }
  if (!ergebnis) return;

  // --- Ein Eingabefenster: muss die erste Antwort sein, nichts davor ---
  if (ergebnis.fenster) {
    const f = ergebnis.fenster;
    try {
      await rest(`/interactions/${interaktion.id}/${interaktion.token}/callback`, 'POST', {
        type: 9,                                   // Eingabefenster
        data: {
          custom_id: kuerze(f.id, KNOPF_ID_MAX),
          title: kuerze(f.titel, 45),
          components: (f.felder || []).slice(0, 5).map(feld => ({
            type: 1,
            components: [{
              type: 4, custom_id: kuerze(feld.id, KNOPF_ID_MAX),
              label: kuerze(feld.name, 45), style: 1,
              required: feld.pflicht !== false,
              ...(feld.hinweis ? { placeholder: kuerze(feld.hinweis, 100) } : {}),
              max_length: feld.max || 100,
            }],
          })),
        },
      });
    } catch (e) { console.error('  Eingabefenster ging nicht auf:', e.message); }
    return;
  }

  // Die alte Nachricht mitschicken, sonst ersetzt Typ 7 sie durch nichts.
  const alt = interaktion.message || {};
  const embeds = (alt.embeds || []).map(e => ({ ...e }));

  if (ergebnis.tafel) {
    // Neu zeichnen: dieselbe Nachricht, anderer Inhalt.
    const t = ergebnis.tafel;
    embeds[0] = embed(t.titel, t.text, t.prio || 'min', t.fuss);
    try {
      await rest(`/interactions/${interaktion.id}/${interaktion.token}/callback`, 'POST', {
        type: 7,
        data: { embeds: [embeds[0]], components: reihen(t.reihen),
                allowed_mentions: { parse: [] } },
      });
    } catch (e) { console.error('  Tafel nicht bearbeitbar:', e.message); }
    if (ergebnis.text) await nachreichen(interaktion, ergebnis.text);
    log('Tafel', id, 'von', nutzer.username || nutzer.id);
    return;
  }

  if (ergebnis.fussnote && embeds[0]) {
    const bisher = embeds[0].footer?.text ? embeds[0].footer.text + ' · ' : '';
    embeds[0].footer = { text: (bisher + ergebnis.fussnote).slice(0, 2048) };
  }

  try {
    await rest(`/interactions/${interaktion.id}/${interaktion.token}/callback`, 'POST', {
      type: 7,                                   // Nachricht bearbeiten
      data: {
        ...(embeds.length ? { embeds } : {}),
        ...(alt.content !== undefined ? { content: alt.content } : {}),
        // Ein entfernter Knopf ist die einzige verlässliche Anzeige, dass es
        // schon jemand gemacht hat.
        components: ergebnis.knopfWeg === false ? (alt.components || []) : [],
        allowed_mentions: { parse: [] },
      },
    });
  } catch (e) {
    console.error('  Knopf: Nachricht nicht bearbeitbar:', e.message);
  }

  if (ergebnis.text) await nachreichen(interaktion, ergebnis.text);
  log('Knopf', id, 'von', nutzer.username || nutzer.id);
}

/** Eine Rückmeldung, die nur der sieht, der gedrückt hat. */
async function nachreichen(interaktion, text) {
  try {
    await rest(`/webhooks/${appId()}/${interaktion.token}`, 'POST',
      { content: kappen(text, 1900), flags: 64, allowed_mentions: { parse: [] } });
  } catch (e) { log('Rückmeldung:', e.message); }
}

/**
 * Die Schaltzentrale in einen Kanal stellen. Gibt die Nachricht zurück, damit
 * der Aufrufer sie anpinnen oder ihre Adresse nennen kann.
 */
export async function tafelSenden(kanal, tafel) {
  if (!kanal) throw new Error('KEIN_KANAL');
  return rest(`/channels/${kanal}/messages`, 'POST', {
    embeds: [embed(tafel.titel, tafel.text, tafel.prio || 'min', tafel.fuss)],
    components: reihen(tafel.reihen),
    allowed_mentions: { parse: [] },
  });
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

  await aufschieben(interaktion, heimlich);

  // Bremse: pro Person und Befehl. Der Inhaber ist ausgenommen, damit eine
  // Fehlersuche nicht an der eigenen Bremse scheitert.
  if (!istChef && BEFEHL_PAUSE_MS > 0) {
    const schluessel = `${nutzer.id}:${name}`;
    const zuletzt = letzterBefehl.get(schluessel) || 0;
    const warten = BEFEHL_PAUSE_MS - (Date.now() - zuletzt);
    if (warten > 0) {
      await antworte(interaktion,
        `⏳ Einen Moment – bitte ${Math.ceil(warten / 1000)} Sekunden warten.`, heimlich);
      return;
    }
    letzterBefehl.set(schluessel, Date.now());
    // Die Liste darf nicht unbegrenzt wachsen.
    if (letzterBefehl.size > 500) {
      const grenze = Date.now() - BEFEHL_PAUSE_MS;
      for (const [k, t] of letzterBefehl) if (t < grenze) letzterBefehl.delete(k);
    }
  }

  // Ein Befehl ist entweder für alle da oder nur für den Inhaber. Eine
  // Rechteverwaltung dazwischen gab es einmal; sie verwaltete Rechte, die
  // ohnehin alle haben sollten.
  if (b.nurChef && !istChef) {
    await antworte(interaktion,
      '🔒 Diesen Befehl kann nur der Firmeninhaber benutzen.', heimlich);
    return;
  }

  try {
    const optionen = {};
    for (const o of interaktion.data?.options || []) optionen[o.name] = o.value;
    const ergebnis = await b.ausfuehren({ istChef, nutzer, rollen, optionen, oeffentlich,
                                          kanal: interaktion.channel_id || '' });
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

export function verbinde(befehle, knopfHandler) {
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
        } else if (p.t === 'INTERACTION_CREATE' && (p.d?.type === 3 || p.d?.type === 5)) {
          // Ein Knopf, eine Auswahl oder ein abgeschicktes Eingabefenster.
          behandleKnopf(p.d, knopfHandler).catch(e => console.error('  Knopf:', e.message));
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
    setTimeout(() => verbinde(befehle, knopfHandler), wartezeit);
  });
}

/**
 * Startet den Bot: Befehle registrieren, dann Gateway verbinden.
 *
 * ohneGateway: nur registrieren und senden, keine Dauerverbindung. Das braucht
 * der Probelauf über --discord-test, der sich gleich wieder beendet.
 */
export async function discordStart(befehle, { ohneGateway = false, knopf } = {}) {
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
  if (!ohneGateway) verbinde(befehle, knopf);
  return true;
}
