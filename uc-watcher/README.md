# UnicaCity Unternehmen-Watcher

Push aufs Handy, wenn im Unternehmens-Dashboard etwas Wichtiges passiert.

## Was überwacht wird

| # | Regel | Auslöser |
|---|---|---|
| 1 | **Lagerbestand** | fällt unter 500 |
| 2 | **Personal** | fällt unter 6/6 |
| 2b | **Personal ändert sich** | jede Veränderung, z. B. 6/6 → 5/6 |
| 3a | **Vorfall** | neuer Text mit Vorfall-Stichwort auf der Seite |
| 3b | **Ignorierte Steuerprüfung** | Firmenkasse sinkt um ≈ 8 % statt 4 % |

Bei **jeder** dieser Meldungen hängt das Skript an, **welche Spieler online
waren, wie lange die laufende Sitzung schon lief und wie lange sie heute
insgesamt online waren**.

## Spieler-Online-Tracking

Gemeint sind die Spieler-Accounts (`maaxxyyy`, `halo361`, …), nicht die
Firmen-Mitarbeiter. Das Skript prüft jede Minute, wer online ist, und führt
pro Spieler Buch:

- **laufende Sitzung** — seit wann ununterbrochen online
- **heute gesamt** — Summe aller Sitzungen des Tages (Reset um Mitternacht)
- **zuletzt gesehen** — für Spieler, die inzwischen offline sind

Eine Lücke von mehr als 10 Minuten (`LUECKE_MIN`) zählt als neue Sitzung.

Bei einem Personalverlust lautet die Nachricht dann z. B.:

```
🚨 Mitarbeiter verloren (Abwerbung?)
Personal: 6/6 → 5/6
1 Mitarbeiter weg – Abwerbung wurde nicht abgewendet.

Online zum Zeitpunkt der Änderung:
• maaxxyyy — online, Sitzung 2 Std. 14 Min., heute 3 Std. 40 Min.
• halo361 — zuletzt vor 12 Min., Sitzung 48 Min., heute 1 Std. 5 Min.
```

### Einrichtung des Trackings
Trage deine Spielernamen in `CONFIG.SPIELER` ein — das ist der zuverlässigste
Weg, weil dann gezielt nach genau diesen Namen gesucht wird:

```js
SPIELER: ['maaxxyyy', 'halo361', 'weiterer_spieler'],
```

Steht die Online-Liste auf einer **anderen Seite** als dem Unternehmens-
Dashboard, trage deren Adresse ein — sie wird dann im Hintergrund mit
abgefragt:

```js
ONLINE_URL: 'https://unicacity.eu/dashboard/spieler',
SEL_ONLINE: '#online-liste',   // optional, grenzt die Suche ein
```

### Zur Steuerprüfungs-Rechnung
Eine bearbeitete Prüfung kostet 4 % der Firmenkasse, eine ignorierte 8 %.
Das Skript merkt sich den Kassenstand bei jedem Durchlauf. Sinkt die Kasse,
wird der prozentuale Abzug berechnet:

- **≈ 4 %** → „Steuerprüfung bezahlt" (nur Info)
- **≈ 8 %** → **Alarm**: ignoriert, inkl. Mehrkosten (= die Hälfte des Abzugs)
  und Liste der zuletzt online gewesenen Mitarbeiter

Toleranz ±0,6 Prozentpunkte, damit normale Ein-/Auszahlungen nicht
fälschlich als Prüfung gelten. Achtung: Fällt eine große Auszahlung zufällig
in diesen Bereich, gibt es einen Fehlalarm — das lässt sich ohne echte
Vorfall-Anzeige auf der Seite nicht vollständig ausschließen.

## Einrichtung

### 1. ntfy-App
Android (Play Store) bzw. iOS (App Store) → **„ntfy"** installieren.

### 2. Topic abonnieren
Etwas Zufälliges wählen, z. B. `uc-firma-9f3a2b7c`, in der App unter
**+ → Topic abonnieren** eintragen. Topics sind öffentlich — wer den Namen
errät, liest mit, also nicht raten lassen.

### 3. Tampermonkey
Chrome Web Store → **Tampermonkey** installieren.

### 4. Skript einfügen
Tampermonkey → **Dashboard → + (neues Skript)** → Inhalt von
`unicacity-unternehmen-watcher.user.js` einfügen → **Strg+S**.

### 5. Topic eintragen
Im `CONFIG`-Block oben: `NTFY_TOPIC: 'uc-firma-9f3a2b7c'`.

### 6. Erkennung prüfen — **wichtig**
Dashboard öffnen, **F12** → Konsole, dann eingeben:

```js
ucWatcherTest()
```

Es erscheint eine Tabelle mit den erkannten Werten für Lager, Personal und
Firmenkasse sowie die erkannten Online-Spieler und Vorfälle.

Zwei weitere Konsolen-Befehle:

```js
ucWatcherZeiten()   // Tabelle: Status, laufende Sitzung, heute gesamt, zuletzt
ucWatcherReset()    // alle gespeicherten Werte und Zeiten löschen
```

- **Stimmen alle Werte?** → fertig, nichts weiter zu tun.
- **Steht irgendwo `null` oder eine falsche Zahl?** → Selektor nachtragen:
  Rechtsklick auf den Wert auf der Seite → *Untersuchen* → im Elements-Panel
  Rechtsklick auf die markierte Zeile → *Copy → Copy selector*, und im
  `CONFIG.SEL`-Block eintragen:

```js
SEL: {
  lager:       '#stats > div.lager > span.value',
  personal:    '.personal-count',
  kasse:       '#firmenkasse .value',
  vorfaelle:   '#events',
},
SEL_ONLINE: '#online-spieler',
```

Danach `ucWatcherTest()` erneut ausführen.

## Stellschrauben

| Option | Standard | Bedeutung |
|---|---|---|
| `LAGER_SCHWELLE` | 500 | Alarmgrenze Lager |
| `PERSONAL_SOLL` | 6 | Sollstärke (wird überschrieben, wenn die Seite „x/y" anzeigt) |
| `ERINNERUNG_MIN` | 60 | frühestens nach X Min. erneut zum selben Thema pushen |
| `ONLINE_FENSTER_MIN` | 180 | Zeitfenster für „wer war online" in Meldungen |
| `LUECKE_MIN` | 10 | Pause, ab der eine neue Sitzung gezählt wird |
| `SPIELER` | – | Liste der zu trackenden Spielernamen |
| `POLL_INTERVAL_MS` | 60000 | Prüfintervall |
| `STEUER_TOLERANZ_PP` | 0.6 | Toleranz bei der Prozent-Zuordnung |
| `DEBUG` | false | ausführliches Konsolen-Log |

## Grenzen
- **Der Chrome-Tab muss offen sein.** Für 24/7 ohne laufenden Rechner bräuchte
  es einen kleinen Server mit gespeicherten Login-Cookies.
- Läuft die Session ab, kommt ein Push „Login abgelaufen".
- Die Online-Zeiten werden im Minutentakt abgetastet, sind also auf ±1 Minute
  genau. Läuft der Browser nicht, wird nichts erfasst — die Tagessumme zeigt
  dann nur die Zeit, in der auch das Skript lief.
- Der Verlauf startet erst mit der Installation; ein Vorfall unmittelbar
  danach hat noch keine Namensliste.
