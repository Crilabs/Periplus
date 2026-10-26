# Übergabe: Prüfung Attika 2 auf Produktion (per MCP, Auswertung gegen Navily)

Stand 26.10.2026, 13:30. Für eine frische Claude-Code-Session.

## Auftrag

Den Prüfplan `docs/superpowers/plans/2026-10-25-periplus-testlauf-attika-2.md` (T0–T8) auf **Produktion** für den
Landesteil `GR-I` (Attika) ausführen. Gesteuert wird **ausschließlich über den Periplus-MCP** von lokal (kein SSH, kein
`dc run`, keine Knöpfe). Ausgewertet wird **lokal gegen die Navily-Referenz** mit `research:gate --via-mcp`. Ergebnis ist
die Tor-Entscheidung (T8): Erfassung für Griechenland freigeben oder Nachschärf-Plan.

Arbeitsweise: Skill `superpowers:executing-plans`, Schritt für Schritt, Erwartung vor jedem Schritt ins Protokoll.
Code-Befunde → eigener `fix/…`-Branch mit `superpowers:systematic-debugging` + TDD, PR, Deploy, dann `version` prüfen.

## Wo arbeiten

- Worktree: `/Users/christian/Code/periplus/.claude/worktrees/attika-2`, Branch `pruefung/attika-2`.
- `origin/main` (4a005d0, inkl. N7 und MCP-Steuerung) ist lokal schon hineingemergt (Merge-Commit, noch nicht gepusht).
- `.env.local` ist ein Symlink auf die des Haupt-Checkouts (`PERIPLUS_MCP_URL`, `PERIPLUS_MCP_TOKEN`,
  `NAVILY_SPOTS_PATH` absolut auf `/Users/christian/Code/periplus/data/navily/navily-spots.json`). `npm ci` ist gelaufen.
- Protokolle: `docs/pilot/neuausrichtung/attika-2/T<n>-<stufe>.md`; Befunde als neue Zeilen in
  `docs/pilot/pruefung/befunde.md` (nächste Nummer nach **B25**).

## Ausgangsstand (geprüft 26.10.2026, 13:30)

| Prüfung | Ergebnis |
| --- | --- |
| MCP `version` | `gitSha` 4a005d0 = `origin/main`; letzte Migration `0082_mcp_reader_login`; `gateConfigHash` 7d3da3c5b8cf1d15 |
| MCP-Werkzeuge | alle 25 da (11 lesend, 14 steuernd), Server `periplus` in Claude Code verbunden (`--scope user`) |
| Produktion leer (A2) | `subdivisions`, `geo_objects`, `runs`, `places` = 0 |
| Worker | ein Heartbeat, alle Queues leer, nichts pausiert |

Damit ist T0 Step 1 im Kern erledigt; im Protokoll nur noch `/readyz` und CI-Status ergänzen.

## Ablauf über MCP (Kurzfassung des Plans)

Jeder Start: **erst ohne `confirm`** (Umfang, Schätzung, Budgetstand ins Protokoll), **dann mit `confirm: true`**.
Verfolgen mit `runs`, `runs {id}`, `worker`, `costs`; Fehler mit `job_retry`; Zählungen mit `sql` (nur lesend).

| Schritt | MCP-Aufrufe | Prüfung |
| --- | --- | --- |
| T1 Raumgliederung | `subdivisions_rebuild`, dann `subdivision_build {subdivision: "GR-I"}` | `checks {subdivision: "GR-I"}` (gazetteer) |
| T2 Kandidaten | `datasets_start`, `seed_start`, `geometry_start` (je `GR-I`) | `checks` (geometry); alle Küstenkacheln bearbeitet |
| T3 Rauchprobe | `research_start {tileId: "q025:813:510"}` | Kosten je Kandidat → Hochrechnung |
| T3 Hauptlauf | `research_start {subdivision: "GR-I"}`, danach 2. Durchgang | Schätzung muss zur Hochrechnung passen |
| T4 Tor | lokal, siehe unten; `gate_sync_conflicts` über `--sync-conflicts` | Konflikte bereitet Claude vor, Christian entscheidet |
| T6 Ortsbilder | `images_start {subdivision: "GR-I"}` | Schätzung ist auf `maxGenerationsPerRun` gedeckelt, Rückstand steht als `rueckstand` |
| T7 Lieferung | `delivery_start {subdivision: "GR-I"}` | `delivery:consume` gegen `/api/v4` |

Nicht per MCP möglich (bewusst): Prüfentscheidungen (Konflikte, Titelbilder) trifft Christian in der Oberfläche,
Claude bereitet sie mit `review_tasks` vor. Speicher (`docker stats`, T1 Step 2) gibt der MCP nicht her: Christian
fragen oder nur Dauer und OOM-Freiheit über `runs`/`worker` belegen.

## Auswertung gegen Navily (T2 Step 3, T4, T5)

```bash
npm run research:gate -- --via-mcp --subdivision GR-I --sync-conflicts \
  --out-dir /private/tmp/<scratchpad>/attika-2-tor \
  --report docs/pilot/neuausrichtung/attika-2/tor.md
```

- Das Skript holt die Datenbank-Seite per MCP-Werkzeug `gate_input` und rechnet lokal mit der Navily-Datei. Die Datei
  kommt nie auf den Server.
- Die erste Ausgabezeile nennt den Produktions-SHA und den Tor-Config-Hash. Weicht die lokale Config ab, wird mit der
  von Produktion gerechnet. Ein Konfigurations-Commit wirkt erst nach Deploy.
- `--out-dir` muss außerhalb des Repos liegen (Einzellisten mit Navily-Werten). Eingecheckt wird nur `tor.md` (Zählungen).
- Die kostenlosen Vorabgleiche (T1 Step 4 Gerüst, T2 Step 3 Kandidaten-Obergrenze) und die Navily-Zählungen
  (T0 Step 3) sind lokale Skripte im Scratchpad. Die DB-Seite holen sie per `sql` bzw. `gate_input`, Navily aus
  `NAVILY_SPOTS_PATH`.

## Harte Regeln

- **Navily nie ins Repo**, nie in Commits, Protokolle, Tickets, MCP-Argumente oder Logs. Nur Zählungen und Quoten.
- **Navily ist nie Datenquelle.** Status ändert nur eine Entscheidung von Christian.
- **Nur `GR-I`**, kein zweiter Landesteil, kein „Alle aufbauen“.
- **Kein Handgriff an Daten:** kein schreibendes SQL. Korrektur nur über Config, Code-Fix mit Regressionstest
  (`fixtures:record -- --subdivision GR-I`) oder Review-Entscheidung.
- **Kosten:** Vor jedem kostenpflichtigen `confirm: true` (Recherche, Ortsbilder) Schätzung und Budgetstand im Protokoll.
  Überschreitung der Hochrechnung um mehr als 50 % → `queue_pause`/`run_end`, Ursache prüfen, Christian melden.
- **Konflikte (A6) entscheidet Christian**, alle, mit Luftbild, Belegen und Einschätzung von Claude.
- Nur Doku/Config auf `pruefung/attika-2`. Push und PR nur nach Rückfrage. Der PR nach `main` kommt erst in T8 Step 3.

## Wann Christian fragen

- Vor dem ersten kostenpflichtigen Start (T3 Rauchprobe) und vor dem Hauptlauf (Kostenrahmen aus T3 Step 2).
- Vor jedem Budget-Commit, jedem Fix-PR-Merge und Deploy.
- Bei jedem Tor, das nicht bestanden ist, mit Befund, Ursache und Vorschlag.
- Konfliktentscheidungen (T4 Step 3) und Titelbild-Review (T6 Step 3).

## Erster Schritt der neuen Session

1. Diese Datei und den Prüfplan lesen; `docs/mcp.md` (Abschnitt „Steuern“) überfliegen.
2. MCP `version` und `worker` aufrufen und mit der Tabelle oben vergleichen.
3. T0 abschließen (Vorher-Werte aus `n3-tor.md`/`n1-probelauf.md`, Navily-Zählungen, Config festhalten), `T0-eingang.md`
   schreiben, committen.
4. T1 starten.
