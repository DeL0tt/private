# UnicaCity Unternehmen-Watcher

Push aufs Handy, wenn im Unternehmens-Dashboard etwas Wichtiges passiert.

## Was überwacht wird

| # | Regel | Auslöser |
|---|---|---|
| 1 | **Lagerbestand** | fällt unter 500 |
| 2 | **Personal** | fällt unter 6/6 |
| 3a | **Vorfall** | neuer Text mit Vorfall-Stichwort auf der Seite |
| 3b | **Ignorierte Steuerprüfung** | Firmenkasse sinkt um ≈ 8 % statt 4 % |

Bei 3a und 3b steht in der Nachricht zusätzlich, **wer in den letzten 3 Stunden
online war** — das Skript führt dauerhaft ein Online-Protokoll der
Mitarbeiterliste mit, damit diese Info im Ernstfall schon da ist.

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
Firmenkasse sowie die erkannten Online-Mitarbeiter und Vorfälle.

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
  mitarbeiter: '#mitarbeiter-liste',
},
```

Danach `ucWatcherTest()` erneut ausführen.

## Stellschrauben

| Option | Standard | Bedeutung |
|---|---|---|
| `LAGER_SCHWELLE` | 500 | Alarmgrenze Lager |
| `PERSONAL_SOLL` | 6 | Sollstärke (wird überschrieben, wenn die Seite „x/y" anzeigt) |
| `ERINNERUNG_MIN` | 60 | frühestens nach X Min. erneut zum selben Thema pushen |
| `ONLINE_LOG_MINUTEN` | 180 | Zeitfenster für „wer war online" |
| `POLL_INTERVAL_MS` | 60000 | Prüfintervall |
| `STEUER_TOLERANZ_PP` | 0.6 | Toleranz bei der Prozent-Zuordnung |
| `DEBUG` | false | ausführliches Konsolen-Log |

## Grenzen
- **Der Chrome-Tab muss offen sein.** Für 24/7 ohne laufenden Rechner bräuchte
  es einen kleinen Server mit gespeicherten Login-Cookies.
- Läuft die Session ab, kommt ein Push „Login abgelaufen".
- Der Online-Verlauf startet erst, wenn das Skript zum ersten Mal lief —
  ein Vorfall kurz nach der Installation hat noch keine Namensliste.
