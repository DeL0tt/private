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
| 1 | **Lagerbestand** | fällt unter 500 |
| 1b | **Lagerverlust** | plötzlicher Einbruch, den der Absatz nicht erklärt |
| 2 | **Personal (NPCs)** | Änderung der `6/6`-Kachel, z. B. 6/6 → 5/6 |
| 3a | **Vorfall** | Meldungen-Karte zeigt nicht mehr „Alles ruhig" |
| 3b | **Ignorierte Steuerprüfung** | Firmenkasse sinkt um ≈ 8 % statt 4 % |
| 4 | **Ausschüttung** | Buchung im Kassenbuch / 12 Std. Teamzeit erreicht |
| 5 | **Tagesbericht** | täglich um 04:00: wer war wie lange online |
| 6 | **Firma pausiert** | obwohl jemand aus dem Team online ist |
| 7 | **Lieferengpass** | Ereignis der Firma oder Sprung der Einkaufspreise |
| 8 | **Wiki** | täglich: neue, geänderte und entfernte Artikel |

Bei **jeder** Meldung hängt der Online-Bericht der Spieler an: wer online war,
wie lange die laufende Sitzung lief, wie lange am Spieltag insgesamt.

### Personal ≠ Team
Zwei verschiedene Dinge auf der Seite, das Skript hält sie auseinander:

- **PERSONAL-Kachel** (`6/6`, *131% EFFIZIENZ*) → die **NPCs**, die abgeworben
  werden können. **Das ist Regel 2.**
- **TEAM-Leiste** (`TEAM · 5 / 8`) → die **Spieler**. Daraus wird nur der
  Online-Status gelesen, sie löst keinen Personal-Alarm aus.

### Wer war dabei?
Bei **jedem** Vorfall steht in der Meldung, wer aus dem Team zu dem Zeitpunkt
online war — bei Abwerbung, Einbruch, Steuerprüfung, unbekannten Buchungen und
Meldungen der Firma.

Ein plötzlicher Lagerverlust wird gegen zwei Dinge gerechnet:

1. den **laufenden Absatz** (`salesPerMinute` mal verstrichene Minuten, mit Aufschlag)
2. die **Einnahmen im selben Zeitfenster** aus dem Kassenbuch

Punkt 2 ist der entscheidende: Ein **Großauftrag** kostet ebenso viel Bestand
wie ein Einbruch — bringt aber Geld. Das Kassenbuch nennt dabei die Stückzahl
(„Großauftrag · 400x Luxusgüter"), die vom Verlust abgezogen wird. Was danach
übrig bleibt und mindestens 15 % des Bestands ausmacht, gilt als Vorfall.

Zwei bewusste Zurückhaltungen, damit keine Fehlalarme entstehen:

- Lief der Watcher zwischendurch **nicht**, wird gar nicht geprüft.
- Gab es eine Einnahme, deren **Stückzahl nicht ablesbar** ist, schweigt der
  Watcher lieber, als einen Großauftrag als Einbruch zu melden. Ein Einbruch
  exakt im selben Moment würde dann übersehen — das ist der Preis dafür, dass
  du nicht ständig grundlos aufgeschreckt wirst.

### Wiki-Überwachung
Einmal am Tag (`UC_WIKI_INTERVALL_STD`) werden alle Artikel abgerufen und mit
dem letzten Stand verglichen. Die Wiki-API ist **öffentlich**, dafür braucht es
also keinen Zugang:

- `GET /api/wiki/categories` — die 17 Kategorien
- `GET /api/wiki/categories/<slug>/articles` — Artikel samt Inhalt und `updatedAt`

Erkannt werden neue, geänderte und entfernte Artikel. Als geändert gilt ein
Artikel, wenn sich `updatedAt` **oder** die Inhaltslänge unterscheidet — so
fallen auch stille Korrekturen auf. Jede Zeile enthält den Link zum Artikel
(`https://unicacity.eu/wiki/<kategorie>/<id>`).

Der erste Lauf meldet nichts, er legt nur den Ausgangsstand an. Ein Durchlauf
über alle 110 Artikel dauert rund 4 Sekunden.

### Lieferengpass
Zwei Wege, damit nichts durchrutscht:

1. **`company.event`** — meldet die Firma den Vorfall selbst, wird alles
   ausgegeben, was darin steht (Art, Restdauer, Aufschlag).
2. **Einkaufspreise** — steigt `deskUnitPrice` im Schnitt über alle Waren um
   mindestens 20 %, wird ein Engpass vermutet. Das greift auch dann, wenn die
   Firma kein Ereignis meldet.

Nennt die Firma das Ereignis, entfällt die Preismeldung — sonst käme dieselbe
Sache zweimal. Beide Meldungen nennen den Stand der **Expresslieferung**
(freie Plätze, Aufschlag, Sperrzeit), damit du direkt entscheiden kannst.

```
🚨 Vorfall im Unternehmen
type: LIEFERENGPASS
minutesLeft: 25
purchaseSurcharge: 0.35
endsAt: 14:59

Expresslieferung: 4 von 4 Plätzen frei, Aufschlag 35 %

Online zum Zeitpunkt:
• LottiMi — online, Sitzung 2 Std. 14 Min., heute 3 Std. 40 Min.
```

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
> Wandzeit, in der die Firma tatsächlich lief — also *mindestens ein* Spieler
> online **und** die Firma nicht pausiert. Keine Aufsummierung über die Spieler.

Läuft beides auseinander — jemand ist online, die Firma steht trotzdem still —
kommt eine eigene Meldung. Das deutet auf ein Problem hin, etwa unbezahlte
Löhne, und der Zähler würde sonst stillschweigend nicht weiterlaufen.

### Tagesbericht um 04:00
Zum Spieltagswechsel kommt eine Übersicht über den abgelaufenen Tag:

```
📊 Onlinezeiten 16.09.
Spieltag 16.09.2026 (04:00 bis 04:00)

• LottiMi — 3 Std. 25 Min.
• halo361 — 48 Min.

Summe aller Spieler: 4 Std. 13 Min.
Davon Firma gelaufen: 4 Std. 0 Min. von 12 Std. bis zur Ausschüttung
```

Den Zwischenstand des laufenden Tages gibt es jederzeit mit
`node watcher.mjs --tagesbericht`. Abschalten mit `UC_TAGESBERICHT=0`.

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
ucWatcherAPI()             // zeigt, welche API die Seite anzapft (für Variante B)
ucWatcherAusschuettungStart()  // 12-Std-Zähler neu starten (verpasste Ausschüttung)
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

Die Server-Fassung liest **nicht** die Webseite, sondern die API, die das
Dashboard selbst benutzt: `GET /api/panel/company`. Das ist unempfindlich
gegen Design-Änderungen und liefert Dinge, die auf der Seite gar nicht stehen.

Was daraus direkt kommt — nichts davon muss geraten werden:

| Feld | Bedeutung |
|---|---|
| `stock.total` / `capacity` | Lagerbestand |
| `employees[]` / `maxEmployees` | Personal (NPCs) |
| `members[].online` | welcher **Spieler** gerade online ist |
| `kasse.balance` | Firmenkasse |
| `kasse.profitSincePayout` | Gewinn seit Ausschüttung |
| `event`, `wagesUnpaid`, `rentStrikes` | Vorfälle und Notlagen |

Dazu das Kassenbuch (`/api/panel/company/ledger`). Dessen `category` macht die
Erkennung exakt: Eine Buchung **„Ausschüttung"** setzt den 12-Stunden-Zähler
zurück, eine Buchung mit einer Vorfall-Kategorie (Steuerprüfung, Razzia,
Überfall …) löst sofort Alarm aus. Eine Kategorie, die der Watcher nicht kennt,
wird einmalig gemeldet, damit nichts unbemerkt bleibt.

Eine Spielerliste musst du nicht mehr pflegen — neue Mitglieder erscheinen
automatisch, sobald sie in der Firma sind.

### 1. Zugang besorgen

Die API verlangt einen Token, der **nur 2 Stunden** gültig ist. Erneuert wird er
über `POST /api/auth/refresh` — und der Aufruf weist sich mit einem **Cookie**
aus, nicht mit dem alten Token. Das wurde im Browser nachgemessen:

| Ausweis | Ergebnis |
|---|---|
| nur Token (`Authorization`) | ❌ HTTP 401 |
| nur Cookie | ✅ HTTP 200, liefert neuen Token |

Der Watcher braucht also **das Cookie** — den Token holt er sich selbst, immer
5 Minuten vor Ablauf und zusätzlich bei jedem abgewiesenen Aufruf. Erneuert der
Server dabei auch das Cookie, übernimmt er das automatisch.

**So kommst du an das Cookie:** Im eingeloggten Chrome auf dem Dashboard
**F12** → **Application** → links **Cookies** → **https://api.unicacity.eu**.

Dort stehen ein oder mehrere Einträge. Schreib sie als eine Zeile zusammen,
Name und Wert mit `=`, mehrere durch `; ` getrennt:

```
UC_COOKIE="refreshToken=abc123...; sid=xyz789..."
```

Alternativ über **Network** → einen Aufruf an `api.unicacity.eu` anklicken →
**Request Headers** → die Zeile `cookie:` kopieren.

> Dieses Cookie ist dein Zugang. Es gehört in die `.env` (steht in
> `.gitignore`) — nicht in einen Commit und nicht in einen Chat. Die
> Zustandsdatei enthält es später ebenfalls und wird deshalb nur für dich
> lesbar angelegt (`0600`).

Wie lange es hält, hängt vom Server ab — üblicherweise Wochen. Läuft es ab,
kommt ein Push „Zugang abgelaufen", und du hinterlegst ein neues.

### 2. Einrichten

```bash
cd ~/uc-watcher
cp .env.example .env
nano .env                       # Zugang und Topic eintragen
node --env-file=.env watcher.mjs --test
```

`--test` zeigt einmalig alle Werte und die Team-Liste, ohne etwas zu senden.

### 3. Dauerbetrieb

```bash
sudo cp uc-watcher.service /etc/systemd/system/
sudo nano /etc/systemd/system/uc-watcher.service   # Benutzer und Pfade anpassen
sudo systemctl daemon-reload
sudo systemctl enable --now uc-watcher
journalctl -u uc-watcher -f
```

### 4. Laufender Betrieb

```bash
node --env-file=.env watcher.mjs --zeiten              # Online-Zeiten
node --env-file=.env watcher.mjs --ausschuettung       # Fortschritt
node --env-file=.env watcher.mjs --ausschuettung-start # Zähler neu starten
node --env-file=.env watcher.mjs --push-test           # Handy-Zustellung prüfen
```

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
