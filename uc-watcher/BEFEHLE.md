# UC-Watcher – Befehlsübersicht

Spickzettel für den laufenden Betrieb. Stand 19.09.2026.

**Eckdaten:** Server `89.168.78.21` (Oracle Cloud, Ubuntu) · Benutzer `ubuntu` ·
Verzeichnis `~/private/uc-watcher/server` · Dienst `uc-watcher` ·
Schlüssel lokal unter `C:\Users\KonstantinLott\.ssh\uc-watcher.key`

---

## 1. Verbinden (von Windows aus)

```powershell
ssh -i "$HOME\.ssh\uc-watcher.key" ubuntu@89.168.78.21
```

Kürzer, wenn `~/.ssh/config` den Eintrag `Host uc` enthält:

```powershell
ssh uc
```

**Wichtig:** PowerShell 5 kennt kein `&&`. Befehle einzeln eingeben, nicht verketten.
Alles ab Abschnitt 2 läuft **auf dem Server**, nicht auf dem Laptop.

<details>
<summary>Eintrag für <code>~/.ssh/config</code></summary>

```
Host uc
    HostName 89.168.78.21
    User ubuntu
    IdentityFile ~/.ssh/uc-watcher.key
```
</details>

---

## 2. Dienst steuern

| Befehl | Zweck |
|---|---|
| `systemctl status uc-watcher` | Läuft er? (`active (running)`) – mit `q` wieder raus |
| `sudo systemctl restart uc-watcher` | Neu starten, z. B. nach `git pull` oder `.env`-Änderung |
| `sudo systemctl stop uc-watcher` | Anhalten |
| `sudo systemctl start uc-watcher` | Wieder anwerfen |
| `sudo systemctl enable uc-watcher` | Autostart nach Server-Neustart (ist bereits aktiv) |

### Nach einer Code-Änderung aktualisieren

```
cd ~/private
git pull
sudo systemctl restart uc-watcher
```

> Läuft `git pull` ins `fatal: not a git repository`, stehst du noch im Heimat-
> verzeichnis. Das `cd ~/private` gehört zwingend davor.

---

## 3. Logs lesen

| Befehl | Zweck |
|---|---|
| `journalctl -u uc-watcher -n 40 --no-pager` | Letzte 40 Zeilen |
| `journalctl -u uc-watcher -f` | Live mitlesen (`Strg+C` beendet) |
| `journalctl -u uc-watcher --since today` | Nur heute |
| `journalctl -u uc-watcher -p err` | Nur Fehler |

Typische Zeilen und was sie bedeuten:

- `UC-Watcher läuft – Intervall 60s` – sauber gestartet
- `Token erneuert, gültig bis HH:MM` – normal, passiert alle zwei Stunden
- `PUSH: …` – eine Benachrichtigung ging raus
- `AUTH` oder `Zugangsschlüssel abgelehnt` – Cookie ist abgelaufen, siehe Abschnitt 6

---

## 4. Befehle von Hand (Diagnose)

Immer zuerst ins Verzeichnis wechseln:

```
cd ~/private/uc-watcher/server
```

| Befehl | Zweck |
|---|---|
| `node --env-file=.env watcher.mjs --test` | **Der wichtigste.** Prüft Zugang und zeigt Firma, Lager, Personal, Kasse, Team |
| `node --env-file=.env watcher.mjs --push-test` | Test-Benachrichtigung aufs Handy |
| `node --env-file=.env watcher.mjs --zeiten` | Online-Zeiten aller Spieler, aktuelle Sitzung und Tagessumme |
| `node --env-file=.env watcher.mjs --tagesbericht` | Tagesübersicht seit 04:00 |
| `node --env-file=.env watcher.mjs --ausschuettung` | Stand des 12-Stunden-Zählers |
| `node --env-file=.env watcher.mjs --ausschuettung-start` | Zähler **auf null** setzen – nach einer tatsächlichen Ausschüttung |
| `node --env-file=.env watcher.mjs --notion` | Wiki-/Notion-Abgleich sofort, mit Titelliste |
| `node --env-file=.env watcher.mjs --wiki-probe` | Wiki-API abklopfen (nur zum Erkunden) |
| `node --env-file=.env watcher.mjs --discord-test` | Discord-Befehle registrieren und je eine Probemeldung schicken |

Diese Befehle laufen **zusätzlich** zum Dienst und stören ihn nicht.

> `--ausschuettung-start` verändert den gespeicherten Zustand. Nur benutzen, wenn
> die Ausschüttung wirklich stattgefunden hat – sonst zählt der Watcher falsch.

---

## 5. Einstellungen ändern

```
nano ~/private/uc-watcher/server/.env
```

Speichern mit `Strg+O`, `Enter`, schließen mit `Strg+X`. Danach **immer**
`sudo systemctl restart uc-watcher`, sonst gilt die Änderung nicht.

### Die wichtigsten Schalter

| Variable | Standard | Bedeutung |
|---|---|---|
| `UC_COOKIE` | – | Anmeldung. Ohne den läuft nichts |
| `UC_NTFY_TOPIC` | – | Dein Push-Kanal |
| `UC_NOTION_TOKEN` | – | Zugang für den Notion-Abgleich |
| `UC_LAGER_SCHWELLE` | `500` | Warnung, wenn das Lager darunter fällt |
| `UC_LAGER_EINBRUCH_PCT` | `15` | Ab wie viel Prozent plötzlichem Verlust gewarnt wird |
| `UC_PREIS_SPRUNG_PCT` | `20` | Ab welchem Preissprung gemeldet wird |
| `UC_AUSSCHUETTUNG_STD` | `12` | Zielzeit bis zur Ausschüttung |
| `UC_AUSSCHUETTUNG_STUNDENMELDUNG` | an | Stündlicher Zwischenstand – `0` schaltet ihn ab |
| `UC_TAGESBERICHT` | an | Tagesbericht um 04:00 – `0` schaltet ihn ab |
| `UC_TAGESWECHSEL_STD` | `4` | Wann der Spieltag umspringt |
| `UC_API_WEG_MELDUNG_MIN` | `30` | Ab wie vielen Minuten eine nicht erreichbare Seite gemeldet wird |
| `UC_WIKI_INTERVALL_STD` | `24` | Takt der Wiki-Prüfung |
| `UC_NOTION_INTERVALL_STD` | `168` | Takt des Notion-Abgleichs (168 = wöchentlich) |
| `UC_INTERVALL_MS` | `60000` | Abfragetakt der Firma in Millisekunden |
| `UC_DISCORD_TOKEN` | – | Bot-Token; leer = kein Discord |
| `UC_DISCORD_TEAM_KANAL` | – | Kanal für die Angestellten |
| `UC_DISCORD_CHEF_ID` | – | Deine Discord-ID für Inhaber-Meldungen |
| `UC_DEBUG` | aus | `1` macht die Logs gesprächig |

---

## 6. Wenn etwas klemmt

**„Permission denied (publickey)"** beim Verbinden
→ Der Schlüssel heißt nicht `id_rsa`, also muss er mit `-i` benannt werden:
`ssh -i "$HOME\.ssh\uc-watcher.key" ubuntu@89.168.78.21`

**Keine Benachrichtigungen mehr**
→ `node --env-file=.env watcher.mjs --push-test`. Kommt nichts an, prüfe in der
ntfy-App, ob der Kanal aus `UC_NTFY_TOPIC` noch abonniert ist.

**„📡 UnicaCity nicht erreichbar"**
→ Der Server von UnicaCity antwortet nicht. Da ist nichts zu tun, der Watcher
meldet sich von selbst wieder. Die Meldung kommt erst nach 30 Minuten Ausfall.

**`AUTH` im Log / `--test` scheitert**
→ Das Cookie ist abgelaufen. Im Browser neu bei unicacity.eu anmelden, Cookie aus
den Entwicklerwerkzeugen kopieren, in die `.env` eintragen, Dienst neu starten.

**Discord: „lehnt den Token ab (4004)"**
→ Token neu erzeugen (Developer Portal → Bot → Reset Token), in die `.env`,
Dienst neu starten. Bei diesem Fehler versucht der Bot bewusst nicht weiter.

**Discord: Befehle tauchen nicht auf**
→ Einladung ohne `applications.commands` erzeugt. Neu einladen, dann
`--discord-test`.

**Dienst startet nicht**
→ `journalctl -u uc-watcher -n 50 --no-pager` zeigt den Grund. Meist ein Tippfehler
in der `.env` (fehlendes Gleichheitszeichen, Zeilenumbruch mitten im Cookie).

**Plattenplatz voll**
→ `df -h` und `journalctl --vacuum-time=7d` (löscht Logs älter als eine Woche).

---

## 7. Discord

Vollständige Einrichtung: **DISCORD.md**. Im Alltag reichen diese:

| Befehl | Zweck |
|---|---|
| `node --env-file=.env watcher.mjs --discord-test` | Befehle neu registrieren, Zustellung prüfen |
| `journalctl -u uc-watcher \| grep discord` | Was der Bot macht |

Im Discord selbst – für alle: `/firma`, `/lager`, `/ausschuettung`, `/zeiten`,
`/hilfe`. Nur für dich: `/kasse`, `/tagesbericht`, `/watcher`, `/melden`.

`/melden` stellt um, wer welche Meldung sieht und ob dabei eine Rolle oder
@everyone gepingt wird – ohne SSH, ohne Neustart. `/melden` ohne Angaben zeigt
die aktuelle Übersicht. Die Einstellungen stehen in `uc-watcher-regeln.json`.

Antworten sieht nur, wer den Befehl eingegeben hat.

Zwei Kanäle im selben Server: `#firma-team` für alle (`UC_DISCORD_TEAM_KANAL`)
und ein privater Kanal nur für dich (`UC_DISCORD_CHEF_KANAL`).

**Was ins Team geht:** Lager, Lieferengpass, Firma pausiert, Ausschüttung,
Vorfälle – bei den letzten beiden ohne Beträge und ohne Namen.
**Was nur du bekommst:** Kasse, Buchungen, Personal, Arbeitszeiten,
Lagerverlust, Zugang und Technik.

Nach einer Änderung an `UC_DISCORD_*` immer `--discord-test`, sonst merkst du
erst im Ernstfall, dass die Zustellung nicht stimmt.

---

## 8. Notion

- Wiki-Spiegel: 17 Kategorien, 110 Artikel, je eine Unterseite
- Backup vom Umbau: Seite „Wiki (Kopie vom 17.09.)"
- Abgleich von Hand: `node --env-file=.env watcher.mjs --notion`
- Automatisch: wöchentlich, plus sofort bei neuen Wiki-Artikeln

Meldet der Abgleich „fehlt", kann es zweierlei sein: eine echte Lücke – oder ein
Titel, der im Notion anders heißt. Ein erklärender Zusatz in Klammern ist erlaubt
(`test (zweite Fassung Calderón Kartell)`), alles andere zählt als fehlend.
