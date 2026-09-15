// ==UserScript==
// @name         UnicaCity Unternehmen-Watcher
// @namespace    https://unicacity.eu/
// @version      3.0.0
// @description  Überwacht Lager, Personal, Kasse und Vorfälle, trackt Online-Zeiten der Spieler und pusht aufs Handy (ntfy.sh).
// @match        https://unicacity.eu/dashboard/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
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
    PERSONAL_SOLL:  6,
    ERINNERUNG_MIN: 60,     // Cooldown je Thema

    // ---- Steuerprüfung: 4 % bezahlt, 8 % ignoriert ----
    STEUER_NORMAL_PCT:    4,
    STEUER_IGNORIERT_PCT: 8,
    STEUER_TOLERANZ_PP:   0.6,

    // ---- Spieler-Online-Tracking ----
    // Bekannte Spielernamen. Hilft der Erkennung enorm und verhindert Fehltreffer.
    SPIELER: [
      'maaxxyyy',
      'halo361',
      // weitere Namen hier ergänzen
    ],

    // Wo steht die Online-Liste? Leer lassen = automatische Suche.
    SEL_ONLINE: '',          // z.B. '#online-spieler' oder '.player-list'

    // Falls die Online-Liste auf einer ANDEREN Seite steht, hier die URL
    // eintragen; sie wird dann im Hintergrund mit abgefragt.
    ONLINE_URL: '',          // z.B. 'https://unicacity.eu/dashboard/spieler'

    ONLINE_FENSTER_MIN: 180, // Zeitfenster für "wer war online" in Meldungen
    LUECKE_MIN: 10,          // Pause > X Min. = neue Sitzung (statt durchgehend)

    // ---- Takt ----
    POLL_INTERVAL_MS: 60 * 1000,

    // ---- Selektoren fürs Unternehmen (leer = Auto-Suche über Labels) ----
    SEL: {
      lager:     '',
      personal:  '',
      kasse:     '',
      vorfaelle: '',
    },

    DEBUG: false,
  };

  const LABELS = {
    lager:    ['lagerbestand', 'lager', 'bestand', 'warenlager'],
    personal: ['personal', 'mitarbeiter', 'angestellte', 'belegschaft'],
    kasse:    ['firmenkasse', 'kasse', 'guthaben', 'kontostand', 'firmenkonto'],
  };

  const VORFALL_WORTE = [
    'vorfall', 'vorfälle', 'steuerprüfung', 'steuerpruefung', 'razzia',
    'überfall', 'ueberfall', 'einbruch', 'diebstahl', 'brand', 'kontrolle',
    'abwerbung', 'abgeworben', 'beschwerde', 'strafe', 'bußgeld', 'bussgeld',
  ];

  /* ====================== AB HIER NICHTS ÄNDERN ====================== */

  const KEY = 'uc_watcher_v3';
  const log = (...a) => CONFIG.DEBUG && console.log('[UC-Watcher]', ...a);
  const MIN = 60_000;

  const leererStand = () => ({
    lager: null, personal: null, personalSoll: null, kasse: null,
    vorfaelle: [],
    spieler: {},      // name -> { online, seit, sitzungMs, gesamtMs, zuletzt, tag }
    lastPush: {},
  });

  const load = () => Object.assign(leererStand(), GM_getValue(KEY, {}));
  const save = s => GM_setValue(KEY, s);

  const heute = () => new Date().toISOString().slice(0, 10);

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

  function findByLabel(doc, words) {
    for (const el of doc.querySelectorAll('*')) {
      if (el.children.length > 2) continue;
      const t = (el.textContent || '').trim().toLowerCase();
      if (!t || t.length > 60) continue;
      if (!words.some(w => t.includes(w))) continue;

      const own = toNumber(t.replace(new RegExp(words.join('|'), 'gi'), ''));
      if (own !== null) return { value: own, text: el.textContent.trim() };

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
      log('Selektor liefert nichts:', key, sel);
    }
    return findByLabel(doc, LABELS[key] || []);
  }

  function readPersonal(doc) {
    const hit = read(doc, 'personal');
    if (!hit) return null;
    const frac = hit.text.match(/(\d+)\s*\/\s*(\d+)/);
    if (frac) return { ist: +frac[1], soll: +frac[2] };
    return { ist: hit.value, soll: CONFIG.PERSONAL_SOLL };
  }

  /* ---------- Online-Spieler erkennen ---------- */

  function readOnlineSpieler(doc) {
    const root = (CONFIG.SEL_ONLINE && doc.querySelector(CONFIG.SEL_ONLINE))
      || doc.querySelector('main') || doc.body;
    if (!root) return [];

    const namen = new Set();
    const text = (root.innerText || root.textContent || '');

    // 1) Bekannte Spielernamen direkt im Text suchen (zuverlässigster Weg)
    for (const name of CONFIG.SPIELER) {
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (!re.test(text)) continue;

      // Prüfen, ob die Zeile des Namens nicht "offline" sagt
      const zeile = text.split('\n').find(l => re.test(l)) || '';
      if (/\boffline\b/i.test(zeile)) continue;
      namen.add(name);
    }

    // 2) Ergänzend: Elemente, die als online markiert sind
    for (const row of root.querySelectorAll('tr, li, .player, [class*="online"]')) {
      const txt = (row.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 120) continue;
      if (/\boffline\b/i.test(txt) || /offline/i.test(row.className)) continue;
      const online = /\bonline\b/i.test(txt) || /online/i.test(row.className);
      if (!online) continue;

      const name = (row.querySelector('.name, strong, b, a, td')?.textContent || txt)
        .replace(/\b(online|offline)\b/ig, '').replace(/\s+/g, ' ').trim();
      if (name && name.length <= 32 && /[a-z0-9_]/i.test(name)) namen.add(name);
    }

    return [...namen];
  }

  /* ---------- Online-Zeiten fortschreiben ---------- */

  function updateSpieler(state, onlineJetzt) {
    const now = Date.now();
    const tag = heute();
    const online = new Set(onlineJetzt);

    for (const name of online) {
      const p = state.spieler[name] || { online: false, seit: null, sitzungMs: 0, gesamtMs: 0, zuletzt: 0, tag };
      if (p.tag !== tag) { p.gesamtMs = 0; p.tag = tag; }   // Tageszähler zurücksetzen

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

  /* ---------- Push ---------- */

  function push(thema, titel, text, state, prio = 'high') {
    const now = Date.now();
    if (now - (state.lastPush[thema] || 0) < CONFIG.ERINNERUNG_MIN * MIN) {
      return log('Cooldown, unterdrückt:', thema);
    }
    state.lastPush[thema] = now;

    if (CONFIG.NTFY_TOPIC && !CONFIG.NTFY_TOPIC.startsWith('HIER-')) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${CONFIG.NTFY_SERVER}/${CONFIG.NTFY_TOPIC}`,
        headers: { Title: titel, Priority: prio, Tags: 'office', Click: location.href },
        data: text,
        onerror: e => console.error('[UC-Watcher] ntfy-Fehler', e),
      });
    } else console.warn('[UC-Watcher] Kein ntfy-Topic gesetzt – nur Browser-Hinweis.');

    try { GM_notification({ title: titel, text, timeout: 20000, onclick: () => window.focus() }); } catch (_) {}
    log('PUSH:', titel, '\n' + text);
  }

  const fmt = n => n.toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' $';

  /* ---------- Hauptprüfung ---------- */

  function check(doc, onlineDoc) {
    const state = load();

    // --- Online-Zeiten immer zuerst fortschreiben ---
    updateSpieler(state, readOnlineSpieler(onlineDoc || doc));

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

    // --- 2) Personal: jede Änderung melden, mit Online-Spielern ---
    const p = readPersonal(doc);
    if (p && p.ist !== null) {
      const soll = p.soll || CONFIG.PERSONAL_SOLL;
      const alt = state.personal;

      if (alt !== null && p.ist !== alt) {
        const gefallen = p.ist < alt;
        const bericht = onlineBericht(state);
        const wer = bericht.length
          ? `\n\nOnline zum Zeitpunkt der Änderung:\n${bericht.join('\n')}`
          : '\n\n(Keine Online-Daten erfasst – SPIELER-Liste/SEL_ONLINE prüfen.)';

        push(
          `personal_change_${p.ist}`,
          gefallen ? '🚨 Mitarbeiter verloren (Abwerbung?)' : 'ℹ️ Personal verändert',
          `Personal: ${alt}/${soll} → ${p.ist}/${soll}` +
          (gefallen
            ? `\n${alt - p.ist} Mitarbeiter weg – Abwerbung wurde nicht abgewendet.`
            : `\n+${p.ist - alt} dazugekommen.`) +
          wer,
          state, gefallen ? 'urgent' : 'default');
      } else if (p.ist < soll) {
        push('personal_unterbesetzt', '⚠️ Personal unterbesetzt',
          `Personal: ${p.ist}/${soll} – ${soll - p.ist} fehlen.` +
          (onlineBericht(state).length ? `\n\nOnline:\n${onlineBericht(state).join('\n')}` : ''),
          state);
      }
      state.personal = p.ist;
      state.personalSoll = soll;
    } else log('Personal nicht gefunden');

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

    save(state);
    log('geprüft', { lager: state.lager, personal: state.personal, kasse: state.kasse });
  }

  /* ---------- Abruf ---------- */

  async function holen(url) {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (/login|anmelden/i.test(new URL(res.url).pathname)) throw new Error('LOGIN');
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  async function poll() {
    try {
      const doc = await holen(location.href);
      const onlineDoc = CONFIG.ONLINE_URL ? await holen(CONFIG.ONLINE_URL).catch(() => null) : null;
      check(doc, onlineDoc);
    } catch (e) {
      if (e.message === 'LOGIN') {
        const s = load();
        push('login', '🔑 UnicaCity: Login abgelaufen', 'Überwachung pausiert – bitte neu einloggen.', s, 'urgent');
        save(s);
      } else log('Poll-Fehler', e);
    }
  }

  /* ---------- Konsolen-Werkzeuge ---------- */

  window.ucWatcherTest = function () {
    const p = readPersonal(document);
    console.table({
      Lager:       read(document, 'lager'),
      Personal:    p,
      Firmenkasse: read(document, 'kasse'),
    });
    console.log('Online erkannt:', readOnlineSpieler(document));
    console.log('Vorfälle erkannt:', readVorfaelle(document));
  };

  window.ucWatcherZeiten = function () {
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

  window.ucWatcherReset = function () { save(leererStand()); console.log('Zustand zurückgesetzt.'); };

  check(document);
  setInterval(poll, CONFIG.POLL_INTERVAL_MS);
  log('aktiv – ucWatcherTest() / ucWatcherZeiten() in der Konsole');
})();
