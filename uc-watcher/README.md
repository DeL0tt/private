# UnicaCity Unternehmen-Watcher

Push aufs Handy, wenn im Unternehmens-Dashboard etwas Wichtiges passiert.

Es gibt zwei Varianten — dieselben Regeln, unterschiedlicher Betrieb:

| | `unicacity-unternehmen-watcher.user.js` | `server/watcher.mjs` |
|---|---|---|
| Läuft in | Chrome (Tampermonkey) | Node.js auf einem Dauerläufer |
| Browser nötig? | ja, Tab muss offen sein | **nein** |
| Online-Erkennung | gerenderte Farbe (sehr zuverlässig) | Farbe aus dem HTML-Quelltext |
| Einrichtung | 5 Minuten | ~20 Minuten, braucht Pi/VPS/NAS |

Empfehlung: mit dem Userscript anfangen, und wenn es läuft, auf die
Server-Variante umziehen.

---

## Was überwacht wird

| # | Regel | Auslöser |
|---|---|---|
| 1 | **Lagerbestand** | fällt unter 500 (von aktuell `1284 / 1500`) |
| 2 | **Personal (NPCs)** | Änderung der `6/6`-Kachel, z. B. 6/6 → 5/6 |
| 3a | **Vorfall** | Meldungen-Karte zeigt nicht mehr „Alles ruhig" |
| 3b | **Ignorierte Steuerprüfung** | Firmenkasse sinkt um ≈ 8 % statt 4 % |
| 4 | **Ausschüttung** | Gewinn wurde zurückgesetzt / 12 Std. Teamzeit erreicht |

Bei **jeder** Meldung hängt der Online-Bericht der Spieler an: wer online war,
wie lange die laufende Sitzung lief, wie lange am Spieltag insgesamt.

### Personal ≠ Team
Zwei verschiedene Dinge auf der Seite, das Skript hält sie auseinander:

- **PERSONAL-Kachel** (`6/6`, *131% EFFIZIENZ*) → die **NPCs**, die abgeworben
  werden können. **Das ist Regel 2.**
- **TEAM-Leiste** (`TEAM · 5 / 8`) → die **Spieler**. Daraus wird nur der
  Online-Status gelesen, sie löst keinen Personal-Alarm aus.

### Abwerbung zuordnen
Sinkt die Personal-Kachel, meldet das Skript, wer zu dem Zeitpunkt online war —
diese Spieler haben die Abwerbung nicht abgewendet:

```
🚨 Personal abgeworben
Personal: 6/6 → 5/6
1 NPC weg – Abwerbung wurde nicht abgewendet.

Online zum Zeitpunkt der Änderung:
• maaxxyyy — online, Sitzung 2 Std. 14 Min., heute 3 Std. 40 Min.
• halo361 — zuletzt vor 12 Min., Sitzung 48 Min., heute 1 Std. 5 Min.
```

### Steuerprüfung
Bearbeitet kostet 4 % der Firmenkasse, ignoriert 8 %. Das Skript merkt sich den
Kassenstand; sinkt er, wird der Prozentsatz berechnet:

- **≈ 4 %** → „Steuerprüfung bezahlt" (nur Info)
- **≈ 8 %** → **Alarm**: ignoriert, mit den vermeidbaren Mehrkosten (= halber
  Abzug) und den Spielern, die online waren

Toleranz ±0,6 Prozentpunkte. Fällt eine große normale Auszahlung zufällig in
diesen Bereich, gibt es einen Fehlalarm — ohne echte Vorfall-Anzeige lässt sich
das nicht sauber trennen.

### Ausschüttung
Eine Ausschüttung wird daran erkannt, dass **„Gewinn seit Ausschüttung" unter
1.000 zurückgesetzt** wird. Ab dann zählt das Skript die **Team-Onlinezeit** bis
zur nächsten Ausschüttung:

> **Mehrere gleichzeitig online zählen nur einmal.** Gezählt wird die reine
> Wandzeit, in der *mindestens ein* Spieler online war — keine Aufsummierung
> über die Spieler.

**Bei jeder vollen Online-Stunde** kommt eine Fortschrittsmeldung:

```
⏱️ 3 von 12 Std. bis zur Ausschüttung
Team-Onlinezeit: 3 Std. 0 Min.
Noch 9 Std. 0 Min. bis zur nächsten Ausschüttung.
Gewinn bisher: 157.285 $

Gerade online: LottiMi, maaxxyyy
```

Bei 12 Std. kommt „Ausschüttung ist fällig" — **einmalig**, nicht stündlich
wiederholt. Erst nach der nächsten Ausschüttung beginnt der Zähler von vorn.
Abschalten lässt sich die Stundenmeldung mit
`AUSSCHUETTUNG_STUNDENMELDUNG: false` bzw. `UC_AUSSCHUETTUNG_STUNDENMELDUNG=0`.

Den Zwischenstand siehst du jederzeit:

```js
ucWatcherAusschuettung()              // im Browser
node watcher.mjs --ausschuettung      // auf dem Server
```

```
Erreicht     7 Std. 20 Min.
Ziel         12 Std.
Fehlt        4 Std. 40 Min.
Fortschritt  61 %
```

### Online-Zeiten
Ein Spieler gilt als online, wenn sein **Punkt in der Team-Leiste grün** ist
(`bg-emerald-400`, grau ist `bg-foreground/30`). Gesucht wird **nur innerhalb
der Team-Leiste** — die NPC-Mitarbeiter darüber haben ebenfalls grüne Punkte
und dürfen nicht mitgezählt werden. Pro Spieler wird geführt:
laufende Sitzung, Tagessumme und „zuletzt gesehen". Eine Lücke über 10 Minuten
gilt als neue Sitzung. **Der Tageszähler setzt um 04:00 zurück**, nicht um
Mitternacht.

Erfasste Spieler: `LottiMi`, `maaxxyyy`, `halo361`, `Lexae`, `777ELITE`,
`jqshey`. Weitere trägst du bei `CONFIG.SPIELER` bzw. `UC_SPIELER` nach.

---

## Variante A — Userscript im Browser

### 1. ntfy-App
Android (Play Store) / iOS (App Store) → **„ntfy"** installieren.

### 2. Topic abonnieren
Etwas Zufälliges wählen, z. B. `uc-firma-9f3a2b7c`, in der App unter
**+ → Topic abonnieren** eintragen. Topics sind öffentlich — wer den Namen
errät, liest mit.

### 3. Tampermonkey
Chrome Web Store → **Tampermonkey** installieren.

### 4. Skript einfügen
Tampermonkey → **Dashboard → + (neues Skript)** → Inhalt von
`unicacity-unternehmen-watcher.user.js` einfügen → **Strg+S**.

### 5. Topic eintragen
Oben im `CONFIG`-Block: `NTFY_TOPIC: 'uc-firma-9f3a2b7c'`.

### 6. Erkennung prüfen
Dashboard öffnen, **F12** → Konsole:

```js
ucWatcherTest()            // erkannte Werte + Online-Spieler
ucWatcherDump()            // gemessene Farben pro Spielerkarte
ucWatcherZeiten()          // Online-Zeiten
ucWatcherAusschuettung()   // Fortschritt bis zur Ausschüttung
ucWatcherReset()           // alles zurücksetzen
```

Die Werte werden über ihre Beschriftung gefunden (Kachel-Aufbau:
`<div>1284 / 1500</div><p>Lager · …</p>`, der Wert steht immer VOR dem Label).
Ändert die Seite ihren Aufbau, kannst du feste Selektoren nachtragen
(Rechtsklick auf den Wert → *Untersuchen* → *Copy → Copy selector*):

```js
SEL: {
  lager:     '#kachel-lager .wert',
  personal:  '#kachel-personal .wert',
  kasse:     '#firmenkasse .wert',
  gewinn:    '#gewinn-seit-ausschuettung',
  vorfaelle: '#events',
},
SEL_ONLINE: '#team-leiste',
```

Wird ein Spieler fälschlich als offline geführt, zeigt `ucWatcherDump()` die
gemessenen Farben — dann `GRUEN_MIN_R_ABSTAND` / `GRUEN_MIN_B_ABSTAND`
etwas senken.

---

## Variante B — Server, ohne offenen Browser

Braucht einen Rechner, der durchläuft: **Raspberry Pi, kleiner VPS, NAS oder
ein Mini-PC**. Ein alter Pi reicht völlig. Node.js ab Version 18, keine
weiteren Pakete.

### 1. Cookie exportieren
Der Watcher braucht deine Session, weil die Seite Login verlangt.

1. Im eingeloggten Chrome das Dashboard öffnen
2. **F12** → Reiter **Network/Netzwerk** → Seite neu laden (**F5**)
3. Den obersten Eintrag (`unternehmen`) anklicken
4. Unter **Request Headers** die Zeile **`cookie:`** suchen
5. Rechtsklick → *Copy value* — das ist der komplette Wert für `UC_COOKIE`

> Diese Zeile ist so wertvoll wie dein Passwort. Sie gehört in die `.env`
> (steht in `.gitignore`), nicht in einen Commit und nicht in einen Chat.

### 2. Einrichten

```bash
cd server
cp .env.example .env
nano .env               # UC_COOKIE und UC_NTFY_TOPIC eintragen
node --env-file=.env watcher.mjs --test
```

`--test` zeigt einmalig alle erkannten Werte, ohne etwas zu pushen. Sieht das
gut aus, weiter zum Dauerbetrieb.

### 3. Dauerbetrieb (systemd)

```bash
sudo cp uc-watcher.service /etc/systemd/system/
sudo nano /etc/systemd/system/uc-watcher.service   # User und Pfade anpassen
sudo systemctl daemon-reload
sudo systemctl enable --now uc-watcher
journalctl -u uc-watcher -f                        # Log mitlesen
```

Der Dienst startet nach einem Neustart oder Absturz von selbst wieder. Der
Zustand liegt in `uc-watcher-state.json` und wird atomar geschrieben,
übersteht also auch einen Stromausfall.

### 4. Laufender Betrieb

```bash
node watcher.mjs --zeiten          # Online-Zeiten aller Spieler
node watcher.mjs --ausschuettung   # Fortschritt bis zur Ausschüttung
```

Läuft das Cookie ab, kommt ein Push „Cookie abgelaufen" — dann Schritt 1
wiederholen. Wie lange es hält, hängt von der Seite ab; erfahrungsgemäß
Wochen, manchmal nur Tage.

---

## Alle Einstellungen

| Userscript | Server (.env) | Standard | Bedeutung |
|---|---|---|---|
| `NTFY_TOPIC` | `UC_NTFY_TOPIC` | – | ntfy-Topic |
| `LAGER_SCHWELLE` | `UC_LAGER_SCHWELLE` | 500 | Alarmgrenze Lager |
| `PERSONAL_SOLL` | `UC_PERSONAL_SOLL` | 6 | Rückfall, wenn kein `x/y` lesbar |
| `SPIELER` | `UC_SPIELER` | 6 Namen | getrackte Spieler |
| `AUSSCHUETTUNG_STD` | `UC_AUSSCHUETTUNG_STD` | 12 | Teamzeit bis zur Ausschüttung |
| `AUSSCHUETTUNG_GEWINN_SCHWELLE` | `UC_AUSSCHUETTUNG_SCHWELLE` | 1000 | darunter = ausgeschüttet |
| `AUSSCHUETTUNG_STUNDENMELDUNG` | `UC_AUSSCHUETTUNG_STUNDENMELDUNG` | an | Meldung bei jeder vollen Online-Stunde |
| `TAGESWECHSEL_STD` | – | 4 | Tageszähler-Reset um 04:00 |
| `LUECKE_MIN` | `UC_LUECKE_MIN` | 10 | Pause, ab der eine neue Sitzung zählt |
| `ERINNERUNG_MIN` | `UC_ERINNERUNG_MIN` | 60 | Cooldown je Thema |
| `POLL_INTERVAL_MS` | `UC_INTERVALL_MS` | 60000 | Prüfintervall |
| `ONLINE_FENSTER_MIN` | – | 180 | Zeitfenster für „wer war online" |
| `DEBUG` | `UC_DEBUG` | aus | ausführliches Log |

## Grenzen
- Die Zeiten werden im Minutentakt abgetastet, also auf ±1 Minute genau.
- Zeiten, in denen der Watcher nicht lief, werden **nicht** mitgezählt —
  Lücken über 10 Minuten werden übersprungen statt geschätzt.
- Die Steuerprüfungs-Erkennung ist eine Schlussfolgerung aus dem Kassenstand,
  kein direkt gemeldeter Vorfall.
