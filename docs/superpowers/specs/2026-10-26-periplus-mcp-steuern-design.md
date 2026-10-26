# Periplus-MCP: Steuern – Design

Stand 26.10.2026. Erweitert den lesenden MCP-Server (`docs/mcp.md`, Plan `2026-10-26-periplus-mcp.md`, Branch
`feat/mcp`) um Werkzeuge, mit denen Claude Code den Prüfplan Attika 2
(`docs/superpowers/plans/2026-10-25-periplus-testlauf-attika-2.md`, Branch `pruefung/attika-2`) von lokal gegen
Produktion fährt.

## Absicht

Christian will den Testlauf Attika 2 nicht per SSH und Admin-Oberfläche begleiten müssen. Claude startet die Stufen T1–T7
auf Produktion, verfolgt sie, holt die Auswertungen und macht nach einem Befund die Anpassung (Code oder Config im Repo,
Deploy) und den nächsten Lauf. Christian bleibt für die Entscheidungen zuständig, die ihm gehören: Konflikte im Tor (A6)
und alle übrigen Prüfentscheidungen.

## Ziele

1. Jede Stufe des Prüfplans, die heute ein Knopf in der Admin-Oberfläche ist, ist ein MCP-Werkzeug.
2. Laufende Läufe lassen sich beobachten und eingreifen: beenden, fehlgeschlagenen Job wiederholen, Queue anhalten.
3. Das Navily-Tor wird ohne Navily auf dem Server ausgewertet: der Server liefert seine Daten, der Abgleich läuft lokal.
4. Nach einem Deploy ist prüfbar, welcher Code- und Config-Stand auf Produktion wirkt.
5. Kein Lauf mit Kosten startet ohne vorherige Schätzung.

## Nicht-Ziele

- Fachliche Prüfentscheidungen über MCP (Konflikte, Ortskandidaten, Vergleichsabweichungen). Claude bereitet vor, Christian entscheidet in der Oberfläche. Einzige Ausnahme: `job_retry` schließt eine offene technische Aufgabe `failed_job` wie die Oberfläche (Teil 1).
- Platz-Edits (Lage, Status, Zusammenlegen, Bilder entfernen).
- Schreibendes SQL, Shell auf dem Server, Config-Änderungen zur Laufzeit. Config ändert sich nur über Repo und Deploy, damit jede Anpassung im Git steht.
- Einmalige Betriebsschritte (Basis-Migration, `migrate-archive`, Passwort der Leserolle): bleiben SSH und Runbook.

## Anti-Ziele (wäre ein Fehlschlag, auch wenn es technisch läuft)

- Navily-Werte erreichen den Server, ein Log, einen Commit oder eine Prüfaufgabe.
- Ein Lauf kostet Geld, ohne dass vorher Umfang und Schätzung sichtbar waren.
- Über MCP entsteht eine zweite Startlogik neben der Oberfläche (andere Prüfungen, andere Sperren, andere Folge-Läufe).
- Ein über MCP gestarteter Lauf ist in der Oberfläche nicht als solcher erkennbar.

## Entscheidungen (Christian, 26.10.2026)

- **Umfang:** Läufe starten und steuern, Queues anhalten und fortsetzen, Konfliktaufgaben des Tors anlegen. Keine Prüfentscheidungen, keine Platz-Edits.
- **`job_retry`:** wie die Oberfläche: Job neu starten und eine offene `failed_job`-Aufgabe mit „Wiederholen“ schließen, `decidedBy = mcp:<email>`.
- **Absicherung:** Jedes gültige MCP-Token (eines Admins) darf steuern; kein eigener Scope.
- **Kosten:** Zwei Schritte. Ohne `confirm: true` liefert ein Start nur Umfang und Kostenschätzung; erst mit `confirm: true` startet er. Die Tagesbudgets (`config/budgets.json`) bleiben die Notbremse.
- **Branch:** `feat/mcp-steuern` von `main`, nachdem `feat/mcp` gemergt ist (dieser Entwurf liegt vorläufig auf einem Branch von `origin/feat/mcp` und wird dann auf `origin/main` umgehängt).

## Teile

### 1. Schreibende Werkzeuge

Jedes ruft dieselbe Funktion in `lib/pipeline` / `lib/domain`, die die Server-Action der Oberfläche ruft, mit
`triggeredBy = "mcp:" + caller.email`. Antwort: Lauf-ID (oder ID des schon laufenden Laufs) und Pfad der Lauf-Seite.
`RunScopeNotReady` und fachliche Ablehnungen kommen als Werkzeugfehler mit dem deutschen Text der Oberfläche.
Annotation `destructiveHint: true`, `readOnlyHint: false`.

| Werkzeug | Ruft | Argumente |
| --- | --- | --- |
| `subdivisions_rebuild` | `startSubdivisionsBuildRun` | – |
| `subdivision_build` | `startSubdivisionBuild` | `subdivision` |
| `gazetteer_start` | `startGazetteerRun` | `subdivision` |
| `seed_start` | `startSeedRun` | `subdivision` oder `tileId` |
| `datasets_start` | `startDatasetImportRun` | `subdivision` |
| `geometry_start` | `startGeometryRun` | `subdivision` oder `tileId` |
| `research_start` | `startResearchRun` | `subdivision` oder `placeIds` (≤ 500) oder `tileId` (das Werkzeug löst die Kachel zu Platz-IDs auf; der Lauf erscheint dann als Plätze-Lauf, nicht als Kachel-Lauf) |
| `images_start` | `startImageRun` | `subdivision` |
| `delivery_start` | `startDeliveryRun` | `subdivision` |
| `run_end` | `endRunByAdmin` (+ `afterBuildRunEnded` wie die Action) | `runId` |
| `job_retry` | `retryJobWithTask` (schließt eine offene `failed_job`-Aufgabe mit „Wiederholen“) | `queue`, `jobId` |
| `queue_pause` / `queue_resume` | `pauseQueue` / `resumeQueue` (`lib/jobs/controls.ts`) | `queue` |

**Kein eigenes Werkzeug für den Folgelauf** (Landrecherche/Stand, `startBerthFollowupRun`): er hat keinen Knopf, startet automatisch nach der Bestätigung (`research-confirm`) und hätte über MCP eine eigene Auswahl- und Sperrlogik gebraucht (Anti-Ziel „zweite Startlogik“). Erneut anstoßen heißt `research_start` für die Plätze. *(Entscheidung des Entwurfs.)*
| `gate_sync_conflicts` | `syncConflictTasks` | `subdivision`, `threshold`, `placeIds` |

**Zwei Schritte bei Kosten.** Alle `*_start`-Werkzeuge und `subdivision_build` haben `confirm` (Standard `false`). Ohne
`confirm` schreibt das Werkzeug nichts und liefert: Umfang (Zahl der Kacheln, Plätze bzw. Kandidaten im Bereich), die
Dienste mit Kosten, die Schätzung und den heutigen Budgetstand je Dienst. Schätzung: Kosten je Einheit aus dem letzten
beendeten Lauf derselben Art (`external_calls` dieses Laufs geteilt durch seinen Umfang) mal Umfang; ohne solchen Lauf
„keine Grundlage“ statt einer Zahl. Damit das geht, schreibt jeder Start über MCP ab jetzt seinen Umfang in `runs.params`
(`scopeSize: { unit, count }`); ältere Läufe haben keinen und ergeben „keine Grundlage“. „Dieselbe Art“ heißt dieselbe
Stufenliste (`stages`) und dieselbe Einheit. Einheiten: Recherche = Plätze, Bilder = Plätze ohne aktuelles Bild,
Lieferung = Landesteil, Aufbau und Einzelstufen = Kacheln. `subdivision_build` (Gazetteer, Datensätze, Seed,
Orts-Websites, Geometrie) bekommt eine Schätzung für den Lauf als Ganzes, nicht je Stufe. Alle schreibenden Starts
brauchen `confirm`, auch kostenlose (`subdivisions_rebuild`, Gazetteer, Seed, Geometrie); sie melden dann „ohne externe
Kosten“. `run_end`, `job_retry`, `queue_*` und `gate_sync_conflicts` haben keinen Zwei-Schritt. *(Einheiten und
`scopeSize`: Entscheidung des Entwurfs.)*

**`gate_sync_conflicts`** nimmt nur Platz-IDs und die Schwelle. Der Server prüft, dass alle IDs Plätze im Landesteil sind,
und bestimmt `scopePlaceIds` selbst (wie `measureGate`). Keine Navily-Werte im Aufruf, im Log oder im Aufgabenkontext.

### 2. Neue lesende Werkzeuge

| Werkzeug | Liefert |
| --- | --- |
| `version` | Git-SHA und Image-Tag des laufenden Deploys, letzte angewendete Migration, wirksame Config-Abschnitte `research` (inkl. `gate`, `confirmation`), `quality`, `budgets`, `models` (ohne Geheimnisse) |
| `gate_input` | alles, was die Tor-Auswertung aus der Datenbank braucht, für einen Landesteil (siehe 3) |
| `checks` | `checkGazetteer(db, bbox)` mit der Box des Landesteils (wie `scripts/check-gazetteer.ts`) und `checkGeometry(db, subdivisionKey)` (`lib/domain/geometry/check.ts`) |
| `review_tasks` | offene Aufgaben je Art und Landesteil (Liste); mit `id` Detail mit Kontext, Platz, Geometrie-Link, Signalen; Freitext unter `nicht_vertrauenswuerdig` |
| `worker` | Heartbeat der Worker, je Queue wartend/aktiv/fehlgeschlagen (pg-boss), pausierte Queues |

### 3. Tor ohne Navily auf dem Server

`measureGate` wird geteilt in
- `loadGateInput(db, subdivisionKey, cfg) → GateInput`: liest in einem Lese-Snapshot (wie heute in `measureGate`)
  Kacheln, Plätze, Urteile je Schwelle, Stand-Kernwerte, Entscheidungen der Konfliktaufgaben, Treffer; serialisierbar
  (JSON), keine Navily-Daten. Statt der Funktionen aus `subdivisionTileAreas` (`inside`, `matchable`) trägt es die
  bearbeiteten Kachel-IDs, die Kacheln des Landesteils und den Puffer;
- `evaluateGateInput(input, spots, cfg) → GateMeasurement`: rein, ohne Datenbank; baut `inside`/`matchable` aus diesen Daten neu.

`measureGate` bleibt als `evaluateGateInput(await loadGateInput(…), spots, cfg)`, damit die bestehenden Tests und der
lokale Weg unverändert laufen. `gate_input` liefert `GateInput` plus `version`-Kurzform (SHA, Config-Hash), damit der
lokale Abgleich mit der Config von Produktion rechnet, nicht mit der lokalen.

`scripts/research-gate.ts` bekommt `--via-mcp`: holt `gate_input` über HTTP vom MCP-Endpunkt (URL und Token aus
`PERIPLUS_MCP_URL` / `PERIPLUS_MCP_TOKEN`, nie als Argument), rechnet lokal mit der Navily-Datei, schreibt Bericht und
Listen wie heute; `--sync-conflicts` ruft `gate_sync_conflicts`. Weicht die lokale Config von der in `gate_input` ab,
rechnet das Skript mit der von Produktion und sagt es in der Ausgabe.

### 4. Plan Attika 2 anpassen

In `pruefung/attika-2` ersetzen die Werkzeugaufrufe die `dc run …`-Zeilen und die Knöpfe; T0 bekommt „`version` zeigt
den erwarteten SHA“; die Zählungen aus T0 Step 3 und T2 Step 3 laufen über `sql` bzw. `gate_input`.

## Sicherheit

- Gilt alles aus `docs/mcp.md` weiter (Token, Origin, Ratenlimit, Logzeile ohne Argumente).
- Schreibende Werkzeuge: zusätzlich je Aufruf eine Logzeile mit Werkzeug, Benutzer, Token, Lauf-ID; `triggeredBy` macht den Lauf in der Oberfläche kenntlich.
- Claude Code fragt bei `destructiveHint` vor jedem Aufruf; Christian kann einzelne Werkzeuge in Claude Code dauerhaft freigeben.
- Server-Anweisungen (`MCP_INSTRUCTIONS`) bekommen: „Steuern heißt Geld ausgeben: erst ohne `confirm` schätzen, dann dem Nutzer Umfang und Schätzung nennen.“

## Dem Bauenden überlassen

- Dateischnitt in `lib/mcp` (z. B. `server.ts` für Lesen, `operate.ts` für Steuern) und in `lib/domain/mcp`.
- Wie Git-SHA und Image-Tag in den Container kommen (Build-Argument / Umgebungsvariable aus `deploy.sh`).
- Form der Werkzeugantworten, solange Lauf-ID, Lauf-Pfad und deutsche Fehltexte drin sind.
- Wie `worker` die pg-boss-Zahlen liest (pg-boss-API über `getBoss()` statt der Leserolle).

## Tests

Gegen `db-test` wie die bestehenden MCP-Tests (`app/__tests__/api-mcp.test.ts`): je Startwerkzeug ein Test ohne `confirm`
(nichts geschrieben, Schätzung da) und mit (Lauf angelegt, `triggered_by = mcp:…`); `gate_sync_conflicts` lehnt fremde
Platz-IDs ab; `loadGateInput`+`evaluateGateInput` ergibt dasselbe wie das bisherige `measureGate` (bestehende
Tor-Tests); `research-gate --via-mcp` mit einem Fake-Endpunkt (kein Netz).
