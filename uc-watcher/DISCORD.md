# Discord-Bot einrichten

Der Watcher kann seine Meldungen zusätzlich nach Discord schicken und dort
Slash-Commands beantworten. Zwei getrennte Empfänger:

- **Team-Kanal** – Betriebliches, auf das die Angestellten reagieren können
- **Du** (DM oder eigener Kanal) – Geld, Personal, Arbeitszeiten, Technik

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

## 3. IDs besorgen

Discord zeigt IDs nur im Entwicklermodus:
**Einstellungen → Erweitert → Entwicklermodus** einschalten.

Danach mit Rechtsklick **ID kopieren**:

| Was | Wo | Für |
|---|---|---|
| Server-ID | Rechtsklick auf den Servernamen | `UC_DISCORD_GUILD` |
| Team-Kanal-ID | Rechtsklick auf den Kanal | `UC_DISCORD_TEAM_KANAL` |
| Deine Nutzer-ID | Rechtsklick auf dich selbst | `UC_DISCORD_CHEF_ID` |

## 4. In die `.env` eintragen

```
nano ~/private/uc-watcher/server/.env
```

```ini
UC_DISCORD_TOKEN=der.kopierte.token
UC_DISCORD_GUILD=123456789012345678
UC_DISCORD_TEAM_KANAL=123456789012345678
UC_DISCORD_CHEF_ID=123456789012345678
```

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

> Damit dir der Bot eine DM schicken kann, musst du mit ihm einen Server
> teilen und Direktnachrichten von Servermitgliedern erlauben
> (**Einstellungen → Privatsphäre**). Klappt das nicht, lege einen Kanal an,
> den nur du sehen kannst, und setze dessen ID als `UC_DISCORD_CHEF_KANAL` –
> dann geht es dorthin statt per DM.

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

Die Team-Liste lässt sich ändern. `UC_DISCORD_TEAM_THEMEN=lager,event_`
etwa stellt nur noch diese beiden zu, alles andere geht ausschließlich an
dich. Die Ausnahmen `lagerverlust_` und `personal_` bleiben davon unberührt:
die gehen **nie** ins Team, auch wenn man sie einträgt.

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

Antworten sind **nur für den Fragenden sichtbar** – es entsteht kein
Geplapper im Kanal, und `/kasse` zeigt niemandem sonst deine Zahlen. Bei
`/firma` und `/ausschuettung` siehst du zusätzlich die Beträge, alle anderen
denselben Befehl ohne.

Versucht ein Angestellter `/kasse`, bekommt er nur den Hinweis, dass das dem
Inhaber vorbehalten ist. Der Befehl wird dabei nicht ausgeführt.

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

**Keine DM, aber der Team-Kanal geht**
→ Siehe den Hinweis in Abschnitt 4: DMs erlauben oder
`UC_DISCORD_CHEF_KANAL` benutzen.

**Meldungen doppelt auf dem Handy**
→ ntfy und Discord liefern beide. Wenn du nur noch Discord willst,
`UC_NTFY_TOPIC` leeren. Ich würde ntfy behalten: eine dringende Meldung
klingelt dort durch den Sperrbildschirm, eine Discord-Nachricht nicht
zuverlässig.

**Der Bot ist offline, der Watcher läuft**
→ Beabsichtigt: schlägt Discord fehl, überwacht der Watcher trotzdem weiter.
`journalctl -u uc-watcher | grep discord` zeigt den Grund.
