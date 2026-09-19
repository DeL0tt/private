# Discord-Bot einrichten

Der Watcher kann seine Meldungen zusätzlich nach Discord schicken und dort
Slash-Commands beantworten. Alles läuft in **einem** Discord-Server, getrennt
über zwei Kanäle:

- **Team-Kanal**, den alle sehen – Betriebliches, auf das die Angestellten
  reagieren können
- **Inhaber-Kanal**, den nur du sehen kannst – Geld, Personal, Arbeitszeiten,
  Technik

Der Bot selbst läuft weiter auf deiner Oracle-VM, im selben Dienst wie der
Watcher (`uc-watcher`). Discord hostet nichts – der Bot verbindet sich von
deinem Server aus dorthin. Ein zusätzlicher Dienst ist nicht nötig.

Statt eines Inhaber-Kanals kann der Bot dir auch eine DM schicken; die Kanal-
Variante ist aber die bessere, weil dort auch Pings funktionieren und du
alles an einem Ort hast.

Die Einrichtung dauert etwa zehn Minuten und ist einmalig. Ohne
`UC_DISCORD_TOKEN` bleibt alles wie bisher – nur ntfy.

---

## 1. Bot anlegen

1. https://discord.com/developers/applications öffnen → **New Application**
2. Name eingeben, z. B. `EatingPets Watcher` → **Create**
3. Links **Bot** → **Reset Token** → **Yes, do it** → Token **kopieren**

> Der Token ist wie ein Passwort. Er gehört in die `.env` und **nirgendwo
> sonst** – nicht in Discord-Nachrichten, nicht ins Repo, nicht in
> Screenshots. Wer ihn hat, kann als dein Bot handeln. Versehentlich
> veröffentlicht? Auf derselben Seite **Reset Token** drücken, dann ist der
> alte wertlos.

Auf derselben Bot-Seite die drei Schalter unter **Privileged Gateway
Intents** ruhig **aus** lassen. Der Watcher liest keine Nachrichten mit, er
braucht nur seine eigenen Befehle.

## 2. Bot auf deinen Server einladen

1. Links **OAuth2** → **URL Generator**
2. Unter *Scopes*: **bot** und **applications.commands** ankreuzen
3. Unter *Bot Permissions*: **Send Messages** und **Embed Links** ankreuzen
4. Die erzeugte URL unten kopieren, im Browser öffnen, Server auswählen

Mehr Rechte braucht er nicht. Er liest nichts, löscht nichts, kickt niemanden.

## 3. Die zwei Kanäle anlegen

Im Server brauchst du zwei Textkanäle:

1. **`#firma-team`** – für die Angestellten. Normaler Kanal, alle dürfen rein.
2. **`#firma-leitung`** – nur für dich. So machst du ihn privat:
   Kanal anlegen → beim Anlegen **Privater Kanal** einschalten → nur dich
   (und den Bot) hinzufügen. Oder nachträglich: Rechtsklick auf den Kanal →
   **Kanal bearbeiten** → **Berechtigungen** → bei `@everyone` das Recht
   **Kanal ansehen** auf ❌ stellen, für dich und den Bot auf ✅.

> Prüfe danach, dass der **Bot** beide Kanäle sehen und beschreiben darf –
> beim privaten Kanal wird er sonst mit ausgeschlossen und die Meldungen
> kommen nirgends an. Im Zweifel den Bot im privaten Kanal ausdrücklich
> hinzufügen.

## 4. IDs besorgen

Discord zeigt IDs nur im Entwicklermodus:
**Einstellungen → Erweitert → Entwicklermodus** einschalten.

Danach mit Rechtsklick **ID kopieren**:

| Was | Wo | Für |
|---|---|---|
| Server-ID | Rechtsklick auf den Servernamen | `UC_DISCORD_GUILD` |
| Team-Kanal-ID | Rechtsklick auf den Kanal | `UC_DISCORD_TEAM_KANAL` |
| Deine Nutzer-ID | Rechtsklick auf dich selbst | `UC_DISCORD_CHEF_ID` |
| Inhaber-Kanal-ID | Rechtsklick auf `#firma-leitung` | `UC_DISCORD_CHEF_KANAL` |

## 5. In die `.env` eintragen

```
nano ~/private/uc-watcher/server/.env
```

```ini
UC_DISCORD_TOKEN=der.kopierte.token
UC_DISCORD_GUILD=123456789012345678
UC_DISCORD_TEAM_KANAL=123456789012345678    # #firma-team
UC_DISCORD_CHEF_KANAL=123456789012345678    # #firma-leitung, nur du
UC_DISCORD_CHEF_ID=123456789012345678       # deine Nutzer-ID
```

`UC_DISCORD_CHEF_ID` brauchst du auch mit eigenem Kanal: daran erkennt der Bot
bei den Befehlen, dass du der Inhaber bist.

Speichern (`Strg+O`, `Enter`, `Strg+X`), dann:

```
cd ~/private/uc-watcher/server
node --env-file=.env watcher.mjs --discord-test
```

Das registriert die Befehle und schickt **je eine Probemeldung**. Prüfe
beides:

- Kam die Inhaber-Meldung bei dir an?
- Steht im Team-Kanal **nur** die Team-Meldung?

Passt es, den Dienst neu starten: `sudo systemctl restart uc-watcher`

> Lässt du `UC_DISCORD_CHEF_KANAL` leer, schickt der Bot dir stattdessen eine
> DM. Dafür musst du Direktnachrichten von Servermitgliedern erlauben
> (**Einstellungen → Privatsphäre**), und Pings gibt es dort nicht. Mit
> gesetztem Kanal ist beides kein Thema.

---

## Wer bekommt was

| Meldung | Team | Du |
|---|---|---|
| Lagerbestand niedrig | ✅ | ✅ |
| Lieferengpass, Einkauf teurer | ✅ | ✅ |
| Firma pausiert, obwohl jemand online ist | ✅ | ✅ |
| Vorfall im Unternehmen | ✅ ohne Namen | ✅ mit Namen |
| Zwischenstand bis zur Ausschüttung | ✅ ohne Beträge | ✅ mit Gewinn |
| Ausschüttung fällig | ✅ ohne Beträge | ✅ mit Gewinn |
| Plötzlicher Lagerverlust (Diebstahlverdacht) | – | ✅ |
| Personal abgeworben / unvollständig | – | ✅ |
| Löhne nicht bezahlt, Mietrückstand | – | ✅ |
| Kassenvorfälle, unbekannte Buchungen | – | ✅ |
| Ausschüttung erfolgt (Betrag) | – | ✅ |
| Tagesbericht mit Onlinezeiten | – | ✅ |
| Zugang abgelaufen, Seite nicht erreichbar | – | ✅ |
| Wiki- und Notion-Abgleich | – | ✅ |

Wo „ohne Namen" oder „ohne Beträge" steht, bekommt das Team eine gekürzte
Fassung derselben Meldung – dieselbe Information, ohne das, was es nicht
angeht.

Das ist nur die Voreinstellung. **Mit `/melden` stellst du jede Meldung
einzeln um** – siehe unten. Die Tabelle gilt für alles, was du nicht selbst
geändert hast.

Die Voreinstellung lässt sich auch pauschal verschieben:
`UC_DISCORD_TEAM_THEMEN=lager,event_` stellt dem Team nur noch diese beiden
zu. Dieser Schalter ist ein grobes Werkzeug, darum greift er bei
`lagerverlust_` und `personal_` nicht – die enthalten Namen von Anwesenden
und sollen nicht durch einen Tippfehler in einer Liste öffentlich werden. Über
`/melden` kannst du sie trotzdem freigeben, dort ist es eine bewusste
Einzelentscheidung und der Bot sagt dir vorher, was drinsteht.

---

## Befehle

Jeder im Server kann benutzen:

| Befehl | Zeigt |
|---|---|
| `/firma` | Status, Lager, Personal, wer online ist |
| `/lager` | Bestand mit Balken, Absatz, Reichweite |
| `/ausschuettung` | Fortschritt bis zur nächsten Ausschüttung |
| `/zeiten` | Die eigene Onlinezeit heute |
| `/hilfe` | Welche Befehle es gibt |

Nur für dich:

| Befehl | Zeigt |
|---|---|
| `/kasse` | Kassenstand, Gewinn, letzte fünf Buchungen |
| `/tagesbericht` | Onlinezeiten des ganzen Teams |
| `/watcher` | Läuft er, Token-Ablauf, Erreichbarkeit |
| `/melden` | Einstellen, wer welche Meldung sieht und ob gepingt wird |

Antworten sind **nur für den Fragenden sichtbar** – es entsteht kein
Geplapper im Kanal, und `/kasse` zeigt niemandem sonst deine Zahlen. Bei
`/firma` und `/ausschuettung` siehst du zusätzlich die Beträge, alle anderen
denselben Befehl ohne.

Versucht ein Angestellter `/kasse`, bekommt er nur den Hinweis, dass das dem
Inhaber vorbehalten ist. Der Befehl wird dabei nicht ausgeführt.

### Meldungen umstellen: `/melden`

Damit änderst du im Discord selbst, **ohne SSH und ohne Neustart**, wer welche
Meldung sieht.

`/melden` ohne alles zeigt eine Übersicht aller 20 Meldungsarten mit ihrem
aktuellen Ziel. Ein ✏️ markiert, was du selbst geändert hast.

`/melden thema:<Meldung>` zeigt nur diese eine Regel.

Zum Ändern kommen `ziel:` und/oder `ping:` dazu:

| `ziel:` | Wirkung |
|---|---|
| nur ich | geht ausschließlich an dich |
| nur das Team | geht ausschließlich in den Team-Kanal |
| ich und das Team | beides, das Team in der gekürzten Fassung |
| ein bestimmter Kanal | in einen frei gewählten Kanal (`kanal:` ausfüllen) |
| gar nicht (aus) | die Meldung entfällt komplett, auch für dich |
| zurück auf Standard | die Voreinstellung aus der Tabelle oben gilt wieder |

| `ping:` | Wirkung |
|---|---|
| niemand | nur die Nachricht, keine Benachrichtigung |
| @everyone | alle im Kanal werden angepingt |
| @here | alle, die gerade online sind |
| eine Rolle | eine bestimmte Rolle (`rolle:` ausfüllen) |

**Beispiele:**

```
/melden thema:Lagerbestand niedrig  ziel:nur das Team  ping:eine Rolle  rolle:@Lagerdienst
/melden thema:Vorfall im Unternehmen  ping:@everyone
/melden thema:Wiki-Änderungen  ziel:gar nicht (aus)
/melden thema:Tagesbericht mit Onlinezeiten  ziel:zurück auf Standard
```

Drei Dinge dazu:

- **Pings wirken in Kanälen**, auch in deinem Inhaber-Kanal. Nur in einer DM
  gibt es sie nicht – dort erreicht dich die Meldung ohnehin direkt.
- **Bei heiklen Meldungen warnt der Bot.** Stellst du etwas mit Namen oder
  Beträgen auf einen geteilten Kanal um, sagt die Antwort dir, was dort
  künftig mitgelesen wird. Verboten wird es nicht – es ist deine Firma.
- **Für @everyone braucht der Bot ein Recht.** Ohne „Everyone erwähnen" im
  Kanal steht die Erwähnung nur da, ohne zu klingeln.

Die Regeln liegen in `uc-watcher-regeln.json` neben dem Zustand und gelten
sofort, auch nach einem Neustart. Löschst du die Datei, gilt wieder die
Tabelle oben.

### Eigene Zeiten für Angestellte

`/zeiten` zeigt einem Angestellten nur etwas, wenn sein Discord-Konto einem
Spielernamen zugeordnet ist:

```ini
UC_DISCORD_SPIELER=123456789012345678:LottiMi,987654321098765432:Maxine
```

Ohne Zuordnung bekommt er die Team-Summe statt fremder Arbeitszeiten.

---

## Wenn etwas klemmt

**„Discord lehnt den Token ab (4004)"**
→ Token falsch oder zurückgesetzt. Neu kopieren, in die `.env`, Dienst neu
starten. Der Bot versucht es bei diesem Fehler bewusst **nicht** endlos
weiter.

**Befehle erscheinen nicht in Discord**
→ Wurde die Einladung mit **applications.commands** erzeugt? Ohne diesen
Scope darf der Bot keine Befehle anlegen. Neu einladen und
`--discord-test` erneut laufen lassen. Mit gesetzter `UC_DISCORD_GUILD`
gelten sie sofort, ohne bis zu eine Stunde.

**Der Team-Kanal geht, der Inhaber-Kanal nicht**
→ Fast immer darf der Bot den privaten Kanal nicht sehen. Kanal bearbeiten →
Berechtigungen → Bot hinzufügen, **Kanal ansehen** und **Nachrichten senden**
auf ✅. Im Log steht dann `Discord 403 bei POST /channels/…`.

**Gar keine Meldung an dich, weder Kanal noch DM**
→ Ist `UC_DISCORD_CHEF_KANAL` leer *und* DMs gesperrt, hat der Bot keinen Weg
zu dir. Entweder Kanal setzen oder DMs erlauben (Abschnitt 5).

**Meldungen doppelt auf dem Handy**
→ ntfy und Discord liefern beide. Wenn du nur noch Discord willst,
`UC_NTFY_TOPIC` leeren. Ich würde ntfy behalten: eine dringende Meldung
klingelt dort durch den Sperrbildschirm, eine Discord-Nachricht nicht
zuverlässig.

**Der Bot ist offline, der Watcher läuft**
→ Beabsichtigt: schlägt Discord fehl, überwacht der Watcher trotzdem weiter.
`journalctl -u uc-watcher | grep discord` zeigt den Grund.
