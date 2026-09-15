// ==UserScript==
// @name         UnicaCity Unternehmen-Watcher
// @namespace    https://unicacity.eu/
// @version      2.0.0
// @description  Überwacht Lagerbestand, Personal, Firmenkasse und Vorfälle im Unternehmens-Dashboard und pusht aufs Handy (ntfy.sh).
// @match        https://unicacity.eu/dashboard/unternehmen*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
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
    LAGER_SCHWELLE:    500,   // Alarm wenn Lagerbestand DARUNTER fällt
    PERSONAL_SOLL:     6,     // Alarm wenn Personal unter 6/6 fällt
    ERINNERUNG_MIN:    60,    // frühestens nach X Min. erneut zum selben Thema pushen

    // ---- Steuerprüfung ----
    // Normale Prüfung kostet 4 % der Firmenkasse, eine ignorierte 8 %.
    STEUER_NORMAL_PCT:  4,
    STEUER_IGNORIERT_PCT: 8,
    STEUER_TOLERANZ_PP: 0.6,  // Toleranz in Prozentpunkten beim Zuordnen

    // ---- Online-Protokoll ----
    ONLINE_LOG_MINUTEN: 180,  // wie weit zurück "wer war online" gemeldet wird

    // ---- Takt ----
    POLL_INTERVAL_MS: 60 * 1000,

    // ---- Selektoren (optional, leer lassen = automatische Suche über Labels) ----
    SEL: {
      lager:      '',   // z.B. '#lagerbestand .value'
      personal:   '',   // z.B. '.personal-count'      (erwartet "4/6" oder nur die Zahl)
      kasse:      '',   // z.B. '#firmenkasse .value'
      vorfaelle:  '',   // Container mit Vorfall-Meldungen
      mitarbeiter:'',   // Container der Mitarbeiterliste (für Online-Status)
    },

    DEBUG: false,
  };

  // Begriffe, an denen die automatische Suche die Werte erkennt
  const LABELS = {
    lager:    ['lagerbestand', 'lager', 'bestand', 'warenlager'],
    personal: ['personal', 'mitarbeiter', 'angestellte', 'belegschaft'],
    kasse:    ['firmenkasse', 'kasse', 'guthaben', 'kontostand', 'firmenkonto'],
  };

  const VORFALL_WORTE = [
    'vorfall', 'vorfälle', 'steuerprüfung', 'steuerpruefung', 'razzia',
    'überfall', 'ueberfall', 'einbruch', 'diebstahl', 'brand', 'kontrolle',
    'beschwerde', 'strafe', 'bußgeld', 'bussgeld', 'warnung',
  ];

  /* ====================== AB HIER NICHTS ÄNDERN ====================== */

  const KEY = 'uc_watcher_v2';
  const log = (...a) => CONFIG.DEBUG && console.log('[UC-Watcher]', ...a);

  const load = () => GM_getValue(KEY, {
    lager: null, personal: null, kasse: null,
    vorfaelle: [],          // gesehene Vorfall-Texte
    onlineLog: [],          // [{t, names:[]}]
    lastPush: {},           // thema -> timestamp
  });
  const save = s => GM_setValue(KEY, s);

  /* ---------- Parsing-Helfer ---------- */

  // "1.234,56 $" -> 1234.56 ; "4/6" -> 4
  function toNumber(raw) {
    if (raw == null) return null;
    const m = String(raw).match(/-?[\d.,]*\d/);
    if (!m) return null;
    let s = m[0];
    // deutsches Format: Punkt = Tausender, Komma = Dezimal
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/\.\d{3}(\D|$)/.test(s + ' ')) s = s.replace(/\./g, '');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  // Sucht im Dokument nach einem Label und nimmt die nächstgelegene Zahl.
  function findByLabel(doc, words) {
    const els = doc.querySelectorAll('*');
    for (const el of els) {
      if (el.children.length > 2) continue;                    // nur Blatt-nahe Knoten
      const t = (el.textContent || '').trim().toLowerCase();
      if (t.length > 60) continue;
      if (!words.some(w => t.includes(w))) continue;

      // Zahl im selben Element?
      const own = toNumber(t.replace(new RegExp(words.join('|'), 'gi'), ''));
      if (own !== null) return { value: own, text: el.textContent.trim() };

      // sonst: Geschwister / Elternbereich absuchen
      const scope = el.nextElementSibling || el.parentElement;
      if (scope) {
        const n = toNumber(scope.textContent);
        if (n !== null) return { value: n, text: scope.textContent.trim().slice(0, 80) };
      }
    }
    return null;
  }

  function read(doc, key) {
    const sel = CONFIG.SEL[key];
    if (sel) {
      const el = doc.querySelector(sel);
      if (el) return { value: toNumber(el.textContent), text: el.textContent.trim() };
      log('Selektor leer:', key, sel);
    }
    return findByLabel(doc, LABELS[key] || []);
  }

  // Personal als "x/6" erkennen, sonst blanke Zahl
  function readPersonal(doc) {
    const hit = read(doc, 'personal');
    if (!hit) return null;
    const frac = hit.text.match(/(\d+)\s*\/\s*(\d+)/);
    if (frac) return { ist: +frac[1], soll: +frac[2], text: hit.text };
    return { ist: hit.value, soll: CONFIG.PERSONAL_SOLL, text: hit.text };
  }

  /* ---------- Online-Status der Mitarbeiter ---------- */

  function readOnline(doc) {
    const root = CONFIG.SEL.mitarbeiter
      ? doc.querySelector(CONFIG.SEL.mitarbeiter)
      : doc.querySelector('main') || doc.body;
    if (!root) return [];

    const names = new Set();
    for (const row of root.querySelectorAll('tr, li, .member, .employee, [class*="mitarbeiter"]')) {
      const txt = (row.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 200) continue;

      const onlineByText  = /\bonline\b/i.test(txt) && !/\boffline\b/i.test(txt);
      const onlineByClass = /online/i.test(row.className) && !/offline/i.test(row.className) ||
                            !!row.querySelector('.online, .status-online, [class*="online"]:not([class*="offline"])');
      if (!onlineByText && !onlineByClass) continue;

      const name = (row.querySelector('td, .name, strong, b, a')?.textContent || txt)
        .replace(/\bonline\b/ig, '').replace(/\s+/g, ' ').trim();
      if (name) names.add(name.slice(0, 40));
    }
    return [...names];
  }

  function onlineSeit(state, minuten) {
    const cutoff = Date.now() - minuten * 60_000;
    const set = new Set();
    for (const e of state.onlineLog) if (e.t >= cutoff) e.names.forEach(n => set.add(n));
    return [...set];
  }

  /* ---------- Vorfälle ---------- */

  function readVorfaelle(doc) {
    const root = CONFIG.SEL.vorfaelle
      ? doc.querySelector(CONFIG.SEL.vorfaelle)
      : doc.querySelector('main') || doc.body;
    if (!root) return [];

    const found = [];
    for (const el of root.querySelectorAll('tr, li, p, .alert, .notification, [class*="vorfall"], [class*="event"]')) {
      if (el.children.length > 4) continue;
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 250) continue;
      const low = txt.toLowerCase();
      if (VORFALL_WORTE.some(w => low.includes(w))) found.push(txt);
    }
    return [...new Set(found)];
  }

  /* ---------- Push ---------- */

  function push(thema, titel, text, state, prio = 'high') {
    const now = Date.now();
    const last = state.lastPush[thema] || 0;
    if (now - last < CONFIG.ERINNERUNG_MIN * 60_000) { log('unterdrückt (Cooldown):', thema); return; }
    state.lastPush[thema] = now;

    if (CONFIG.NTFY_TOPIC && !CONFIG.NTFY_TOPIC.startsWith('HIER-')) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${CONFIG.NTFY_SERVER}/${CONFIG.NTFY_TOPIC}`,
        headers: { Title: titel, Priority: prio, Tags: 'office', Click: location.href },
        data: text,
        onerror: e => console.error('[UC-Watcher] ntfy-Fehler', e),
      });
    } else {
      console.warn('[UC-Watcher] Kein ntfy-Topic gesetzt – nur Browser-Hinweis.');
    }
    try { GM_notification({ title: titel, text, timeout: 20000, onclick: () => window.focus() }); } catch (_) {}
    log('PUSH:', titel, '|', text);
  }

  /* ---------- Regeln ---------- */

  function check(doc) {
    const state = load();
    const now = Date.now();

    // Online-Protokoll fortschreiben
    const online = readOnline(doc);
    state.onlineLog.push({ t: now, names: online });
    const cutoff = now - CONFIG.ONLINE_LOG_MINUTEN * 60_000;
    state.onlineLog = state.onlineLog.filter(e => e.t >= cutoff);

    // --- 1) Lagerbestand ---
    const lager = read(doc, 'lager');
    if (lager && lager.value !== null) {
      if (lager.value < CONFIG.LAGER_SCHWELLE) {
        push('lager', '⚠️ Lagerbestand niedrig',
          `Lager: ${lager.value} (Schwelle ${CONFIG.LAGER_SCHWELLE}) – nachfüllen.`, state);
      } else if (state.lager !== null && state.lager < CONFIG.LAGER_SCHWELLE) {
        state.lastPush.lager = 0;   // wieder über Schwelle -> Cooldown zurücksetzen
      }
      state.lager = lager.value;
    } else log('Lagerbestand nicht gefunden');

    // --- 2) Personal ---
    const p = readPersonal(doc);
    if (p && p.ist !== null) {
      const soll = p.soll || CONFIG.PERSONAL_SOLL;
      if (p.ist < soll) {
        push('personal', '⚠️ Personal unterbesetzt',
          `Personal: ${p.ist}/${soll} – ${soll - p.ist} fehlen.`, state);
      } else if (state.personal !== null && state.personal < soll) {
        state.lastPush.personal = 0;
      }
      state.personal = p.ist;
    } else log('Personal nicht gefunden');

    // --- 3a) Vorfälle direkt auf der Seite ---
    const vorfaelle = readVorfaelle(doc);
    const neue = vorfaelle.filter(v => !state.vorfaelle.includes(v));
    if (neue.length) {
      const wer = onlineSeit(state, CONFIG.ONLINE_LOG_MINUTEN);
      push('vorfall_' + neue[0].slice(0, 20), '🚨 Vorfall im Unternehmen',
        neue.join('\n') +
        (wer.length ? `\n\nOnline (letzte ${CONFIG.ONLINE_LOG_MINUTEN} Min.): ${wer.join(', ')}` : ''),
        state, 'urgent');
      state.vorfaelle = [...vorfaelle].slice(-50);
    } else {
      state.vorfaelle = [...new Set([...state.vorfaelle, ...vorfaelle])].slice(-50);
    }

    // --- 3b) Steuerprüfung aus dem Kassensturz ableiten ---
    const kasse = read(doc, 'kasse');
    if (kasse && kasse.value !== null) {
      if (state.kasse !== null && state.kasse > 0 && kasse.value < state.kasse) {
        const diff = state.kasse - kasse.value;
        const pct = (diff / state.kasse) * 100;
        const nahe = (ziel) => Math.abs(pct - ziel) <= CONFIG.STEUER_TOLERANZ_PP;

        if (nahe(CONFIG.STEUER_IGNORIERT_PCT)) {
          const wer = onlineSeit(state, CONFIG.ONLINE_LOG_MINUTEN);
          push('steuer_ignoriert', '🚨 Steuerprüfung wurde IGNORIERT',
            `Firmenkasse: ${fmt(state.kasse)} → ${fmt(kasse.value)}\n` +
            `Abzug: ${fmt(diff)} (${pct.toFixed(2)} % = Strafsatz statt ${CONFIG.STEUER_NORMAL_PCT} %)\n` +
            `Mehrkosten ggü. bearbeiteter Prüfung: ${fmt(diff / 2)}\n\n` +
            (wer.length
              ? `Online in den letzten ${CONFIG.ONLINE_LOG_MINUTEN} Min.:\n${wer.join(', ')}`
              : 'Keine Online-Daten erfasst (Mitarbeiterliste nicht erkannt).'),
            state, 'urgent');
        } else if (nahe(CONFIG.STEUER_NORMAL_PCT)) {
          push('steuer_normal', 'ℹ️ Steuerprüfung bezahlt',
            `Firmenkasse: ${fmt(state.kasse)} → ${fmt(kasse.value)}\n` +
            `Abzug: ${fmt(diff)} (${pct.toFixed(2)} % – regulär, wurde bearbeitet).`,
            state, 'default');
        }
      }
      state.kasse = kasse.value;
    } else log('Firmenkasse nicht gefunden');

    save(state);
    log('geprüft:', { lager: state.lager, personal: state.personal, kasse: state.kasse, online });
  }

  const fmt = n => n.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' $';

  /* ---------- Antrieb ---------- */

  async function poll() {
    try {
      const res = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return log('Fetch-Status', res.status);
      if (/login|anmelden/i.test(new URL(res.url).pathname)) {
        const s = load();
        push('login', '🔑 UnicaCity: Login abgelaufen', 'Überwachung pausiert – bitte neu einloggen.', s, 'urgent');
        save(s);
        return;
      }
      check(new DOMParser().parseFromString(await res.text(), 'text/html'));
    } catch (e) { log('Poll-Fehler', e); }
  }

  // Diagnose: einmal ausgeben, was erkannt wurde
  window.ucWatcherTest = function () {
    const p = readPersonal(document);
    console.table({
      Lager:       read(document, 'lager'),
      Personal:    p,
      Firmenkasse: read(document, 'kasse'),
    });
    console.log('Online erkannt:', readOnline(document));
    console.log('Vorfälle erkannt:', readVorfaelle(document));
  };

  check(document);
  setInterval(poll, CONFIG.POLL_INTERVAL_MS);
  log('aktiv –  ucWatcherTest()  in der Konsole zeigt die erkannten Werte.');
})();
