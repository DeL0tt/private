# UnicaCity Unternehmen-Watcher

Push-Benachrichtigung aufs Handy, wenn sich auf
`https://unicacity.eu/dashboard/unternehmen` etwas ändert.

## Warum als Browser-Skript?

Die Seite ist nur eingeloggt erreichbar. Ein externer Dienst (oder ein Server)
hätte deine Session nicht. Das Skript läuft deshalb **in deinem Chrome**, nutzt
deine bestehende Anmeldung und schickt bei Änderungen eine Push-Nachricht.

## Einrichtung (ca. 5 Minuten)

### 1. ntfy-App aufs Handy
- Android: Play Store → „ntfy"
- iOS: App Store → „ntfy"

### 2. Topic ausdenken
Etwas Zufälliges, z. B. `uc-unternehmen-9f3a2b7c`.
Achtung: Wer das Topic kennt, sieht die Nachrichten — also nicht raten lassen
und keine sensiblen Inhalte pushen.
In der App: **+ → Topic abonnieren → Name eintragen**.

### 3. Tampermonkey in Chrome
Chrome Web Store → „Tampermonkey" installieren.

### 4. Skript einfügen
Tampermonkey → **Dashboard → + (neues Skript)** → Inhalt von
`unicacity-unternehmen-watcher.user.js` komplett einfügen → **Speichern (Strg+S)**.

### 5. Konfigurieren
Oben im Skript im Block `CONFIG`:

| Option | Bedeutung |
|---|---|
| `NTFY_TOPIC` | dein Topic aus Schritt 2 |
| `WATCH_SELECTOR` | **wichtig** — welcher Teil der Seite überwacht wird |
| `POLL_INTERVAL_MS` | Prüfintervall, Standard 60 s |
| `IGNORE_PATTERNS` | Texte, die sich immer ändern (Uhrzeiten etc.) |

### 6. Selektor herausfinden
Auf der Dashboard-Seite Rechtsklick auf das Element, das dich interessiert
(z. B. Kontostand, Mitarbeiterliste) → **Untersuchen**. Im Elements-Panel
Rechtsklick auf die markierte Zeile → **Copy → Copy selector**. Das Ergebnis
bei `WATCH_SELECTOR` eintragen, z. B.:

```js
WATCH_SELECTOR: '#app > div.dashboard > section.company-stats',
```

Bleibt es `null`, wird die ganze Seite überwacht — das funktioniert, löst aber
oft Fehlalarme aus.

## Testen
1. Seite öffnen, Tampermonkey-Icon muss eine „1" zeigen.
2. `DEBUG: true` setzen, Konsole (F12) beobachten.
3. In der ntfy-App auf dem Handy testweise eine Nachricht an dein Topic senden:
   `curl -d "Test" https://ntfy.sh/DEIN-TOPIC`

## Grenzen
- Der Chrome-Tab muss offen sein (Rechner an, Browser läuft).
  Für 24/7 bräuchte es einen kleinen Server mit gespeicherten Login-Cookies —
  sag Bescheid, wenn du das willst.
- Bei abgelaufener Session kommt eine Push-Nachricht „Login abgelaufen".
