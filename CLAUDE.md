# CLAUDE.md

## Arbeitsweise: Delegation an Subagenten

- Der Haupt-Agent erledigt Aufgaben nie selbst, sondern delegiert die Arbeit immer an Subagenten (Agent-Tool).
- Modellwahl nach Schwierigkeit – so günstig wie möglich:
  - **Haiku 4.5** (`model: haiku`): einfache, mechanische Aufgaben – Dateien lesen/suchen, kleine Änderungen, Umbenennungen, Formatierung, Commits/Push.
  - **Sonnet** (`model: sonnet`): normale Entwicklungsaufgaben – Features, Bugfixes, Refactorings, Tests, Recherche.
  - **Opus** (`model: opus`): nur wenn die Leistung wirklich nötig ist – komplexe Architektur, schwierige Fehleranalyse, anspruchsvolle Planung.
- Der Haupt-Agent koordiniert nur: Aufgabe zerlegen, Subagenten beauftragen, Ergebnisse prüfen und dem Nutzer berichten.
- Unabhängige Teilaufgaben parallel an mehrere Subagenten vergeben.
