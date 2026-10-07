// Zeitarchiv des Watchers.
//
// Hier liegen die abgeschlossenen Zahlen je Spieltag: pro Spieler die
// Onlinezeit und die Rolle, dazu die Laufzeit der Firma, die Ausschüttungen
// und der Stand des Auszahlungstopfs.
//
// Bewusst getrennt vom Laufzeitzustand (uc-watcher-state.json):
//   • Der Zustand ist flüchtig – gesamtMs wird um 04:00 zurückgesetzt,
//     teamOnlineMs bei jeder Ausschüttung. Wer nur den Zustand hat, kann
//     nichts über gestern sagen.
//   • Das Archiv wächst und wird nur ergänzt. Es enthält keine Zugangsdaten,
//     ist also auch ohne das Cookie lesbar und auswertbar.
//   • Die Auswertung steht hier, nicht in den Discord-Befehlen. Der Bot ist
//     nur die Ausgabe; Wochenberichte, Trends oder eine Ausschüttungs-
//     rechnung setzen auf denselben Funktionen auf.
//
// Aufbau der Datei:
// {
//   "version": 1,
//   "tage": {
//     "2026-09-20": {
//       "firmaMs": 21600000,             // Laufzeit der Firma an diesem Spieltag
//       "spieler": { "LottiMi": { "ms": 21540000, "rolle": "Inhaber" } },
//       "ausschuettungen": [ { "stamp": 1758…, "betrag": 500000 } ],
//       "auszahlung": { "tag": "2026-09-20", "summe": 35000, "freibetrag": 35000 },
//       "stand": 1758…                   // wann zuletzt geschrieben
//     }
//   }
// }

import fs from 'node:fs';
import path from 'node:path';

const CFG = {
  DATEI: process.env.UC_ARCHIV_FILE ||
    path.join(process.cwd(), 'uc-watcher-zeiten.json'),
  // Wie viele Spieltage behalten werden. Ein Jahr plus Reserve; ein Tag wiegt
  // wenige hundert Byte, das kostet nichts.
  TAGE: +(process.env.UC_ARCHIV_TAGE || 400),
  AUS: process.env.UC_ARCHIV === '0',
};

const VERSION = 1;
const leer = () => ({ version: VERSION, tage: {} });

const leererTag = () => ({
  firmaMs: 0, spieler: {}, ausschuettungen: [],
  auszahlung: { tag: null, summe: 0, freibetrag: 0 }, stand: 0,
});

/* ========================= LESEN UND SCHREIBEN ========================= */

let zwischenspeicher = null;
let zuletztGeschrieben = '';

/** Das Archiv laden. Das Ergebnis wird gehalten, Lesen kostet also nichts. */
export function ladeArchiv(neu = false) {
  if (zwischenspeicher && !neu) return zwischenspeicher;
  try {
    const rohtext = fs.readFileSync(CFG.DATEI, 'utf8');
    const geladen = JSON.parse(rohtext);
    // Ein fremdes oder kaputtes Format nicht halb übernehmen.
    zwischenspeicher = (geladen && typeof geladen.tage === 'object')
      ? { version: geladen.version || VERSION, tage: geladen.tage }
      : leer();
    zuletztGeschrieben = rohtext;
  } catch {
    zwischenspeicher = leer();
    zuletztGeschrieben = '';
  }
  return zwischenspeicher;
}

/** Schreiben, wenn sich etwas geändert hat. Gibt zurück, ob geschrieben wurde. */
export function speichereArchiv() {
  if (CFG.AUS || !zwischenspeicher) return false;
  raeumeAlteTage(zwischenspeicher);
  const inhalt = JSON.stringify(zwischenspeicher, null, 2);
  if (inhalt === zuletztGeschrieben) return false;
  const tmp = CFG.DATEI + '.tmp';
  // 0600 wie beim Zustand: Namen und Anwesenheitszeiten der Mitarbeiter sind
  // nichts, was der Rest des Servers mitlesen muss.
  fs.writeFileSync(tmp, inhalt, { mode: 0o600 });
  fs.renameSync(tmp, CFG.DATEI);          // atomar – übersteht einen Stromausfall
  zuletztGeschrieben = inhalt;
  return true;
}

function raeumeAlteTage(archiv) {
  const tage = Object.keys(archiv.tage).sort();
  for (const tag of tage.slice(0, Math.max(0, tage.length - CFG.TAGE))) {
    delete archiv.tage[tag];
  }
}

export const archivDatei = () => CFG.DATEI;
export const archivAktiv = () => !CFG.AUS;

/* ========================= EINTRAGEN ========================= */

/**
 * Den Datensatz eines Spieltags holen, notfalls anlegen.
 * Nur innerhalb dieses Moduls aufrufen – von außen geht alles über merke*().
 */
function tagEintrag(tag) {
  // Immer eine eigene Kopie: so kann ein Aufrufer nichts halb verändert im
  // Archiv hinterlassen, wenn er zwischendurch abbricht. Geschrieben wird
  // ausschließlich über setzeTag(). Object.assign füllt zugleich Felder auf,
  // die eine ältere Datei noch nicht hatte.
  return Object.assign(leererTag(), ladeArchiv().tage[tag] || {});
}

function setzeTag(tag, eintrag) {
  const archiv = ladeArchiv();
  eintrag.stand = Date.now();
  archiv.tage[tag] = eintrag;
  return eintrag;
}

/**
 * Den laufenden Spieltag festhalten: Zeiten je Spieler, Rolle, Laufzeit der
 * Firma. Wird bei jedem Durchlauf aufgerufen und überschreibt den Tag – die
 * Werte im Zustand sind Tagessummen, keine Zuwächse.
 *
 * @param {string} tag          Spieltag als 'JJJJ-MM-TT'
 * @param {object} spieler      state.spieler
 * @param {number} firmaMs      state.firmaTagMs
 */
export function merkeZeiten(tag, spieler, firmaMs) {
  if (CFG.AUS || !tag) return;
  const eintrag = tagEintrag(tag);
  eintrag.firmaMs = Math.max(eintrag.firmaMs || 0, firmaMs || 0);

  for (const [name, p] of Object.entries(spieler || {})) {
    if (!name) continue;
    const ms = p?.gesamtMs || 0;
    const alt = eintrag.spieler[name];
    // Nur nach oben: ein Neustart mit leerem Zustand darf einen bereits
    // archivierten Tag nicht kleiner machen.
    eintrag.spieler[name] = {
      ms: Math.max(alt?.ms || 0, ms),
      rolle: p?.rolle || alt?.rolle || '',
    };
  }
  setzeTag(tag, eintrag);
}

/** Eine Ausschüttung vermerken. Doppelte Stempel werden übergangen. */
/**
 * Eine Ausschüttungsbuchung festhalten.
 *
 * Das Vorzeichen bleibt erhalten, und das ist der Kern: unter derselben
 * Kategorie stehen zwei Richtungen im Kassenbuch. Was die Firma **bekommt**
 * ist positiv, was ihr der Server **wegnimmt** negativ. Hier stand einmal
 * `Math.abs()` – damit zählten beide Richtungen als Abfluss, und die
 * Tagessumme war die Summe aus Haben und Soll. Genau deshalb kamen Beträge
 * heraus, die mit keinem Deckel zusammenpassten.
 *
 * `behalten` ist optional: der Kassenstand nach der Buchung, falls das
 * Kassenbuch ihn mitliefert. Er wird nur mitgeschrieben, nicht gedeutet.
 */
export function merkeAusschuettung(tag, stamp, betrag, kassenstand = null,
                                   gewinnVorher = null) {
  if (CFG.AUS || !tag) return;
  const eintrag = tagEintrag(tag);
  if (eintrag.ausschuettungen.some(a => a.stamp === stamp)) return;
  const eintragNeu = { stamp, betrag: betrag || 0 };
  if (Number.isFinite(kassenstand)) eintragNeu.kassenstand = kassenstand;
  // Der Gewinn, der bis zur Abschöpfung angesammelt war. Gemessen vor der
  // Buchung, nicht danach: der Stand danach verrät nur den Rest, und aus ihm
  // auf den Deckel zu schließen war falsch – angesammelt war mehr.
  if (Number.isFinite(gewinnVorher)) eintragNeu.gewinnVorher = gewinnVorher;
  eintrag.ausschuettungen.push(eintragNeu);
  setzeTag(tag, eintrag);
}

/**
 * Den Stand des Auszahlungstopfs festhalten.
 *
 * Der Topf hängt am Kalendertag (0 Uhr), der Spieltag an 04:00 – die beiden
 * decken sich nicht. Zwischen 00:00 und 04:00 läuft noch der alte Spieltag,
 * während der Topf schon zurückgesetzt ist. Ohne den Vergleich mit
 * `topfTag` würde dieser frische Nullstand den echten Schlussstand des
 * Spieltags überschreiben.
 *
 * @param {string} tag       Spieltag, zu dem der Eintrag gehört
 * @param {string} topfTag   Kalendertag, auf den sich der Topf bezieht
 */
export function merkeAuszahlung(tag, topfTag, summe, freibetrag) {
  if (CFG.AUS || !tag) return;
  const eintrag = tagEintrag(tag);
  const bisher = eintrag.auszahlung || {};
  // Ein Topf aus einem anderen Kalendertag gehört zum nächsten Spieltag –
  // der bekommt um 04:00 seinen eigenen Eintrag.
  if (bisher.tag && bisher.tag !== topfTag) return;
  eintrag.auszahlung = { tag: topfTag, summe: summe || 0, freibetrag: freibetrag || 0 };
  setzeTag(tag, eintrag);
}

/* ========================= ABFRAGEN ========================= */

/** Ein Spieltag, oder null. */
export function holeTag(tag) {
  const eintrag = ladeArchiv().tage[tag];
  return eintrag ? Object.assign(leererTag(), eintrag) : null;
}

/** Alle vorhandenen Spieltage, aufsteigend. */
export const alleTage = () => Object.keys(ladeArchiv().tage).sort();

/**
 * Die Spieltage von 'von' bis 'bis' (beide einschließlich, als 'JJJJ-MM-TT').
 * Lücken kommen nicht mit – Tage ohne Eintrag hat es nicht gegeben.
 * @returns {Array<{tag: string} & object>}
 */
export function holeTage(von, bis) {
  return alleTage()
    .filter(t => (!von || t >= von) && (!bis || t <= bis))
    .map(t => ({ tag: t, ...holeTag(t) }));
}

/**
 * Die letzten n Spieltage bis einschließlich 'bis' (Standard: alle bis heute).
 * Zählt vorhandene Einträge, nicht Kalendertage.
 */
export function letzteTage(n, bis) {
  const tage = alleTage().filter(t => !bis || t <= bis);
  return tage.slice(-n).map(t => ({ tag: t, ...holeTag(t) }));
}

/** Den Spieltag n Tage vor 'tag' als 'JJJJ-MM-TT'. */
export function tagMinus(tag, n) {
  const d = new Date(`${tag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Mehrere Spieltage zusammenrechnen.
 *
 * @param {Array} tage  Ergebnis von holeTage/letzteTage
 * @returns {{
 *   tage: number, firmaMs: number, gesamtMs: number,
 *   ausschuettungen: number, betrag: number,
 *   auszahlung: number, freibetrag: number,
 *   spieler: Array<{name, ms, tage, rolle, schnitt}>
 * }}
 */
export function summiere(tage) {
  const proSpieler = new Map();
  const summe = {
    tage: tage.length, firmaMs: 0, gesamtMs: 0,
    // `ausschuettungen`/`betrag` meinen die Abflussseite – danach wird am
    // häufigsten gefragt. `zugeflossen` daneben, damit ein Wochenbericht beide
    // Richtungen zeigen kann, und `gewinnGemessen` als die Zahl aus dem
    // Gewinnzähler, die von der Buchungsart unabhängig ist.
    ausschuettungen: 0, betrag: 0, zugeflossen: 0, gewinnGemessen: 0,
    auszahlung: 0, freibetrag: 0,
    von: tage[0]?.tag || null, bis: tage[tage.length - 1]?.tag || null,
    spieler: [],
  };

  for (const t of tage) {
    summe.firmaMs += t.firmaMs || 0;
    for (const x of t.ausschuettungen || []) {
      const b = x.betrag || 0;
      if (b < 0) {
        summe.ausschuettungen++;
        summe.betrag -= b;
        if (Number.isFinite(x.gewinnVorher)) summe.gewinnGemessen += x.gewinnVorher;
      } else {
        summe.zugeflossen += b;
      }
    }
    summe.auszahlung += t.auszahlung?.summe || 0;
    summe.freibetrag += t.auszahlung?.freibetrag || 0;

    for (const [name, p] of Object.entries(t.spieler || {})) {
      const e = proSpieler.get(name) || { name, ms: 0, tage: 0, rolle: '' };
      e.ms += p.ms || 0;
      // Tage mit unter einer Minute gelten nicht als anwesend.
      if ((p.ms || 0) >= 60_000) e.tage++;
      if (p.rolle) e.rolle = p.rolle;        // die jüngste bekannte Rolle
      proSpieler.set(name, e);
      summe.gesamtMs += p.ms || 0;
    }
  }

  summe.spieler = [...proSpieler.values()]
    .map(e => ({ ...e, schnitt: e.tage ? Math.round(e.ms / e.tage) : 0 }))
    .sort((a, b) => b.ms - a.ms);
  return summe;
}

/**
 * Zwei gleich lange Zeitspannen vergleichen: die n Tage bis 'bis' gegen die
 * n Tage davor. Für "mehr oder weniger als letzte Woche".
 */
export function vergleich(n, bis) {
  const jetzt = letzteTage(n, bis);
  const grenze = jetzt[0]?.tag;
  const davor = grenze
    ? letzteTage(n, tagMinus(grenze, 1))
    : [];
  const a = summiere(jetzt), b = summiere(davor);
  return {
    jetzt: a, davor: b,
    gesamtMs: a.gesamtMs - b.gesamtMs,
    firmaMs: a.firmaMs - b.firmaMs,
    // Je Spieler die Veränderung, absteigend nach dem aktuellen Wert.
    spieler: a.spieler.map(s => ({
      ...s,
      vorher: b.spieler.find(x => x.name === s.name)?.ms || 0,
      diff: s.ms - (b.spieler.find(x => x.name === s.name)?.ms || 0),
    })),
  };
}

/**
 * Alle Ausschüttungen in einem Zeitfenster, älteste zuerst.
 *
 * Die Einträge liegen je Spieltag (04:00 bis 04:00), gefragt ist aber oft ein
 * Kalendertag oder „seit dem Neustart". Weil jeder Eintrag seinen Zeitstempel
 * mitführt, lässt sich jedes Fenster daraus beantworten – gesucht wird in den
 * Spieltagen, die es überhaupt berühren können.
 *
 * @param {number} von  Zeitstempel, einschließlich
 * @param {number} bis  Zeitstempel, ausschließlich
 */
export function ausschuettungenIm(von, bis) {
  const tagVon = tagMinus(new Date(von).toISOString().slice(0, 10), 1);
  const tagBis = new Date(bis).toISOString().slice(0, 10);
  return holeTage(tagVon, tagBis)
    .flatMap(t => t.ausschuettungen || [])
    .filter(a => a.stamp >= von && a.stamp < bis)
    .sort((a, b) => a.stamp - b.stamp);
}

/** Summe, Anzahl, Schnitt und die größte – für die Berichte. */
/**
 * Die Kassenbilanz einer Reihe von Ausschüttungen.
 *
 * Die Frage, die sie beantwortet: **ist mehr Geld in der Firma, als aus dem
 * Behaltenen folgen kann?**
 *
 * Die Mechanik dahinter: eine Ausschüttung nimmt alles über dem Stundendeckel
 * aus dem System – das Geld ist weg, es ist ein Geldsink. Was unter dem Deckel
 * bleibt, ist der Betrag, um den die Firmenkasse in dieser Stunde wachsen
 * *sollte*. Gehälter und Miete ziehen davon wieder ab. Kommt am Ende mehr
 * heraus, kam Geld aus einer Quelle, die hier nicht verbucht ist.
 *
 * Gemessen wird **nur zu den Ausschüttungszeitpunkten**. Ein Kassenstand
 * zwischendurch taugt nicht: der enthält den Gewinn, der gleich wieder
 * abgeschöpft wird, und würde den Zuwachs grob zu hoch ausweisen.
 *
 * Der erste Stand ist die Grundlinie, kein Zuwachs. Deshalb zählt zum Soll das
 * Behaltene der Ausschüttungen *nach* der ersten – das sind genau die Stunden,
 * die zwischen erstem und letztem Stand liegen.
 */
export function kassenBilanz(eintraege, deckel = 0) {
  const ab = (eintraege || [])
    .filter(a => (a.betrag || 0) < 0)
    .sort((a, b) => a.stamp - b.stamp);

  const ausgeschuettet = ab.reduce((n, a) => n - a.betrag, 0);

  // Behalten je Ausschüttung: der gemessene Gewinn davor minus dem, was
  // abgeflossen ist. Gemessen, nicht aus dem Deckel gerechnet – er fällt
  // verschieden aus.
  const behaltenVon = (a) => Number.isFinite(a.gewinnVorher)
    ? Math.max(0, a.gewinnVorher + a.betrag)      // betrag ist negativ
    : null;

  const mitStand = ab.filter(a => Number.isFinite(a.kassenstand));
  const erster = mitStand[0] || null;
  const letzter = mitStand.length > 1 ? mitStand[mitStand.length - 1] : null;

  // Das Soll deckt die Stunden zwischen erstem und letztem Stand ab.
  const dazwischen = erster && letzter
    ? ab.filter(a => a.stamp > erster.stamp && a.stamp <= letzter.stamp)
    : [];
  const sollJe = dazwischen.map(behaltenVon);
  const sollGemessen = sollJe.filter(x => x !== null);
  const soll = sollGemessen.reduce((n, x) => n + x, 0) +
    // Für Stunden ohne Messung der Deckel als Ersatz, sonst fehlt der Posten
    // ganz und die Abweichung sähe größer aus, als sie ist.
    (deckel ? sollJe.filter(x => x === null).length * deckel : 0);

  const ist = erster && letzter ? letzter.kassenstand - erster.kassenstand : null;

  return {
    anzahl: ab.length,
    ausgeschuettet,
    // Das Behaltene über alle Ausschüttungen, nicht nur die dazwischen.
    behalten: ab.map(behaltenVon).filter(x => x !== null).reduce((n, x) => n + x, 0),
    behaltenAnzahl: ab.map(behaltenVon).filter(x => x !== null).length,

    ersterStand: erster ? erster.kassenstand : null,
    ersterStamp: erster ? erster.stamp : null,
    letzterStand: letzter ? letzter.kassenstand : null,
    letzterStamp: letzter ? letzter.stamp : null,

    stunden: dazwischen.length,
    soll,
    ist,
    // Positiv heißt: mehr in der Kasse, als aus dem Behaltenen folgen kann –
    // und das, obwohl Gehälter und Miete dagegen arbeiten.
    differenz: ist === null ? null : ist - soll,
    ohneMessung: sollJe.filter(x => x === null).length,
    vollstaendig: erster !== null && letzter !== null,
  };
}

/**
 * Einmalige Korrektur der Alt-Einträge.
 *
 * Bis zur Vorzeichen-Korrektur hat merkeAusschuettung() jeden Betrag mit
 * Math.abs() positiv gespeichert. Diese Einträge sehen wie Zuflüsse aus, waren
 * aber Abflüsse. Als Kennzeichen dient der fehlende Kassenstand – den schreibt
 * erst die neue Fassung mit.
 *
 * **Von Hand aufrufen, nie automatisch.** Das Kennzeichen ist nicht sicher:
 * Zuflüsse unter derselben Kategorie gibt es wirklich, und einer ohne
 * Kassenstand würde hier fälschlich umgedreht. Beim Dienststart lief das
 * einmal mit – das ist entfernt, weil der Schaden größer wäre als der Nutzen.
 * Vor dem Schreiben erst ohne `schreiben` ansehen, welche Einträge gemeint
 * sind.
 *
 * `schreiben: false` rechnet nur durch und ändert nichts.
 */
export function vorzeichenKorrektur({ schreiben = false } = {}) {
  const archiv = ladeArchiv();
  const betroffen = [];

  for (const [tag, eintrag] of Object.entries(archiv.tage || {})) {
    for (const a of eintrag.ausschuettungen || []) {
      // Nur Alt-Einträge: positiv und ohne Kassenstand.
      if ((a.betrag || 0) > 0 && !Number.isFinite(a.kassenstand)) {
        betroffen.push({ tag, stamp: a.stamp, vorher: a.betrag });
        if (schreiben) a.betrag = -a.betrag;
      }
    }
  }

  // ladeArchiv() gibt den gehaltenen Stand selbst zurück – oben wurde also
  // bereits darin geändert, speichereArchiv() schreibt genau das.
  if (schreiben && betroffen.length) speichereArchiv();
  return {
    anzahl: betroffen.length,
    summe: betroffen.reduce((n, x) => n + x.vorher, 0),
    eintraege: betroffen,
    geschrieben: schreiben && betroffen.length > 0,
  };
}

/**
 * Eine Reihe von Ausschüttungsbuchungen auswerten.
 *
 * Zwei Quellen, die nicht vermischt werden dürfen:
 *
 *   **Kassenbuch** – unter „Ausschüttung" stehen beide Richtungen, Zufluss und
 *   Abfluss. Was eine Richtung *bedeutet*, steht nicht dabei: ob ein Zufluss
 *   der Firma bleibt oder nur durchläuft, ob ein Abfluss Gebühr, Steuer oder
 *   Abschöpfung ist. Deshalb heißen die Felder `zugeflossen` und `summe`
 *   (Abfluss) und sonst nichts.
 *
 *   **Gewinnzähler** – `gewinnVorher` am Eintrag, vor jeder Abschöpfung
 *   gemessen. Von der Buchungsart unabhängig und die belastbarere Zahl.
 *
 * Hier standen einmal `behalten`, `erwirtschaftet` und `anteilAb`, die beides
 * zusammenrechneten. Das setzte voraus, dass ein Zufluss bei der Firma bleibt
 * und ein Abfluss verloren ist – gedeutet, nicht gemessen, und die Deutung war
 * falsch. Wer eine Aussage über Gewinn braucht, nimmt `gewinnGemessen`.
 */
export function ausschuettungSumme(eintraege) {
  const zu = eintraege.filter(a => (a.betrag || 0) > 0);
  const ab = eintraege.filter(a => (a.betrag || 0) < 0);

  const abgefuehrt = ab.reduce((n, a) => n - a.betrag, 0);
  const betraege = ab.map(a => -a.betrag);
  const gemessen = ab.filter(a => Number.isFinite(a.gewinnVorher));

  return {
    // --- Abflussseite: danach wird am häufigsten gefragt ---
    anzahl: ab.length,
    betraege,
    summe: abgefuehrt,
    schnitt: ab.length ? Math.round(abgefuehrt / ab.length) : 0,
    groesste: betraege.length ? Math.max(...betraege) : 0,
    erste: ab[0] || eintraege[0] || null,
    letzte: ab[ab.length - 1] || eintraege[eintraege.length - 1] || null,

    // --- Zuflussseite ---
    zugeflossen: zu.reduce((n, a) => n + a.betrag, 0),
    zuAnzahl: zu.length,

    // --- Gewinnzähler, unabhängig vom Kassenbuch ---
    gewinnGemessen: gemessen.reduce((n, a) => n + a.gewinnVorher, 0),
    gemessenAnzahl: gemessen.length,
    // Für wie viele Abschöpfungen die Messung fehlt. Ohne diese Angabe liest
    // sich eine Lücke wie ein Tag ohne Gewinn – dabei fehlt nur die Zahl.
    ohneMessung: ab.length - gemessen.length,
    gewinnHoechst: gemessen.length ? Math.max(...gemessen.map(a => a.gewinnVorher)) : 0,
    gewinnNiedrigst: gemessen.length ? Math.min(...gemessen.map(a => a.gewinnVorher)) : 0,

    // Alle Buchungen, beide Richtungen, in der Reihenfolge des Tages.
    alle: eintraege,
  };
}

/**
 * Anteil eines Spielers an der Gesamtzeit einer Spanne, in Prozent.
 * Grundlage für eine spätere Ausschüttungsrechnung nach Anwesenheit: die
 * Zahlen liegen im Archiv, die Verteilung entscheidet der Inhaber.
 */
export function anteile(tage) {
  const s = summiere(tage);
  return s.spieler.map(p => ({
    ...p,
    anteil: s.gesamtMs ? p.ms / s.gesamtMs : 0,
    prozent: s.gesamtMs ? Math.round(p.ms / s.gesamtMs * 1000) / 10 : 0,
  }));
}
