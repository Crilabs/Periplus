# Periplus – MCP steuern Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Periplus-MCP-Server startet und steuert Läufe, liefert die Daten des Navily-Tors und den wirksamen Stand, sodass Claude den Prüfplan Attika 2 von lokal gegen Produktion fährt.

**Architecture:** Neue Werkzeuge in `lib/mcp/operate.ts` (schreibend) und `lib/mcp/server.ts` (lesend), Logik in `lib/domain/mcp/` und den vorhandenen Startfunktionen in `lib/pipeline`. `measureGate` wird in einen Datenbank-Teil (`loadGateInput`) und eine reine Auswertung (`evaluateGateInput`) geteilt; der Server liefert nur den Datenbank-Teil, `scripts/research-gate.ts --via-mcp` gleicht lokal mit der Navily-Datei ab.

**Tech Stack:** Next.js 16 Route Handler, `@modelcontextprotocol/sdk` 1.32.1, zod 4, Drizzle/Postgres, pg-boss 12, Vitest gegen `db-test`.

**Spec:** `docs/superpowers/specs/2026-10-26-periplus-mcp-steuern-design.md`; Grundlage `docs/mcp.md`, Plan `2026-10-26-periplus-mcp.md`.

## Global Constraints

- Branch `feat/mcp-steuern`, vor Task 1 auf `origin/main` umgehängt, sobald `feat/mcp` dort gemergt ist (`git rebase --onto origin/main b721a01`; bis dahin auf `origin/feat/mcp`).
- Navily-Werte erreichen nie den Server, ein Log, einen Commit, einen Test (nur synthetische Spots) oder einen Aufgabenkontext.
- Schreibende Werkzeuge rufen dieselbe Funktion wie die Oberfläche; keine eigene Prüf- oder Sperrlogik daneben. `triggeredBy` / `decidedBy` / `updatedBy` = `"mcp:" + caller.email`.
- Jedes `*_start`-Werkzeug und `subdivision_build`/`subdivisions_rebuild`: ohne `confirm: true` keine Schreibung (kein `runs`-Eintrag, kein Job); Antwort Umfang + Schätzung + Budgetstand.
- Schreibende Werkzeuge: `annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }`; lesende wie bisher `READ`.
- `RunScopeNotReady` → Werkzeugfehler mit dem deutschen Text aus der Oberfläche; andere Fehler weiter „Interner Fehler“.
- Logzeile je Aufruf wie `runTool` (nie Argumente); schreibende Werkzeuge zusätzlich `runId` bzw. `taskCount`.
- Code englisch, Texte in Werkzeugantworten deutsch. Vor Änderungen an `app/api/mcp/route.ts` die Next-16-Doku lesen (Route Handler).
- Tests gegen `db-test`, kein Netz, pg-boss in Tests als aufzeichnender Fake (wie `recordingBoss` in `lib/pipeline/__tests__/research-run.test.ts`).

## Review Focus

1. Start ohne `confirm` schreibt wirklich nichts, auch nicht `scopeSize` – Test in Task 5 zählt `runs` vorher/nachher.
2. `gate_sync_conflicts` mit einer Platz-ID außerhalb des Landesteils oder unbekannt → Fehler, keine Aufgabe angelegt – Test in Task 6.
3. Lokale Config weicht von Produktion ab → `--via-mcp` rechnet mit der Config aus `gate_input` und sagt es – Test in Task 7.
4. `research_start` bei geschlossenem Tor oder ohne Kandidaten → deutscher Text, kein „Interner Fehler“ – Test in Task 5.
5. `research_start` mit einer Kachel ohne Plätze → Fehler „Kachel hat keine Plätze“, kein leerer Lauf – Test in Task 5.

---

### Task 1: Tor teilen in Datenbank-Teil und Auswertung

**Files:**
- Modify: `lib/domain/research/gate-report.ts` (`measureGate`, `measureIn`, `subdivisionTileAreas`)
- Test: `lib/domain/research/__tests__/gate-report.test.ts`

**Interfaces:**
- Produces:
  - `type GateInput = { subdivisionKey: string; tiles: { all: string[]; worked: string[] }; bufferM: number; places: GateInputPlace[]; decisions: Array<[placeId: string, "berth" | "not_berth"]>; verdicts: Array<[threshold: number, Array<[placeId: string, Verdict]>]>; delivered: Array<[placeId: string, Verdict]>; config: GateConfigSnapshot }` – nur JSON-Typen; `GateInputPlace` = Rückgabe von `subdivisionPlaces` ohne `verdicts`.
  - `type GateConfigSnapshot = { research: Pick<AppConfig["research"], "gate" | "confirmation">; quality: Pick<AppConfig["quality"], "navily"> }` und `gateConfigOf(cfg: AppConfig): GateConfigSnapshot`.
  - `loadGateInput(db: Db, subdivisionKey: string, cfg: AppConfig): Promise<GateInput>` – eine read-only, repeatable-read Transaktion (wie heute).
  - `evaluateGateInput(input: GateInput, spots: NavilySpot[]): GateMeasurement` – rein, rechnet mit `input.config`; baut `inside`/`matchable` aus `tiles.worked` und `bufferM`.
  - `measureGate` unverändert in Signatur: `evaluateGateInput(await loadGateInput(db, key, cfg), spots)`.

- [ ] **Step 1: Failing tests.** `it("loadGateInput is JSON round-trippable and evaluates like measureGate")`: auf der bestehenden Tor-Fixture `expect(evaluateGateInput(JSON.parse(JSON.stringify(await loadGateInput(tx, key, cfg))), spots)).toEqual(await measureGate(…))`. `it("evaluateGateInput uses the config in the input, not getConfig")`: Input mit `config.research.gate.minConfirmed = 1` → `passedAt` gesetzt, mit `= 999` → `tooFewConfirmed`.
- [ ] **Step 2:** `npx vitest run lib/domain/research/__tests__/gate-report.test.ts` → FAIL (Exporte fehlen).
- [ ] **Step 3: Implementieren.** `subdivisionTileAreas` in `tileIds(db, key)` (liest) und `tileAreas(worked: Set<string>, bufferM)` (rein) teilen. `measureIn` in Lesen und Rechnen schneiden; Maps nur in `evaluateGateInput` aufbauen.
- [ ] **Step 4:** Test-Datei und alle Tor-Tests grün: `npx vitest run lib/domain/research scripts/__tests__/research-gate.test.ts`.
- [ ] **Step 5: Commit** `refactor(gate): split measureGate into loadGateInput and evaluateGateInput`.

### Task 2: Stand des Deploys (`version`)

**Files:**
- Modify: `docker/web.Dockerfile`, `docker/worker.Dockerfile` (`ARG GIT_SHA` + `ENV GIT_SHA=$GIT_SHA`), `.github/workflows/ci.yml` (beide Build-Schritte `build-args: GIT_SHA=${{ github.sha }}`), `lib/env.ts` (`GIT_SHA: z.string().optional()`)
- Create: `lib/domain/mcp/version.ts`
- Modify: `lib/mcp/server.ts` (Werkzeug `version`)
- Test: `lib/domain/mcp/__tests__/version.test.ts`, `app/__tests__/api-mcp.test.ts`

**Interfaces:**
- Produces: `deployVersion(db: Db, cfg: AppConfig, env: { GIT_SHA?: string }): Promise<{ gitSha: string | null; lastMigration: { tag: string; appliedAt: string } | null; configHash: string; gateConfigHash: string; config: { research; quality; budgets; models } }>`; `configHash(value: unknown): string` (SHA-256 über stabil sortiertes JSON, erste 16 Hex-Zeichen). `gateConfigHash` = `configHash(gateConfigOf(cfg))` (Task 1).
- Letzte Migration: höchster Eintrag aus `drizzle.__drizzle_migrations` (`created_at` → Tag aus `drizzle/meta/_journal.json` per `when`).

- [ ] **Step 1: Failing tests.** `configHash` ist unabhängig von der Schlüsselreihenfolge; `deployVersion` liefert `gitSha` aus `env`, `null` ohne; `lastMigration.tag` = letzter Journal-Tag in `db-test`. API-Test: `tools/list` enthält `version`; `tools/call version` ohne Fehler.
- [ ] **Step 2:** Tests laufen → FAIL.
- [ ] **Step 3:** Implementieren; Werkzeugbeschreibung „Git-SHA, letzte Migration und wirksame Config von Produktion; nach einem Deploy prüfen, dass die Änderung wirkt.“
- [ ] **Step 4:** Tests grün; `npm run lint`.
- [ ] **Step 5: Commit** `feat(mcp): tool version with git sha, migration and config hash`.

### Task 3: Lesende Werkzeuge für den Testlauf

**Files:**
- Create: `lib/domain/mcp/checks.ts`
- Modify: `lib/mcp/server.ts` (Werkzeuge `gate_input`, `checks`, `review_tasks`, `worker`), `lib/domain/review-view.ts` (nur falls `listOpenTasks` einen Landesteil-Filter braucht)
- Test: `app/__tests__/api-mcp.test.ts`, `lib/domain/mcp/__tests__/checks.test.ts`

**Interfaces:**
- Consumes: `loadGateInput`, `gateConfigOf` (Task 1), `deployVersion` (Task 2).
- Produces:
  - `gate_input { subdivision }` → `{ version: { gitSha, gateConfigHash }, input: GateInput }`; Namen in `input.places[].names` unter `untrusted`.
  - `checks { subdivision }` → `subdivisionChecks(db, key): Promise<{ gazetteer: GazetteerCheck; geometry: GeometryCheck }>` (`checkGazetteer(db, (await requireSubdivision(db, key)).bbox)`, `checkGeometry(db, key)`).
  - `review_tasks { kind?, id?, limit? }` → ohne `id` `listOpenTasks` + `reviewCounts`; mit `id` `reviewTaskDetail` unter `untrusted`, dazu `adminPath: "/review/<id>"`.
  - `worker {}` → `{ heartbeats: workerHeartbeats-Zeilen mit Alter in s, queues: queuesView(db) }`.

- [ ] **Step 1: Failing tests.** Je Werkzeug ein API-Test: `gate_input` für einen Landesteil der Fixture enthält `input.tiles.all` und keine Navily-Felder (`spots` nicht im JSON); unbekannter Landesteil → `isError` „Landesteil … unbekannt“. `checks` liefert beide Teile. `review_tasks` mit einer angelegten `research_conflict`-Aufgabe listet sie; Detail hat `nicht_vertrauenswuerdig`. `worker` liefert `queues`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren; `MCP_INSTRUCTIONS` um die neuen Werkzeuge ergänzen.
- [ ] **Step 4:** Grün; Liste der Werkzeuge im bestehenden `tools/list`-Test anpassen.
- [ ] **Step 5: Commit** `feat(mcp): read tools gate_input, checks, review_tasks, worker`.

### Task 4: Umfang und Kostenschätzung

**Files:**
- Create: `lib/domain/mcp/estimate.ts`
- Modify: `lib/pipeline/research-run.ts` (`researchCandidates` exportieren)
- Test: `lib/domain/mcp/__tests__/estimate.test.ts`

**Interfaces:**
- Produces:
  - `type ScopeUnit = "places" | "tiles" | "subdivision"`; `type ScopeSize = { unit: ScopeUnit; count: number }`.
  - `type StartKind = "subdivisions" | "build" | "gazetteer" | "seed" | "datasets" | "geometry" | "research" | "images" | "delivery"`.
  - `STAGES_OF: Record<StartKind, readonly string[]>` aus den vorhandenen Konstanten (`RESEARCH_STAGES`, `SUBDIVISION_BUILD_STAGES`, …).
  - `COSTLESS: ReadonlySet<StartKind>` = `subdivisions`, `gazetteer`, `seed`, `geometry`.
  - `scopeSize(db: Db, kind: StartKind, scope: StartScope): Promise<ScopeSize>` – Recherche: `researchCandidates(db, input).length`, Einheit `places`; Bilder: bestätigte Plätze des Landesteils ohne aktuelles Bild, `places`; Lieferung: `{ subdivision, 1 }`; übrige: Zahl der Küstenkacheln des Landesteils (`subdivisionTileIds`) bzw. 1 bei `tileId`, `tiles`; `subdivisions`: `{ subdivision, 0 }`.
  - `estimateCost(db: Db, kind: StartKind, size: ScopeSize): Promise<{ eur: number | null; basis: { runId: string; costEur: number; size: ScopeSize } | null; text: string }>` – letzter beendeter Lauf (`status = 'finished'`) mit gleichen `stages` und `params.scopeSize.unit = size.unit`, `count > 0`; Kosten = `sum(external_calls.cost_eur) where run_id = basis`; `eur = round2(cost / basis.count * size.count)`. `COSTLESS` → `eur: 0`, Text „ohne externe Kosten“. Kein Basislauf → `eur: null`, Text „keine Grundlage (noch kein vergleichbarer Lauf)“.
  - `recordScopeSize(db: Db, runId: string, size: ScopeSize): Promise<void>` – `params = params || {"scopeSize": …}`.

- [ ] **Step 1: Failing tests.** Zwei beendete Recherche-Läufe mit `scopeSize` und `external_calls` (Helfer `test/external-calls.ts`) → Schätzung aus dem jüngeren; Lauf ohne `scopeSize` → `keine Grundlage`; `geometry` → 0 € ohne Datenbankabfrage nach Kosten; Lauf mit anderer `stages`-Liste zählt nicht.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** Grün.
- [ ] **Step 5: Commit** `feat(mcp): scope size and cost estimate from the last comparable run`.

### Task 5: Startwerkzeuge mit Zwei-Schritt

**Files:**
- Create: `lib/mcp/operate.ts`, `lib/pipeline/run-scope-labels.ts`
- Modify: `app/(admin)/_components/labels.ts` (Label-Map nach `run-scope-labels.ts` verschieben, dort re-exportieren), `lib/mcp/server.ts` (`registerOperateTools(server, caller)` aufrufen), `lib/mcp/result.ts` (`RunScopeNotReady` → Werkzeugfehler mit `RUN_SCOPE_LABELS[reason]`)
- Test: `app/__tests__/api-mcp-operate.test.ts`

**Interfaces:**
- Consumes: `scopeSize`, `estimateCost`, `recordScopeSize`, `STAGES_OF` (Task 4); `budgetStatus` (`lib/domain/costs.ts`); Startfunktionen `startSubdivisionsBuildRun`, `startSubdivisionBuild`, `startGazetteerRun`, `startSeedRun`, `startDatasetImportRun`, `startGeometryRun`, `startResearchRun`, `startImageRun`, `startDeliveryRun`; `getBoss`.
- Produces:
  - `registerOperateTools(server: McpServer, caller: McpCaller): void`.
  - Werkzeuge `subdivisions_rebuild {confirm?}`, `subdivision_build {subdivision, confirm?}`, `gazetteer_start {subdivision, confirm?}`, `seed_start {subdivision | tileId, confirm?}`, `datasets_start {subdivision, confirm?}`, `geometry_start {subdivision | tileId, confirm?}`, `research_start {subdivision | placeIds (1–500) | tileId, confirm?}`, `images_start {subdivision, confirm?}`, `delivery_start {subdivision, confirm?}`. Genau eines der Scope-Felder, sonst Werkzeugfehler.
  - Antwort ohne `confirm`: `{ gestartet: false, umfang: ScopeSize, schaetzung: {eur, text, basisLauf}, budgets: BudgetStatus[], hinweis: "Mit confirm: true starten." }`.
  - Antwort mit `confirm`: `{ gestartet: true, runId, pfad: "/runs/<id>", umfang, schaetzung }`; `startSubdivisionBuild` mit `alreadyRunning` → `{ gestartet: false, laeuftSchon: runId, pfad }`.
  - `research_start {tileId}`: Platz-IDs = gültige, nicht zusammengelegte Plätze mit `places.tile_id = tileId`; leer → `ToolError("Kachel hat keine Plätze")`.
  - Nach erfolgreichem Start `recordScopeSize(db, runId, umfang)`.

- [ ] **Step 1: Failing tests.** Mit `vi.mock("@/lib/jobs/boss")` → aufzeichnender Fake. Je ein Test:
  - `research_start {subdivision}` ohne `confirm`: `runs`-Zahl unverändert, `gestartet: false`, `umfang.unit = "places"`.
  - dasselbe mit `confirm: true`: ein Lauf, `triggered_by = "mcp:<email>"`, `params.scopeSize` gesetzt.
  - `research_start` für einen Landesteil außerhalb `gate.subdivision` bei `released: false` → `isError`, Text „Recherche erst nach bestandenem Navily-Test …“.
  - `research_start {tileId}` einer Kachel ohne Plätze → „Kachel hat keine Plätze“.
  - `geometry_start` ohne `confirm` → `schaetzung.text = "ohne externe Kosten"`.
  - zwei Scope-Felder → Werkzeugfehler.
  - `tools/list` markiert `research_start` mit `destructiveHint: true`.
- [ ] **Step 2:** `npx vitest run app/__tests__/api-mcp-operate.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren; ein gemeinsamer Helfer `startTool(kind, scope, confirm, start: () => Promise<{id}|{alreadyRunning}>)` für alle Startwerkzeuge.
- [ ] **Step 4:** Grün; `npm run lint`; bestehende Oberflächen-Tests zu `labels.ts` grün.
- [ ] **Step 5: Commit** `feat(mcp): start runs with estimate first, confirm second`.

### Task 6: Läufe und Queues steuern, Konfliktaufgaben anlegen

**Files:**
- Modify: `lib/mcp/operate.ts`
- Test: `app/__tests__/api-mcp-operate.test.ts`

**Interfaces:**
- Consumes: `endRunByAdmin`, `afterBuildRunEnded`, `retryJobWithTask`, `pauseQueue`, `resumeQueue`, `QUEUES`, `syncConflictTasks`, `loadGateInput` (für `scopePlaceIds`).
- Produces:
  - `run_end {runId}` → `{ beendet: ended, aufgeraeumt: cleanedUp }`; danach `afterBuildRunEnded` wenn `ended` (wie `endRunAction`).
  - `job_retry {queue: enum(QUEUES), jobId: uuid}` → `retryJobWithTask(db, boss, { queue, jobId, decidedBy: "mcp:"+email })`.
  - `queue_pause {queue}` → `pauseQueue(db, queue, null, "manual", "mcp:"+email)`; `queue_resume {queue}` → `resumeQueue(db, queue, "mcp:"+email)`.
  - `gate_sync_conflicts {subdivision, threshold, placeIds: uuid[] (0–500)}` → prüft `threshold ∈ cfg.research.gate.thresholds` und `placeIds ⊆ scopePlaceIds` des Landesteils (aus `loadGateInput(...).places`); sonst `ToolError` mit der Zahl fremder IDs (nicht die IDs selbst); dann `syncConflictTasks(db, placeIds, threshold, scopePlaceIds)` → `{ angelegt, offen }`.

- [ ] **Step 1: Failing tests.** `run_end` auf einem laufenden Lauf → Status `ended`, `ended_by = mcp:…`. `queue_pause` → Zeile in `queue_controls` mit `updated_by = mcp:…`; `queue_resume` entfernt sie. `job_retry` mit offener `failed_job`-Aufgabe → Aufgabe entschieden mit `retry`, `decided_by = mcp:…`. `gate_sync_conflicts` mit einer fremden Platz-ID → `isError`, keine `research_conflict`-Aufgabe; mit eigenen IDs → Aufgaben angelegt, zweiter Aufruf legt keine weitere an; unzulässige Schwelle → Fehler.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** Grün.
- [ ] **Step 5: Commit** `feat(mcp): end runs, retry jobs, pause queues, sync gate conflicts`.

### Task 7: Lokaler Tor-Abgleich über MCP

**Files:**
- Create: `scripts/mcp-client.ts`
- Modify: `scripts/research-gate.ts` (`--via-mcp`), `lib/env.ts` (`PERIPLUS_MCP_URL`, `PERIPLUS_MCP_TOKEN` optional), `.env.example`
- Test: `scripts/__tests__/research-gate.test.ts`, `scripts/__tests__/mcp-client.test.ts`

**Interfaces:**
- Consumes: `evaluateGateInput`, `gateConfigOf`, `configHash`, Werkzeuge `gate_input`, `gate_sync_conflicts`.
- Produces:
  - `callMcpTool(opts: { url: string; token: string; fetch?: typeof fetch }, name: string, args: object): Promise<unknown>` – ein JSON-RPC `tools/call` ohne Session (der Server ist zustandslos; vorher kein `initialize` nötig, falls das SDK es verlangt: `initialize` im selben Aufruf vorschalten), parst `content[0].text` als JSON, `isError` → `Error(text)`; `nicht_vertrauenswuerdig`-Hüllen auspacken.
  - `parseArgs` kennt `--via-mcp`; dann kein `DATABASE_URL` nötig, `PERIPLUS_MCP_URL`/`PERIPLUS_MCP_TOKEN` Pflicht (Fehltext nennt beide), nie als Argument.
  - Ablauf `--via-mcp`: `gate_input` → `evaluateGateInput(input, spots)` → Bericht/Listen wie heute; Ausgabezeile `Produktion: <gitSha>, Tor-Config <hash>`; weicht `configHash(gateConfigOf(getConfig()))` ab: Zeile „lokale Tor-Config weicht ab, gerechnet mit der von Produktion“. `--sync-conflicts` → `gate_sync_conflicts` mit `m.conflictThreshold` und den Konflikt-Platz-IDs.

- [ ] **Step 1: Failing tests.** `callMcpTool` gegen einen Fake-`fetch` (Antwort wie `route.POST`): Ergebnis geparst; `isError` wirft. `research-gate --via-mcp` mit Fake-Client: Bericht entsteht, Ausgabe nennt SHA; abweichende lokale Config → Hinweiszeile und Rechnung mit der Input-Config; `--sync-conflicts` ruft `gate_sync_conflicts` mit den IDs, ohne Navily-Werte in den Argumenten (Assertion: Argumente enthalten nur `subdivision`, `threshold`, `placeIds`).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren; `runGate` so schneiden, dass DB-Weg und MCP-Weg dieselbe Bericht-/Listen-Ausgabe nutzen.
- [ ] **Step 4:** Grün.
- [ ] **Step 5: Commit** `feat(gate): research:gate --via-mcp evaluates production data locally`.

### Task 8: Doku und Prüfplan

**Files:**
- Modify: `docs/mcp.md` (Abschnitte „Steuern“, Tabelle der neuen Werkzeuge, Zwei-Schritt, `--via-mcp` mit `PERIPLUS_MCP_URL`/`PERIPLUS_MCP_TOKEN` in `.env.local`, nie im Repo), `docs/runbook.md` (Abschnitt MCP: Läufe über MCP erkennbar an `mcp:`), `lib/mcp/server.ts` (`MCP_INSTRUCTIONS`: „Steuern heißt Geld ausgeben: erst ohne `confirm` schätzen, dann dem Nutzer Umfang und Schätzung nennen.“)
- Modify (anderer Branch, eigener Commit): `docs/superpowers/plans/2026-10-25-periplus-testlauf-attika-2.md` auf `pruefung/attika-2` – T0 Step 1 „`version` zeigt den SHA von `main`“; T1–T7 Knöpfe/`dc run` → Werkzeugaufrufe; T4 Step 1 `npm run research:gate -- --via-mcp --subdivision GR-I --sync-conflicts --out-dir <scratchpad> --report docs/pilot/neuausrichtung/attika-2/tor.md`; T0 Step 3 und T2 Step 3 über `sql`/`gate_input`.

- [ ] **Step 1:** Doku schreiben.
- [ ] **Step 2:** `npm run lint && npm run build && npx vitest run app/__tests__/api-mcp*.test.ts lib/domain/mcp lib/domain/research scripts/__tests__` → alles grün.
- [ ] **Step 3: Commit** `docs(mcp): steering tools and the gate via MCP`; auf `pruefung/attika-2`: `docs(plan): Attika 2 runs through the Periplus MCP`.
