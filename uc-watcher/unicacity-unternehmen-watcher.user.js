// ==UserScript==
// @name         UnicaCity Unternehmen-Watcher
// @namespace    https://unicacity.eu/
// @version      4.1.0
// @description  Überwacht Lager, Personal, Kasse und Vorfälle, trackt Online-Zeiten der Spieler und pusht aufs Handy (ntfy.sh).
// @match        https://unicacity.eu/dashboard/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        unsafeWindow
// @grant        GM_setClipboard
// @connect      unicacity.eu
// @connect      ntfy.sh
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* ========================= KONFIGURATION ========================= */

  const CONFIG = {
    // ---- Push ----
    NTFY_TOPIC:  'HIER-EIGENES-TOPIC-EINTRAGEN',   // z.B. 'uc-firma-9f3a2b7c'
    NTFY_SERVER: 'https://ntfy.sh',

    // ---- Schwellwerte ----
    LAGER_SCHWELLE: 500,
    PERSONAL_SOLL:  6,      // Rückfallwert, falls die Seite kein "x/y" zeigt.
                            // Gemeint ist die PERSONAL-Kachel (NPCs, 6/6),
                            // NICHT die TEAM-Leiste (Spieler, 5/8).
    ERINNERUNG_MIN: 60,     // Cooldown je Thema

    // ---- Steuerprüfung: 4 % bezahlt, 8 % ignoriert ----
    STEUER_NORMAL_PCT:    4,
    STEUER_IGNORIERT_PCT: 8,
    STEUER_TOLERANZ_PP:   0.6,

    // ---- Spieler-Online-Tracking ----
    // Bekannte Spielernamen. Hilft der Erkennung enorm und verhindert Fehltreffer.
    SPIELER: [
      'LottiMi',
      'maaxxyyy',
      'halo361',
      'Lexae',
      '777ELITE',
      'jqshey',      // kommt neu in die Firma
    ],

    // Optional: Container der Team-Leiste eingrenzen. Leer = ganze Seite.
    SEL_ONLINE: '',          // z.B. '#team-leiste'

    // Wann gilt ein Kästchen als grün? Deckt auch Türkis/Emerald (#2dd4bf) ab,
    // schließt aber Grautöne (#4b5563) aus.
    GRUEN_MIN_R_ABSTAND: 40, // Grün muss so viel heller sein als Rot
    GRUEN_MIN_B_ABSTAND: 10, // ... und so viel heller als Blau
    GRUEN_MIN_WERT:     100, // Mindesthelligkeit des Grünkanals

    ONLINE_FENSTER_MIN: 180, // Zeitfenster für "wer war online" in Meldungen
    LUECKE_MIN: 10,          // Pause > X Min. = neue Sitzung (statt durchgehend)
    TAGESWECHSEL_STD: 4,     // Tageszähler setzt um 04:00 zurück, nicht um Mitternacht

    // ---- Ausschüttung ----
    AUSSCHUETTUNG_STD:     12,    // benötigte Team-Onlinezeit bis zur nächsten
    AUSSCHUETTUNG_GEWINN_SCHWELLE: 1000, // Gewinn darunter = es wurde ausgeschüttet
    AUSSCHUETTUNG_STUNDENMELDUNG: true,  // bei jeder vollen Online-Stunde melden

    // ---- Takt ----
    POLL_INTERVAL_MS:   60 * 1000,   // wie oft der Zustand gelesen wird
    RELOAD_INTERVAL_MS: 5 * 60 * 1000, // wie oft die Seite neu geladen wird

    // ---- Selektoren fürs Unternehmen (leer = Auto-Suche über Labels) ----
    SEL: {
      lager:     '',
      personal:  '',
      kasse:     '',
      gewinn:    '',
      vorfaelle: '',
    },

    DEBUG: false,
  };

  const LABELS = {
    lager:    ['lagerbestand', 'lager', 'bestand', 'warenlager'],
    personal: ['personal', 'mitarbeiter', 'angestellte', 'belegschaft'],
    kasse:    ['firmenkasse', 'kasse', 'guthaben', 'kontostand', 'firmenkonto'],
    gewinn:   ['gewinn seit ausschüttung', 'gewinn seit', 'gewinn', 'profit'],
  };

  // Nur eindeutige Vorfall-Begriffe. Harmlose Wörter wie "Kontrolle" oder
  // "Brand" sind draußen, weil sie sonst im Kassenbuch Fehlalarme auslösen.
  const VORFALL_WORTE = [
    'vorfall', 'vorfälle', 'steuerprüfung', 'steuerpruefung', 'razzia',
    'überfall', 'ueberfall', 'einbruch', 'diebstahl', 'abwerbung', 'abgeworben',
    'bußgeld', 'bussgeld', 'sabotage', 'streik',
  ];

  /* ====================== AB HIER NICHTS ÄNDERN ====================== */

  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

  /* ---------- API-Rekorder ----------
     Die Seite ist eine React-Anwendung und lädt ihre Zahlen per API nach.
     Damit wir für die Server-Variante wissen, welche Adressen das sind,
     werden fetch und XMLHttpRequest mitgeschnitten. Nur Adressen und die
     Struktur der Antwort – Token werden unkenntlich gemacht.               */

  const API_LOG = [];
  const MAX_LOG = 40;

  const anonym = t => String(t)
    .replace(/([?&](token|auth|key|session)=)[^&#]+/gi, '$1«ENTFERNT»')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '«TOKEN»')
    .replace(/\b[a-f0-9]{32,}\b/gi, '«HASH»');

  // Welche Felder hat die Antwort? (rekursiv, aber flach gehalten)
  function struktur(wert, tiefe = 0) {
    if (wert === null || tiefe > 2) return typeof wert;
    if (Array.isArray(wert)) return wert.length ? [struktur(wert[0], tiefe + 1)] : [];
    if (typeof wert === 'object') {
      const o = {};
      for (const k of Object.keys(wert).slice(0, 25)) {
        const v = wert[k];
        o[k] = (typeof v === 'object' && v !== null) ? struktur(v, tiefe + 1)
             : (typeof v === 'string' && v.length > 40) ? 'string(lang)'
             : v;
      }
      return o;
    }
    return wert;
  }

  function merke(methode, url, status, text) {
    if (/ntfy\.sh/.test(url)) return;
    let inhalt = null;
    try { inhalt = struktur(JSON.parse(text)); } catch (_) { inhalt = '(kein JSON)'; }
    API_LOG.push({ zeit: new Date().toLocaleTimeString('de-DE'),
                   methode, url: anonym(url), status, inhalt });
    if (API_LOG.length > MAX_LOG) API_LOG.shift();
  }

  (function installiereRekorder() {
    const echtesFetch = W.fetch;
    if (echtesFetch) {
      W.fetch = function (...args) {
        const url = (args[0] && args[0].url) || String(args[0]);
        return echtesFetch.apply(this, args).then(res => {
          res.clone().text().then(t => merke(res.type || 'GET', url, res.status, t)).catch(() => {});
          return res;
        });
      };
    }
    const XHR = W.XMLHttpRequest;
    if (XHR) {
      const open = XHR.prototype.open, send = XHR.prototype.send;
      XHR.prototype.open = function (m, u, ...r) { this._ucM = m; this._ucU = u; return open.call(this, m, u, ...r); };
      XHR.prototype.send = function (...a) {
        this.addEventListener('load', () => {
          try { merke(this._ucM, this._ucU, this.status, this.responseText); } catch (_) {}
        });
        return send.apply(this, a);
      };
    }
  })();

  const KEY = 'uc_watcher_v3';
  const log = (...a) => CONFIG.DEBUG && console.log('[UC-Watcher]', ...a);
  const MIN = 60_000;

  const leererStand = () => ({
    lager: null, personal: null, personalSoll: null, kasse: null,
    vorfaelle: [],
    spieler: {},      // name -> { online, seit, sitzungMs, gesamtMs, zuletzt, tag }
    gewinn: null,
    teamOnlineMs: 0,  // Team-Onlinezeit seit der letzten Ausschüttung (ohne Doppelzählung)
    gemeldeteStunde: 0, faelligGemeldet: false, // bis zu welcher vollen Stunde schon gemeldet wurde
    letzteAusschuettung: null,
    letzterTick: null,
    lastPush: {},
  });

  const load = () => Object.assign(leererStand(), GM_getValue(KEY, {}));
  const save = s => GM_setValue(KEY, s);

  // Spieltag: läuft von 04:00 bis 04:00 des Folgetags
  const heute = () => {
    const d = new Date(Date.now() - CONFIG.TAGESWECHSEL_STD * 3_600_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function dauer(ms) {
    if (!ms || ms < MIN) return '<1 Min.';
    const h = Math.floor(ms / 3_600_000), m = Math.round((ms % 3_600_000) / MIN);
    return h ? `${h} Std. ${m} Min.` : `${m} Min.`;
  }

  /* ---------- Werte aus dem Dashboard lesen ---------- */

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

  // Die drei Kacheln oben sind aufgebaut als
  //     <div>473.238$</div><p>Firmenkasse · reicht 79 Std 20 Min</p>
  //     <div>1284 / 1500</div><p>Lager · 36 Einheiten/Min Absatz</p>
  //     <div>6 / 6</div><p>Personal · 131% Effizienz</p>
  // Der Wert steht also IMMER im Element direkt VOR dem Label.
  function leseKacheln(doc) {
    const res = {};
    for (const el of doc.querySelectorAll('p, span')) {
      const label = (el.textContent || '').trim();
      const vorher = el.previousElementSibling;
      if (!vorher) continue;
      const wert = (vorher.textContent || '').trim();
      if (!wert || wert.length > 30) continue;

      if (res.kasse === undefined && /^Firmenkasse\b/i.test(label)) {
        const n = toNumber(wert);
        if (n !== null) res.kasse = { value: n, text: `${wert} | ${label}` };
      } else if (res.lager === undefined && /^Lager\b/i.test(label)) {
        // "1284 / 1500" – uns interessiert der Bestand, nicht die Kapazität
        const f = wert.match(/(\d[\d.,]*)\s*\/\s*(\d[\d.,]*)/);
        if (f) res.lager = { value: toNumber(f[1]), kapazitaet: toNumber(f[2]),
                             text: `${wert} | ${label}` };
      } else if (res.personal === undefined && /^Personal\b/i.test(label)) {
        const f = wert.match(/(\d+)\s*\/\s*(\d+)/);
        if (f) res.personal = { ist: +f[1], soll: +f[2], quelle: `${wert} | ${label}` };
      }
    }
    return res;
  }

  // "Gewinn seit Ausschüttung" steht als Label ÜBER seinem Wert:
  //     <p>Gewinn seit Ausschüttung</p><p>157.285$</p>
  // Das Label muss EXAKT stimmen – sonst greift die Suche auch auf
  // Eltern-Elemente zu, die den Text nur enthalten, und landet im Kassenbuch.
  function leseGewinn(doc) {
    for (const el of doc.querySelectorAll('p, span, div, dt, th')) {
      const t = (el.textContent || '').trim();
      if (!/^Gewinn seit Ausschüttung$/i.test(t)) continue;
      if (el.closest('table')) continue;              // Kassenbuch ausschließen

      // Wert steht im Geschwister-Element – erst dahinter, dann davor
      const geschwister = el.parentElement
        ? [...el.parentElement.children].filter(k => k !== el)
        : [el.nextElementSibling, el.previousElementSibling].filter(Boolean);

      for (const k of geschwister) {
        const roh = (k.textContent || '').trim();
        if (!roh || roh.length > 30) continue;
        const n = toNumber(roh);
        if (n !== null) return { value: n, text: roh, quelle: `${t} → ${roh}` };
      }
    }
    return null;
  }

  // Die Karte, deren Kopfzeile den angegebenen Titel trägt (z.B. "Meldungen")
  function findeKarte(doc, titel) {
    for (const el of doc.querySelectorAll('span')) {
      if ((el.textContent || '').trim().toLowerCase() !== titel.toLowerCase()) continue;
      const karte = el.closest('.bg-card');
      if (karte) return karte;
    }
    return null;
  }

  function read(doc, key) {
    const sel = CONFIG.SEL[key];
    if (sel) {
      const el = doc.querySelector(sel);
      if (el) return { value: toNumber(el.textContent), text: el.textContent.trim() };
      log('Selektor liefert nichts:', key, sel);
    }
    if (key === 'gewinn') return leseGewinn(doc);
    const k = leseKacheln(doc);
    return k[key] || null;
  }

  function readPersonal(doc) {
    if (CONFIG.SEL.personal) {
      const el = doc.querySelector(CONFIG.SEL.personal);
      const f = el && (el.textContent || '').match(/(\d+)\s*\/\s*(\d+)/);
      if (f) return { ist: +f[1], soll: +f[2], quelle: el.textContent.trim() };
    }
    return leseKacheln(doc).personal || null;
  }

  /* ---------- Online-Spieler aus der Team-Leiste ---------- */

  // Nur die Team-Leiste durchsuchen! Die NPC-Mitarbeiter darüber haben
  // ebenfalls grüne Punkte – die dürfen nicht als Spieler gezählt werden.
  function teamLeiste(doc) {
    if (CONFIG.SEL_ONLINE) return doc.querySelector(CONFIG.SEL_ONLINE);
    for (const el of doc.querySelectorAll('p, span')) {
      if (/^\s*Team\s*·/i.test((el.textContent || '').trim())) return el.parentElement;
    }
    return null;
  }

  function istGruen(farbe) {
    const m = String(farbe).match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i);
    if (!m) return false;
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    const a = m[4] === undefined ? 1 : +m[4];
    if (a < 0.3) return false;
    return g >= CONFIG.GRUEN_MIN_WERT
        && g - r >= CONFIG.GRUEN_MIN_R_ABSTAND
        && g - b >= CONFIG.GRUEN_MIN_B_ABSTAND;
  }

  function kaestchenGruen(el) {
    const cs = getComputedStyle(el);
    return [cs.backgroundColor, cs.color, cs.borderColor].some(istGruen);
  }

  // Ein Chip sieht so aus:
  //   <span>  <span class="bg-emerald-400"></span> halo361 <span>Manager</span>  </span>
  // Der erste leere Unter-Span ist der Statuspunkt.
  function spielerChips(doc) {
    const box = teamLeiste(doc);
    if (!box) return [];

    const chips = [];
    for (const chip of box.querySelectorAll('span')) {
      const txt = (chip.textContent || '').trim();
      if (!txt) continue;
      const name = CONFIG.SPIELER.find(n =>
        new RegExp('^' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(txt));
      if (!name) continue;
      const punkt = [...chip.querySelectorAll('span')].find(s => !(s.textContent || '').trim());
      if (!punkt) continue;
      chips.push({ name, chip, punkt });
    }
    return chips;
  }

  function readOnlineSpieler(doc) {
    if (doc !== document) return null;          // Farben nur im echten DOM
    const online = new Set();
    for (const { name, punkt } of spielerChips(document)) {
      if (kaestchenGruen(punkt)) online.add(name);
    }
    return [...online];
  }

  /* ---------- Online-Zeiten fortschreiben ---------- */

  function updateSpieler(state, onlineJetzt) {
    const now = Date.now();
    const tag = heute();
    const online = new Set(onlineJetzt);

    for (const name of online) {
      const p = state.spieler[name] || { online: false, seit: null, sitzungMs: 0, gesamtMs: 0, zuletzt: 0, tag };
      if (p.tag !== tag) { p.gesamtMs = 0; p.tag = tag; }   // neuer Spieltag (04:00)

      const luecke = now - (p.zuletzt || 0);
      if (!p.online || luecke > CONFIG.LUECKE_MIN * MIN) {
        p.online = true;
        p.seit = now;                                        // neue Sitzung
        p.sitzungMs = 0;
      } else {
        p.sitzungMs = now - p.seit;
        p.gesamtMs += Math.min(luecke, CONFIG.LUECKE_MIN * MIN);
      }
      p.zuletzt = now;
      state.spieler[name] = p;
    }

    for (const [name, p] of Object.entries(state.spieler)) {
      if (online.has(name)) continue;
      if (p.online) { p.online = false; p.sitzungMs = (p.zuletzt || now) - (p.seit || now); }
    }
  }

  // Team-Onlinezeit: Wandzeit, in der MINDESTENS EIN Spieler online war.
  // Sind mehrere gleichzeitig online, zählt die Zeit trotzdem nur einmal.
  function updateTeamzeit(state, irgendwerOnline) {
    const now = Date.now();
    const letzter = state.letzterTick;
    state.letzterTick = now;
    if (!letzter) return;                                  // erster Durchlauf

    const luecke = now - letzter;
    if (luecke > CONFIG.LUECKE_MIN * MIN) return;           // Browser war aus – nicht zählen
    if (irgendwerOnline) state.teamOnlineMs += luecke;
  }

  // Liste "wer war online + wie lange" für Meldungen
  function onlineBericht(state, fensterMin = CONFIG.ONLINE_FENSTER_MIN) {
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

  /* ---------- Vorfälle ---------- */

  // Die Meldungen-Karte sagt im Normalfall "Alles ruhig". Steht dort etwas
  // anderes, ist ein Vorfall aktiv – das ist viel zuverlässiger als eine
  // Stichwortsuche über die ganze Seite.
  function readVorfaelle(doc) {
    const karte = findeKarte(doc, 'Meldungen');
    const gefunden = [];

    if (karte) {
      const titel = (karte.querySelector('h2')?.textContent || '').trim();
      const unter = (karte.querySelector('h2')?.nextElementSibling?.textContent || '').trim();
      if (titel && !/^alles ruhig/i.test(titel)) {
        gefunden.push(unter ? `${titel} — ${unter}` : titel);
      }
    } else log('Meldungen-Karte nicht gefunden');

    // Zusätzlich: Stichwörter irgendwo auf der Seite (z.B. Steuerprüfung)
    const root = doc.querySelector('main') || doc.body;
    if (root) {
      for (const el of root.querySelectorAll('p, h2, td, li')) {
        if (el.children.length > 2) continue;
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt || txt.length > 200) continue;
        if (VORFALL_WORTE.some(w => txt.toLowerCase().includes(w))) gefunden.push(txt);
      }
    }
    return [...new Set(gefunden)];
  }

  /* ---------- Ausschüttung ---------- */

  // Eine Ausschüttung erkennt man daran, dass "Gewinn seit Ausschüttung"
  // zurückgesetzt wurde, also unter die Schwelle (Standard 1.000) fällt.
  // Danach werden 12 Std. Team-Onlinezeit bis zur nächsten gebraucht.
  function pruefeAusschuettung(state, doc) {
    const ziel = CONFIG.AUSSCHUETTUNG_STD * 3_600_000;
    const g = read(doc, 'gewinn');

    if (g && g.value !== null) {
      const vorher = state.gewinn;
      const schwelle = CONFIG.AUSSCHUETTUNG_GEWINN_SCHWELLE;

      // Reset erkannt: war drüber, ist jetzt drunter
      if (vorher !== null && vorher >= schwelle && g.value < schwelle) {
        state.letzteAusschuettung = Date.now();
        state.teamOnlineMs = 0;
        state.gemeldeteStunde = 0;
        state.faelligGemeldet = false;
        state.lastPush.ausschuettung_faellig = 0;   // Cooldown für die nächste freigeben
        push('ausschuettung_erfolgt', '💰 Ausschüttung erfolgt',
          `Gewinn zurückgesetzt: ${fmt(vorher)} → ${fmt(g.value)}\n` +
          `Zähler für die nächste Ausschüttung läuft neu: ` +
          `0 von ${CONFIG.AUSSCHUETTUNG_STD} Std. Team-Onlinezeit.`,
          state, 'default');
      }
      state.gewinn = g.value;
    } else log('Gewinn seit Ausschüttung nicht gefunden');

    // Jede volle Online-Stunde melden (1/12, 2/12, ...)
    const stunden = Math.floor(state.teamOnlineMs / 3_600_000);
    if (CONFIG.AUSSCHUETTUNG_STUNDENMELDUNG
        && stunden > (state.gemeldeteStunde || 0)
        && stunden < CONFIG.AUSSCHUETTUNG_STD) {
      state.gemeldeteStunde = stunden;
      const rest = ziel - state.teamOnlineMs;
      const wer = Object.entries(state.spieler).filter(([, p]) => p.online).map(([n]) => n);
      // eigenes Thema je Stunde, damit der Cooldown nicht dazwischenfunkt
      push(`ausschuettung_std_${stunden}`, `⏱️ ${stunden} von ${CONFIG.AUSSCHUETTUNG_STD} Std. bis zur Ausschüttung`,
        `Team-Onlinezeit: ${dauer(state.teamOnlineMs)}\n` +
        `Noch ${dauer(rest)} bis zur nächsten Ausschüttung.` +
        (state.gewinn !== null ? `\nGewinn bisher: ${fmt(state.gewinn)}` : '') +
        (wer.length ? `\n\nGerade online: ${wer.join(', ')}` : ''),
        state, 'low');
    }

    // Ziel erreicht?
    if (state.teamOnlineMs >= ziel && !state.faelligGemeldet) {
    state.faelligGemeldet = true;
      push('ausschuettung_faellig', '💰 Ausschüttung ist fällig',
        `${CONFIG.AUSSCHUETTUNG_STD} Std. Team-Onlinezeit erreicht ` +
        `(${dauer(state.teamOnlineMs)}).` +
        (state.gewinn !== null ? `\nAktueller Gewinn: ${fmt(state.gewinn)}` : ''),
        state, 'high');
    }
  }

  // Restzeit bis zur nächsten Ausschüttung
  function ausschuettungStand(state) {
    const ziel = CONFIG.AUSSCHUETTUNG_STD * 3_600_000;
    const rest = Math.max(0, ziel - state.teamOnlineMs);
    return {
      erreicht: dauer(state.teamOnlineMs),
      ziel: `${CONFIG.AUSSCHUETTUNG_STD} Std.`,
      fehlt: rest ? dauer(rest) : 'fällig',
      prozent: Math.min(100, Math.round(state.teamOnlineMs / ziel * 100)) + ' %',
      zuletztGemeldet: (state.gemeldeteStunde || 0) + ' Std.',
      letzteAusschuettung: state.letzteAusschuettung
        ? new Date(state.letzteAusschuettung).toLocaleString('de-DE') : 'unbekannt',
      gewinn: state.gewinn,
    };
  }

  /* ---------- Push ---------- */

  // ntfy-Prioritäten sind Zahlen: 1 min ... 5 max
  const PRIO = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };

  function ntfyBody(titel, text, prio) {
    return JSON.stringify({
      topic: CONFIG.NTFY_TOPIC,
      title: titel,
      message: text,
      priority: PRIO[prio] || 4,
      tags: ['office'],
      click: location.href,
    });
  }

  // Weg 1: normales fetch der Seite. ntfy erlaubt CORS, das funktioniert also
  // direkt und umgeht die Tampermonkey-Brücke komplett.
  function sendeFetch(body) {
    return fetch(CONFIG.NTFY_SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return 'fetch';
    });
  }

  // Weg 2: GM_xmlhttpRequest. Greift, wenn die Seite per CSP kein fetch
  // nach außen zulässt.
  function sendeGM(body) {
    return new Promise((ok, fehler) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.NTFY_SERVER,
        headers: { 'Content-Type': 'application/json' },
        data: body,
        timeout: 15000,
        onload: r => (r.status >= 200 && r.status < 300)
          ? ok('GM_xmlhttpRequest')
          : fehler(new Error('HTTP ' + r.status + ' ' + r.responseText)),
        onerror:   () => fehler(new Error('Verbindung fehlgeschlagen')),
        ontimeout: () => fehler(new Error('Zeitüberschreitung')),
      });
    });
  }

  async function sendeNtfy(titel, text, prio) {
    const body = ntfyBody(titel, text, prio);
    const fehler = [];
    for (const [name, fn] of [['fetch', sendeFetch], ['GM_xmlhttpRequest', sendeGM]]) {
      try { return await fn(body); }
      catch (e) { fehler.push(`${name}: ${e.message}`); }
    }
    throw new Error(fehler.join(' | '));
  }

  function push(thema, titel, text, state, prio = 'high') {
    const now = Date.now();
    if (now - (state.lastPush[thema] || 0) < CONFIG.ERINNERUNG_MIN * MIN) {
      return log('Cooldown, unterdrückt:', thema);
    }
    state.lastPush[thema] = now;

    // Browser-Hinweis kommt immer, auch wenn das Netz gerade klemmt
    try { GM_notification({ title: titel, text, timeout: 20000, onclick: () => W.focus() }); } catch (_) {}
    log('PUSH:', titel, '\n' + text);

    if (!CONFIG.NTFY_TOPIC || CONFIG.NTFY_TOPIC.startsWith('HIER-')) {
      return console.warn('[UC-Watcher] Kein ntfy-Topic gesetzt – nur Browser-Hinweis.');
    }

    sendeNtfy(titel, text, prio)
      .then(weg => log('ntfy gesendet über', weg))
      .catch(e => console.error(
        '[UC-Watcher] ntfy nicht erreichbar –', e.message,
        '\nPrüfen: 1) https://ntfy.sh im Browser aufrufbar?',
        '2) Adblocker/DNS-Filter aktiv? 3) Internetverbindung stabil?'));
  }

  const fmt = n => n.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' $';

  /* ---------- Hauptprüfung ---------- */

  function check(doc) {
    const state = load();

    // --- Online-Zeiten fortschreiben (nur aus dem echten DOM: Farben) ---
    const online = readOnlineSpieler(document);
    if (online !== null) {
      updateSpieler(state, online);
      updateTeamzeit(state, online.length > 0);
    }

    // --- 1) Lager ---
    const lager = read(doc, 'lager');
    if (lager && lager.value !== null) {
      if (lager.value < CONFIG.LAGER_SCHWELLE) {
        push('lager', '⚠️ Lagerbestand niedrig',
          `Lager: ${lager.value}${lager.kapazitaet ? ' / ' + lager.kapazitaet : ''} ` +
          `(Schwelle ${CONFIG.LAGER_SCHWELLE}) – nachfüllen.`, state);
      } else if (state.lager !== null && state.lager < CONFIG.LAGER_SCHWELLE) {
        state.lastPush.lager = 0;
      }
      state.lager = lager.value;
    } else log('Lager nicht gefunden');

    // --- 2) Personal (NPCs): jede Änderung melden, mit Online-Spielern ---
    const p = readPersonal(doc);
    if (p && p.ist !== null) {
      const soll = p.soll || CONFIG.PERSONAL_SOLL;
      const alt = state.personal;

      if (alt !== null && p.ist !== alt) {
        const gefallen = p.ist < alt;
        const bericht = onlineBericht(state);
        const wer = bericht.length
          ? `\n\nOnline zum Zeitpunkt der Änderung:\n${bericht.join('\n')}`
          : '\n\n(Keine Online-Daten – SPIELER-Liste prüfen.)';

        push(
          `personal_change_${p.ist}`,
          gefallen ? '🚨 Personal abgeworben' : 'ℹ️ Personal aufgestockt',
          `Personal: ${alt}/${soll} → ${p.ist}/${soll}` +
          (gefallen
            ? `\n${alt - p.ist} NPC${alt - p.ist > 1 ? 's' : ''} weg – Abwerbung wurde nicht abgewendet.`
            : `\n+${p.ist - alt} eingestellt.`) +
          wer,
          state, gefallen ? 'urgent' : 'default');
      } else if (p.ist < soll) {
        const bericht = onlineBericht(state);
        push('personal_unterbesetzt', '⚠️ Personal unvollständig',
          `Personal: ${p.ist}/${soll} – ${soll - p.ist} fehlen.` +
          (bericht.length ? `\n\nOnline:\n${bericht.join('\n')}` : ''), state);
      }
      state.personal = p.ist;
      state.personalSoll = soll;
    } else log('Personal-Kachel nicht gefunden');

    // --- 3a) Vorfälle ---
    const vorfaelle = readVorfaelle(doc);
    const neue = vorfaelle.filter(v => !state.vorfaelle.includes(v));
    if (neue.length) {
      const bericht = onlineBericht(state);
      push('vorfall_' + neue[0].slice(0, 24), '🚨 Vorfall im Unternehmen',
        neue.join('\n') + (bericht.length ? `\n\nOnline:\n${bericht.join('\n')}` : ''),
        state, 'urgent');
    }
    state.vorfaelle = [...new Set([...state.vorfaelle, ...vorfaelle])].slice(-50);

    // --- 3b) Steuerprüfung aus dem Kassenverlauf ---
    const kasse = read(doc, 'kasse');
    if (kasse && kasse.value !== null) {
      if (state.kasse !== null && state.kasse > 0 && kasse.value < state.kasse) {
        const diff = state.kasse - kasse.value;
        const pct  = (diff / state.kasse) * 100;
        const nahe = ziel => Math.abs(pct - ziel) <= CONFIG.STEUER_TOLERANZ_PP;

        if (nahe(CONFIG.STEUER_IGNORIERT_PCT)) {
          const bericht = onlineBericht(state);
          push('steuer_ignoriert', '🚨 Steuerprüfung wurde IGNORIERT',
            `Firmenkasse: ${fmt(state.kasse)} → ${fmt(kasse.value)}\n` +
            `Abzug: ${fmt(diff)} (${pct.toFixed(2)} % statt ${CONFIG.STEUER_NORMAL_PCT} %)\n` +
            `Vermeidbare Mehrkosten: ${fmt(diff / 2)}\n\n` +
            (bericht.length
              ? `Online zum Zeitpunkt der Prüfung:\n${bericht.join('\n')}`
              : '(Keine Online-Daten erfasst.)'),
            state, 'urgent');
        } else if (nahe(CONFIG.STEUER_NORMAL_PCT)) {
          push('steuer_normal', 'ℹ️ Steuerprüfung bezahlt',
            `Firmenkasse: ${fmt(state.kasse)} → ${fmt(kasse.value)}\n` +
            `Abzug: ${fmt(diff)} (${pct.toFixed(2)} % – regulär bearbeitet).`, state, 'default');
        }
      }
      state.kasse = kasse.value;
    } else log('Kasse nicht gefunden');

    // --- 4) Ausschüttung ---
    pruefeAusschuettung(state, doc);

    save(state);
    log('geprüft', { lager: state.lager, personal: state.personal, kasse: state.kasse,
                     teamOnline: dauer(state.teamOnlineMs) });
  }

  /* ---------- Antrieb ---------- */

  // Die Online-Kästchen sind nur im gerenderten Dokument farbig, deshalb wird
  // der echte Tab regelmäßig neu geladen statt im Hintergrund zu fetchen.
  function starteReload() {
    setTimeout(() => location.reload(), CONFIG.RELOAD_INTERVAL_MS);
  }

  // Live-Änderungen im offenen Tab sofort mitnehmen (debounced)
  function beobachte() {
    const root = (CONFIG.SEL_ONLINE && document.querySelector(CONFIG.SEL_ONLINE))
      || document.querySelector('main') || document.body;
    if (!root) return;
    let t = null;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => check(document), 2000);
    }).observe(root, { childList: true, subtree: true, characterData: true });
  }

  /* ---------- Konsolen-Werkzeuge ---------- */

  W.ucWatcherTest = function () {
    const k = leseKacheln(document);
    const g = leseGewinn(document);
    const zeile = (o, wert, quelle) => o ? { Wert: wert, Quelle: quelle } : { Wert: '— NICHT GEFUNDEN —', Quelle: '' };

    console.table({
      Lager:       zeile(k.lager,    k.lager    && `${k.lager.value} / ${k.lager.kapazitaet}`,     k.lager && k.lager.text),
      Personal:    zeile(k.personal, k.personal && `${k.personal.ist}/${k.personal.soll}`,          k.personal && k.personal.quelle),
      Firmenkasse: zeile(k.kasse,    k.kasse    && k.kasse.value,                                   k.kasse && k.kasse.text),
      Gewinn:      zeile(g,          g          && g.value,                                         g && g.quelle),
    });

    const chips = spielerChips(document);
    const spieler = {};
    for (const { name, punkt } of chips) {
      spieler[name] = {
        Status: kaestchenGruen(punkt) ? '🟢 online' : '⚪ offline',
        Farbe:  getComputedStyle(punkt).backgroundColor,
      };
    }
    if (chips.length) console.table(spieler);
    else console.warn('Keine Spieler-Chips gefunden – Team-Leiste nicht erkannt.');

    console.log('Online:', readOnlineSpieler(document));
    console.log('Vorfälle:', readVorfaelle(document));
  };

  W.ucWatcherZeiten = function () {
    const s = load();
    const rows = {};
    for (const [name, p] of Object.entries(s.spieler)) {
      rows[name] = {
        Status:  p.online ? 'online' : 'offline',
        Sitzung: p.online ? dauer(Date.now() - p.seit) : dauer(p.sitzungMs),
        Heute:   dauer(p.gesamtMs),
        Zuletzt: p.zuletzt ? new Date(p.zuletzt).toLocaleTimeString('de-DE') : '–',
      };
    }
    console.table(rows);
    return rows;
  };

  // Zeigt pro Spieler die gemessenen Farben – zum Nachjustieren von GRUEN_ABSTAND
  W.ucWatcherDump = function () {
    for (const name of CONFIG.SPIELER) {
      const karte = findeKarte(document.body, name);
      if (!karte) { console.log(name, '– Karte nicht gefunden'); continue; }
      const farben = [karte, ...karte.querySelectorAll('*')].map(el => {
        const cs = getComputedStyle(el);
        return { tag: el.tagName, klasse: el.className, bg: cs.backgroundColor, color: cs.color };
      });
      console.groupCollapsed(`${name} – ${readOnlineSpieler(document).includes(name) ? 'ONLINE' : 'offline'}`);
      console.log(karte.outerHTML.slice(0, 600));
      console.table(farben);
      console.groupEnd();
    }
  };

  W.ucWatcherAusschuettung = function () {
    const stand = ausschuettungStand(load());
    console.table(stand);
    return stand;
  };

  // Prüft beide Sendewege einzeln und sagt, welcher funktioniert
  W.ucWatcherPushTest = async function () {
    if (!CONFIG.NTFY_TOPIC || CONFIG.NTFY_TOPIC.startsWith('HIER-')) {
      console.error('Kein NTFY_TOPIC eingetragen – oben im Skript nachtragen.');
      return;
    }
    console.log('Topic:', CONFIG.NTFY_TOPIC, '· Server:', CONFIG.NTFY_SERVER);
    const body = ntfyBody('✅ UC-Watcher Test',
      'Wenn du das auf dem Handy siehst, funktioniert die Benachrichtigung.', 'default');

    for (const [name, fn] of [['fetch', sendeFetch], ['GM_xmlhttpRequest', sendeGM]]) {
      try { await fn(body); console.log(`✅ ${name}: erfolgreich`); }
      catch (e) { console.error(`❌ ${name}: ${e.message}`); }
    }
    console.log('Kam mindestens eine Nachricht aufs Handy? Dann ist alles gut.');
  };

  // Bereitet den Seitenaufbau zum Weitergeben auf: entfernt Skripte, kürzt
  // Attribute auf class/id/style und macht Tokens/Mails unkenntlich.
  W.ucWatcherHTML = function () {
    const root = document.querySelector('main') || document.body;
    const kopie = root.cloneNode(true);

    kopie.querySelectorAll('script, style, noscript, svg, img, path').forEach(e => e.remove());
    kopie.querySelectorAll('*').forEach(el => {
      for (const a of [...el.attributes]) {
        if (!['class', 'id', 'style'].includes(a.name)) el.removeAttribute(a.name);
      }
    });

    let html = kopie.innerHTML
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '«TOKEN-ENTFERNT»')   // JWTs
      .replace(/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '«MAIL-ENTFERNT»')
      .replace(/\b[a-f0-9]{32,}\b/gi, '«HASH-ENTFERNT»')
      .replace(/>\s+</g, '><')
      .slice(0, 60000);

    try { GM_setClipboard(html); console.log('✅ In die Zwischenablage kopiert (%d Zeichen).', html.length); }
    catch (_) { console.log('Zwischenablage nicht verfügbar – Text unten markieren und kopieren.'); }
    console.log(html);
    return html.length + ' Zeichen';
  };

  // Zähler für die Ausschüttung neu starten – wenn das Skript eine
  // Ausschüttung verpasst hat (Browser war zu), ohne die Spielerzeiten
  // zu verlieren.
  W.ucWatcherAusschuettungStart = function () {
    const s = load();
    s.teamOnlineMs = 0;
    s.gemeldeteStunde = 0;
    s.faelligGemeldet = false;
    s.letzteAusschuettung = Date.now();
    save(s);
    console.log('Zähler neu gestartet: 0 von ' + CONFIG.AUSSCHUETTUNG_STD + ' Std.');
    return ausschuettungStand(s);
  };

  // Zeigt, welche Datenquellen die Seite anzapft – Grundlage für die
  // Server-Variante. Token und Hashes sind bereits unkenntlich gemacht.
  W.ucWatcherAPI = function () {
    if (!API_LOG.length) {
      console.warn('Noch nichts aufgezeichnet. Seite mit F5 neu laden und ' +
                   'kurz warten, dann ucWatcherAPI() erneut aufrufen.');
      return;
    }
    console.table(API_LOG.map(e => ({ Zeit: e.zeit, Methode: e.methode,
                                      Status: e.status, Adresse: e.url })));
    console.log('--- Aufbau der Antworten ---');
    for (const e of API_LOG) {
      console.groupCollapsed(e.url);
      console.log(JSON.stringify(e.inhalt, null, 2).slice(0, 4000));
      console.groupEnd();
    }
    const text = API_LOG.map(e =>
      `${e.methode} ${e.status} ${e.url}\n${JSON.stringify(e.inhalt, null, 2).slice(0, 3000)}`
    ).join('\n\n');
    try { GM_setClipboard(text); console.log('✅ In die Zwischenablage kopiert.'); } catch (_) {}
    return API_LOG.length + ' Aufrufe';
  };

  W.ucWatcherReset = function () { save(leererStand()); console.log('Zustand zurückgesetzt.'); };

  function starte() {
    check(document);
    setInterval(() => check(document), CONFIG.POLL_INTERVAL_MS);
    beobachte();
    starteReload();
  }

  // Der Rekorder läuft ab document-start, die DOM-Auswertung erst danach.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(starte, 1500));
  } else {
    setTimeout(starte, 1500);
  }

  if (!CONFIG.NTFY_TOPIC || CONFIG.NTFY_TOPIC.startsWith('HIER-')) {
    console.warn(
      '%c UC-Watcher %c Kein NTFY_TOPIC eingetragen – es kommen KEINE Pushes aufs Handy. ' +
      'Oben im Skript bei NTFY_TOPIC dein Topic eintragen und mit Strg+S speichern.',
      'background:#f59e0b;color:#000;font-weight:bold;border-radius:3px', 'color:inherit');
  }

  console.log(
    '%c UC-Watcher aktiv %c Befehle: ucWatcherTest() · ucWatcherZeiten() · ' +
    'ucWatcherAusschuettung() · ucWatcherDump() · ucWatcherPushTest() · ucWatcherHTML() · ucWatcherAusschuettungStart() · ucWatcherAPI() · ucWatcherReset()',
    'background:#2dd4bf;color:#000;font-weight:bold;border-radius:3px',
    'color:inherit');
})();
