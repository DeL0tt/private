// ==UserScript==
// @name         UnicaCity Unternehmen-Watcher
// @namespace    https://unicacity.eu/
// @version      1.0.0
// @description  Überwacht das Unternehmen-Dashboard im eingeloggten Browser und schickt bei Änderungen eine Push-Nachricht aufs Handy (ntfy.sh).
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

  /* ===================== KONFIGURATION ===================== */

  const CONFIG = {
    // Frei gewähltes, schwer erratbares ntfy-Topic. In der ntfy-App abonnieren.
    // WICHTIG: Topics sind öffentlich – nimm etwas Zufälliges, z.B. "uc-kon-9f3a2b7c".
    NTFY_TOPIC: 'HIER-EIGENES-TOPIC-EINTRAGEN',
    NTFY_SERVER: 'https://ntfy.sh',

    // Welcher Teil der Seite wird beobachtet?
    // null  = die ganze Seite (viele Fehlalarme durch Uhrzeiten etc.)
    // sonst CSS-Selektor, z.B. '#kontostand', '.company-balance', 'table.mitarbeiter'
    WATCH_SELECTOR: null,

    // Wie oft neu prüfen (ms). Die Seite wird dabei im Hintergrund neu geladen
    // bzw. – falls die Seite selbst live aktualisiert – nur neu ausgelesen.
    POLL_INTERVAL_MS: 60 * 1000,

    // Seite automatisch neu laden, damit neue Serverdaten kommen.
    // false, wenn die Seite sich selbst per JS/Websocket aktualisiert.
    AUTO_RELOAD: true,
    RELOAD_INTERVAL_MS: 5 * 60 * 1000,

    // Zeilen/Texte, die sich ständig ändern und ignoriert werden sollen (RegExp).
    IGNORE_PATTERNS: [
      /\b\d{1,2}:\d{2}(:\d{2})?\b/g,          // Uhrzeiten
      /\bvor \d+ (Sekunden|Minuten|Stunden)\b/gi,
    ],

    DEBUG: false,
  };

  /* ================== AB HIER NICHTS ÄNDERN ================== */

  const STORE_KEY = 'uc_watch_state_' + location.pathname;

  const log = (...a) => CONFIG.DEBUG && console.log('[UC-Watcher]', ...a);

  function extractText(doc) {
    const root = CONFIG.WATCH_SELECTOR
      ? doc.querySelector(CONFIG.WATCH_SELECTOR)
      : doc.querySelector('main') || doc.body;
    if (!root) return null;

    let text = root.innerText || root.textContent || '';
    for (const re of CONFIG.IGNORE_PATTERNS) text = text.replace(re, '');
    return text.replace(/\s+/g, ' ').trim();
  }

  async function hash(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function diffSummary(oldText, newText) {
    const oldWords = new Set(oldText.split(' '));
    const added = newText.split(' ').filter(w => w && !oldWords.has(w));
    const summary = added.slice(0, 25).join(' ');
    return summary || 'Inhalt hat sich geändert.';
  }

  function push(title, message) {
    if (!CONFIG.NTFY_TOPIC || CONFIG.NTFY_TOPIC.startsWith('HIER-')) {
      console.warn('[UC-Watcher] Kein ntfy-Topic gesetzt – nur Browser-Benachrichtigung.');
    } else {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${CONFIG.NTFY_SERVER}/${CONFIG.NTFY_TOPIC}`,
        headers: {
          'Title': title,
          'Priority': 'high',
          'Tags': 'office',
          'Click': location.href,
        },
        data: message,
        onerror: e => console.error('[UC-Watcher] ntfy-Fehler', e),
      });
    }

    try {
      GM_notification({ title, text: message, timeout: 15000, onclick: () => window.focus() });
    } catch (_) { /* optional */ }
  }

  async function check(doc, { announce } = { announce: true }) {
    const text = extractText(doc);
    if (text === null) {
      log('Selektor nicht gefunden:', CONFIG.WATCH_SELECTOR);
      return;
    }

    const h = await hash(text);
    const prev = GM_getValue(STORE_KEY, null);

    if (!prev) {
      GM_setValue(STORE_KEY, { hash: h, text });
      log('Ausgangszustand gespeichert.');
      return;
    }

    if (prev.hash !== h) {
      log('Änderung erkannt.');
      GM_setValue(STORE_KEY, { hash: h, text });
      if (announce) push('UnicaCity: Unternehmen geändert', diffSummary(prev.text, text));
    } else {
      log('Keine Änderung.');
    }
  }

  // 1) Live-Änderungen im offenen Tab (falls die Seite sich selbst aktualisiert)
  const root = CONFIG.WATCH_SELECTOR
    ? document.querySelector(CONFIG.WATCH_SELECTOR)
    : document.querySelector('main') || document.body;

  if (root) {
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => check(document), 1500); // debounce
    }).observe(root, { childList: true, subtree: true, characterData: true });
  }

  // 2) Regelmäßiges Nachladen der Seite im Hintergrund (nutzt die Login-Cookies des Browsers)
  async function poll() {
    try {
      const res = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
      if (!res.ok) { log('Fetch-Status', res.status); return; }
      const html = await res.text();
      if (/login|anmelden/i.test(new URL(res.url).pathname)) {
        push('UnicaCity: Login abgelaufen', 'Bitte neu einloggen, Überwachung pausiert.');
        return;
      }
      await check(new DOMParser().parseFromString(html, 'text/html'));
    } catch (e) {
      log('Poll-Fehler', e);
    }
  }

  check(document, { announce: false }).then(() => {
    setInterval(poll, CONFIG.POLL_INTERVAL_MS);
    if (CONFIG.AUTO_RELOAD) setTimeout(() => location.reload(), CONFIG.RELOAD_INTERVAL_MS);
  });

  log('aktiv auf', location.href);
})();
