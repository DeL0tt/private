# Arbeitsweise in diesem Repo

## Antworten auf Deutsch

LottiMi arbeitet auf Deutsch. Antworten, Commit-Nachrichten, Code-Kommentare
und Doku sind deutsch.

## PowerShell-Befehle immer mit dem Login-Befehl davor

Jedes Mal, wenn ein Befehl kommt, den LottiMi **in PowerShell auf dem eigenen
Rechner** eingeben soll, steht der Login-Befehl mit dabei – ohne dass er
danach suchen muss. Also nicht „logge dich ein und führe X aus", sondern ein
Block, der mit dem Login anfängt:

```powershell
ssh -i "$HOME\.ssh\uc-watcher.key" ubuntu@89.168.78.21
```

Danach, **auf dem Server** (dort geht `&&`):

```bash
cd ~/private && git pull && sudo systemctl restart uc-watcher
```

Das gilt auch für kurze Nachfragen und für einzelne Diagnosebefehle.

Zwei Stolpersteine, die wiederholt aufgetreten sind:

- **PowerShell 5 kennt kein `&&`.** Befehle für den Laptop einzeln auflisten,
  nie verketten. Auf dem Server selbst (bash) ist `&&` in Ordnung.
- `git pull` bricht mit *„fatal: not a git repository"* ab, wenn das
  Arbeitsverzeichnis fehlt. Deshalb immer `cd ~/private` mit in den Block.

## Eckdaten des Servers

| | |
|---|---|
| Host | `89.168.78.21` (Oracle Cloud, Ubuntu) |
| Benutzer | `ubuntu` |
| Schlüssel | `C:\Users\KonstantinLott\.ssh\uc-watcher.key` |
| Verzeichnis | `~/private/uc-watcher/server` |
| Dienst | `uc-watcher` |

Das Cookie liegt in der systemd-Unit, **nicht** in `.env`. Befehle, die die
API brauchen, laden daher den gespeicherten Zugang aus der Zustandsdatei –
`--env-file=.env` allein genügt nicht.

## Der Watcher

Zero-Dependency Node.js (ESM, `.mjs`), natives `fetch` und `WebSocket`.
Ausrollen ist `git pull` plus `systemctl restart uc-watcher`.

- `server/watcher.mjs` – Überwachung, Befehle, Kommandozeile
- `server/discord.mjs` – Discord-Schicht, nur Ausgabe
- `server/archiv.mjs` – Auswertung, von der Ausgabe getrennt

Drei JSON-Dateien, alle mit Rechten 0600: `uc-watcher-state.json` (flüchtig),
`uc-watcher-regeln.json` (Regeln, Zuordnung), `uc-watcher-zeiten.json`
(Archiv). Token und Cookie gehören in keine Ausgabe – `--discord-pruefe` und
`--einstellungen` melden Geheimnisse nur als „gesetzt".

## Entwicklung

Alles auf dem Branch `business` in `DeL0tt/private`. Kein Pull Request, außer
er wird ausdrücklich gewünscht.

Vor jedem Push: `node --check` auf die geänderten Dateien und die Testsuiten
laufen lassen. `node --check` findet keine fehlenden Funktionen – nur die
Tests tun das, und genau daran sind hier schon Fehler vorbeigekommen.
