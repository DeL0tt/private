// ==UserScript==
// @name         UnicaCity Unternehmen-Watcher
// @namespace    https://unicacity.eu/
// @version      3.2.0
// @description  Überwacht Lager, Personal, Kasse und Vorfälle, trackt Online-Zeiten der Spieler und pusht aufs Handy (ntfy.sh).
// @match        https://unicacity.eu/dashboard/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        unsafeWindow
// @connect      unicacity.eu
// @connect      ntfy.sh
// @run-at       document-idle
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

  const VORFALL_WORTE = [
    'vorfall', 'vorfälle', 'steuerprüfung', 'steuerpruefung', 'razzia',
    'überfall', 'ueberfall', 'einbruch', 'diebstahl', 'brand', 'kontrolle',
    'abwerbung', 'abgeworben', 'beschwerde', 'strafe', 'bußgeld', 'bussgeld',
  ];

  /* ====================== AB HIER NICHTS ÄNDERN ====================== */

  // Tampermonkey läuft in einer Sandbox. Für Konsolen-Befehle und window.focus()
  // brauchen wir das echte Seitenfenster.
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

  const KEY = 'uc_watcher_v3';
  const log = (...a) => CONFIG.DEBUG && console.log('[UC-Watcher]', ...a);
  const MIN = 60_000;

  const leererStand = () => ({
    lager: null, personal: null, personalSoll: null, kasse: null,
    vorfaelle: [],
    spieler: {},      // name -> { online, seit, sitzungMs, gesamtMs, zuletzt, tag }
    gewinn: null,
    teamOnlineMs: 0,  // Team-Onlinezeit seit der letzten Ausschüttung (ohne Doppelzählung)
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

  /* ---------- Zahlen-Parsing ---------- */

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

  // Eine Zeile/Element, das nur aus einer Zahl (mit Einheit) besteht.
  const nurZahl = t => /^[\s\d.,/%$€+-]+$/.test(t) && /\d/.test(t);

  // Findet das Label und nimmt die Zahl daraus. Steht dort keine, werden die
  // Nachbarn geprüft – zuerst DAVOR (Kachel-Layout: "412" über "LAGERBESTAND"),
  // dann dahinter. Nachbarn zählen nur, wenn sie reine Zahlen sind, damit nicht
  // der Wert der nächsten Kachel erwischt wird.
  function findByLabel(doc, words) {
    for (const el of doc.querySelectorAll('*')) {
      if (el.children.length > 2) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 60) continue;
      if (!words.some(w => t.toLowerCase().includes(w))) continue;

      const own = toNumber(t.replace(new RegExp(words.join('|'), 'gi'), ''));
      if (own !== null) return { value: own, text: t };

      for (const nachbar of [el.previousElementSibling, el.nextElementSibling]) {
        if (!nachbar) continue;
        const nt = (nachbar.textContent || '').trim();
        if (!nurZahl(nt)) continue;
        const n = toNumber(nt);
        if (n !== null) return { value: n, text: `${nt} | ${t}` };
      }
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
    return findByLabel(doc, LABELS[key] || []);
  }

  // Liest die PERSONAL-Kachel (NPCs), z.B.
  //     6/6
  //     PERSONAL · 131% EFFIZIENZ
  // Die Zahl steht ÜBER dem Label, deshalb wird in beide Richtungen gesucht.
  // Die TEAM-Leiste ("TEAM · 5 / 8") wird ausdrücklich ausgeschlossen –
  // das sind die Spieler, nicht die abwerbbaren NPCs.
  function readPersonal(doc) {
    if (CONFIG.SEL.personal) {
      const el = doc.querySelector(CONFIG.SEL.personal);
      if (el) {
        const f = (el.textContent || '').match(/(\d+)\s*\/\s*(\d+)/);
        if (f) return { ist: +f[1], soll: +f[2], quelle: el.textContent.trim() };
      }
    }

    const text = (doc.body?.innerText || doc.body?.textContent || '');
    const lines = text.split('\n').map(l => l.trim());

    for (let i = 0; i < lines.length; i++) {
      if (!/personal/i.test(lines[i])) continue;
      if (/\bteam\b/i.test(lines[i])) continue;           // TEAM-Leiste überspringen

      // Zahl in der Label-Zeile selbst, sonst 2 Zeilen davor/danach
      for (const j of [i, i - 1, i - 2, i + 1, i + 2]) {
        if (j < 0 || j >= lines.length) continue;
        if (/\bteam\b/i.test(lines[j])) continue;
        const f = lines[j].match(/(\d+)\s*\/\s*(\d+)/);
        if (f) return { ist: +f[1], soll: +f[2], quelle: `${lines[j]} | ${lines[i]}` };
      }
    }
    return null;
  }

  // Ein Spieler gilt als online, wenn das Kästchen vor seinem Namen grün ist.
  // Grau/dunkel = offline. Gemessen wird die tatsächlich gerenderte Farbe.
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

  // Farbquellen eines Kästchens: Hintergrund, Textfarbe, SVG-fill, Rahmen
  function kaestchenGruen(el) {
    const cs = getComputedStyle(el);
    if ([cs.backgroundColor, cs.color, cs.fill, cs.borderColor].some(istGruen)) return true;
    const vor = getComputedStyle(el, '::before');
    const nach = getComputedStyle(el, '::after');
    return [vor.backgroundColor, vor.color, nach.backgroundColor, nach.color].some(istGruen);
  }

  function readOnlineSpieler(doc) {
    // Farben gibt es nur im echten, gerenderten Dokument.
    if (doc !== document) return null;

    const root = (CONFIG.SEL_ONLINE && document.querySelector(CONFIG.SEL_ONLINE)) || document.body;
    if (!root) return [];

    const online = [];
    for (const name of CONFIG.SPIELER) {
      const karte = findeKarte(root, name);
      if (!karte) continue;
      // Das Kästchen ist ein kleines Element in der Karte – alle Kandidaten prüfen
      const kandidaten = [karte, ...karte.querySelectorAll('*')];
      if (kandidaten.some(kaestchenGruen)) online.push(name);
    }
    return online;
  }

  // Kleinstes Element, das genau diesen Spielernamen enthält
  function findeKarte(root, name) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    let treffer = null;
    for (const el of root.querySelectorAll('*')) {
      const txt = (el.textContent || '').trim();
      if (txt.length > 120 || !re.test(txt)) continue;
      if (!treffer || txt.length < (treffer.textContent || '').trim().length) treffer = el;
    }
    // eine Ebene hoch: dort sitzt meist das Kästchen neben dem Namen
    return treffer ? (treffer.closest('li, td, .card, [class*="member"], [class*="team"]') || treffer.parentElement || treffer) : null;
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

  function readVorfaelle(doc) {
    const root = (CONFIG.SEL.vorfaelle && doc.querySelector(CONFIG.SEL.vorfaelle))
      || doc.querySelector('main') || doc.body;
    if (!root) return [];
    const found = [];
    for (const el of root.querySelectorAll('tr, li, p, .alert, .notification, [class*="vorfall"], [class*="event"]')) {
      if (el.children.length > 4) continue;
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 250) continue;
      if (VORFALL_WORTE.some(w => txt.toLowerCase().includes(w))) found.push(txt);
    }
    return [...new Set(found)];
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
        state.lastPush.ausschuettung_faellig = 0;   // Cooldown für die nächste freigeben
        push('ausschuettung_erfolgt', '💰 Ausschüttung erfolgt',
          `Gewinn zurückgesetzt: ${fmt(vorher)} → ${fmt(g.value)}\n` +
          `Zähler für die nächste Ausschüttung läuft neu: ` +
          `0 von ${CONFIG.AUSSCHUETTUNG_STD} Std. Team-Onlinezeit.`,
          state, 'default');
      }
      state.gewinn = g.value;
    } else log('Gewinn seit Ausschüttung nicht gefunden');

    // Ziel erreicht?
    if (state.teamOnlineMs >= ziel) {
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
      letzteAusschuettung: state.letzteAusschuettung
        ? new Date(state.letzteAusschuettung).toLocaleString('de-DE') : 'unbekannt',
      gewinn: state.gewinn,
    };
  }

  /* ---------- Push ---------- */

  // ntfy-Prioritäten sind Zahlen: 1 min ... 5 max
  const PRIO = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };

  function push(thema, titel, text, state, prio = 'high') {
    const now = Date.now();
    if (now - (state.lastPush[thema] || 0) < CONFIG.ERINNERUNG_MIN * MIN) {
      return log('Cooldown, unterdrückt:', thema);
    }
    state.lastPush[thema] = now;

    if (CONFIG.NTFY_TOPIC && !CONFIG.NTFY_TOPIC.startsWith('HIER-')) {
      // Titel und Text werden als JSON gesendet, NICHT als HTTP-Header:
      // Header dürfen nur Latin-1 enthalten, unsere Titel haben Emojis
      // und Umlaute ("🚨 Steuerprüfung") – das lässt die Anfrage scheitern.
      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.NTFY_SERVER,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({
          topic: CONFIG.NTFY_TOPIC,
          title: titel,
          message: text,
          priority: PRIO[prio] || 4,
          tags: ['office'],
          click: location.href,
        }),
        onload: r => {
          if (r.status >= 200 && r.status < 300) log('ntfy ok:', titel);
          else console.error('[UC-Watcher] ntfy antwortete', r.status, r.responseText);
        },
        onerror: () => console.error(
          '[UC-Watcher] ntfy nicht erreichbar. Prüfe: Topic gesetzt? ' +
          'Adblocker/DNS blockiert ntfy.sh? Internet da?'),
      });
    } else console.warn('[UC-Watcher] Kein ntfy-Topic gesetzt – nur Browser-Hinweis.');

    try { GM_notification({ title: titel, text, timeout: 20000, onclick: () => W.focus() }); } catch (_) {}
    log('PUSH:', titel, '\n' + text);
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
          `Lager: ${lager.value} (Schwelle ${CONFIG.LAGER_SCHWELLE}) – nachfüllen.`, state);
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
    const p = readPersonal(document);
    console.table({
      Lager:       read(document, 'lager'),
      Personal:    p,
      Firmenkasse: read(document, 'kasse'),
    });
    console.log('Online erkannt (grünes Kästchen):', readOnlineSpieler(document));
    console.log('Vorfälle erkannt:', readVorfaelle(document));
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

  // Schickt sofort eine Testnachricht – prüft Topic und Verbindung
  W.ucWatcherPushTest = function () {
    const s = load();
    s.lastPush.selftest = 0;
    push('selftest', '✅ UC-Watcher Test',
      'Wenn du das auf dem Handy siehst, funktioniert die Benachrichtigung.', s, 'default');
    save(s);
    return 'Testnachricht abgeschickt – schau aufs Handy.';
  };

  W.ucWatcherReset = function () { save(leererStand()); console.log('Zustand zurückgesetzt.'); };

  check(document);
  setInterval(() => check(document), CONFIG.POLL_INTERVAL_MS);
  beobachte();
  starteReload();

  console.log(
    '%c UC-Watcher aktiv %c Befehle: ucWatcherTest() · ucWatcherZeiten() · ' +
    'ucWatcherAusschuettung() · ucWatcherDump() · ucWatcherPushTest() · ucWatcherReset()',
    'background:#2dd4bf;color:#000;font-weight:bold;border-radius:3px',
    'color:inherit');
})();
