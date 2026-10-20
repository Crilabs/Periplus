# Periplus 14b – Reviere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Reviere into AI-found, overlapping name areas: found per Landesteil from SERP hits and guides, backed by verbatim quotes, approved by lanes without waiting, edited in the map; plus the coarse gazetteer's islands, gulfs, archipelagos and towns and the mention re-read when a Landesteil starts. Completes spec 14.

**Architecture:** `geo_objects` of type `area` get `area_status`, `approval_kind` and `area_polygon_origin`; new tables `area_members` (working state) and `area_evidence` (append-only). A Revier finding (stages `areas.discover` → `areas.fetch` → `areas.extract` → `areas.resolve`) runs inside every subdivision build before discovery and as a standalone run of kind `area_probe`. Pure domain functions decide merge, polygon and lane (`lib/domain/areas/*`); automatic decisions are recorded as decided `area_candidate` tasks with `decided_by = 'system'`. Discovery, mentions and delivery read only approved areas and key area SERP queries by the area id. The map gets a Revier layer with detail panel and edit actions.

**Tech Stack:** Next.js 16 (App Router, server actions), TypeScript, Drizzle ORM + hand-written SQL migrations, Postgres/PostGIS, pg-boss, zod, MapLibre GL, vitest against the worktree test DB, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-periplus-14-raumgliederung-design.md` (sections Gazetteer in zwei Stufen (coarse row), Reviere, Quellenfindung, Erwähnungen, Landesteil-Lauf step 3 and 5, Admin-UI `/map` and review, Konfiguration, Umstellung step 2 (pilot areas) and 4, Tests). Plan 14a (`2026-10-20-periplus-14a-landesteile.md`) is merged.

## Global Constraints

- Code, identifiers, tables, API, prompts: English. UI copy: German. „Revier“ in UI, `area` in code, public id prefix `ar_`.
- Domain logic only in `lib/domain` and `lib/pipeline`; pages, API routes and job handlers stay thin.
- Thresholds, buffers, templates, budgets, prompts: `config/`, not code. External services only via adapters in `lib/adapters`; tests never call the network (recorded fixtures, `fixtureTransport`), AI only via `MockModel`.
- Tests run against real Postgres (worktree DB `periplus_rv_test`, set in the skip-worktree `vitest.config.mts`), each in `withRollback`; committed geo rows must lie outside 23.0–23.75 E × 37.0–38.0 N.
- Append-only tables use `forbid_mutation` + `_no_truncate` triggers; stable tables `forbid_delete` + history (`record_history`). `area_evidence` is append-only, `area_members` is working state (replaced per recomputation).
- **Kein Revier ohne Zitat:** an area created by the finding always has at least one `area_evidence` row whose quote `locateQuote` found in its chunk. The two pilot areas are the only areas without evidence (manual, from configuration).
- The model never produces coordinates; polygons come from member geometries, an OSM gulf, or an admin's hand drawing.
- A manual decision (`approval_kind = 'manual'`), `rejected` status or a manual polygon (`area_polygon_origin = 'manual'`) is never changed by an automatic step.
- Nothing in the pipeline waits on an area decision: lanes set status immediately; review tasks are optional corrections.
- Documents fetched by the probe from sources that are not `approved` are archived but never enter text runs (stage 6 ff.) until their source is approved.
- Before touching routes, `proxy.ts` or `next.config.ts`: read the Next 16 docs in `node_modules/next/dist/docs/`.
- Work happens in worktree branch `feat/reviere` (`.claude/worktrees/reviere`); never commit to `main`.
- Per task finish: `npx vitest run <touched test files>`, then `npm run typecheck` and `npm run lint` before the commit. Migrations via `npm run db:generate` (schema) or `npx drizzle-kit generate --custom --name <name>` (triggers, data); next free number 0058.

## Review Focus

1. Two extractions of the same Revier from different documents under different spellings („Saronischer Golf“ / „Saronic Gulf“ / „Σαρωνικός“) merge into one area, not three; one with clearly different members stays separate. Test in Task 4.
2. A deferred area gains its second source in a later run (or a missing member appears after the fine gazetteer) and moves to `approved/auto`; an area an admin decided (`manual`) or rejected keeps its state through every rerun. Tests in Tasks 4 and 6.
3. A probe hit on a domain without a source, on a proposed one and on a rejected one: first two archive the page and leave exactly one open `source_approval` task; rejected is skipped; none of these documents reaches `textRunVersions`. Test in Task 5.
4. Hull of members that lie on both sides of a peninsula: the polygon never contains land more than 1 km inland, and a single-member or collinear member set still yields a valid polygon (buffered), never an SQL error. Test in Task 4.
5. Merge of two areas in the map while one has an open `area_candidate` task: names, evidence, members move; the merged one ends with `merged_into_id`; its open task is dismissed; SERP history keyed by the old id still maps to the surviving area's tiles. Tests in Tasks 8 and 7.

---

### Task 1: Configuration – `areas.json`, templates, budget, prompt

**Files:**
- Create: `config/areas.json`, `config/prompts/area-extract/v1.md`, `lib/ai/tasks/area-extract.ts`
- Modify: `lib/config/schemas.ts` (`areasConfigSchema`, `discoverySchema.templates.subdivisionArea`, `budgetsSchema.areaProbe`), `lib/config/index.ts` (`AppConfig.areas`), `config/discovery.json`, `config/budgets.json`, `config/models.json` (task `area-extract`)
- Test: `lib/config/__tests__/config.test.ts`, `lib/ai/__tests__/area-extract.test.ts`

**Interfaces:**
- Produces `getConfig().areas: AreasConfig`:
  - `lanes: { minSources: 2, minMembers: 2, duplicateOverlap: 0.7, duplicateNameSimilarity: 0.6 }`
  - `merge: { nameSimilarity: 0.6, memberOverlap: 0.5 }` (member overlap = |A∩B| / min(|A|,|B|) over resolved member ids)
  - `polygon: { bufferNm: 3, concaveRatio: 0.3, inlandCutM: 1000, gulfCoverShare: 0.9 }`
  - `extract: { docTypes: ["pilot_guide", "travel_guide"], maxChunksPerVersion: 40, maxCharsPerVersion: 60000, neighbourRing: 1 }`
- `getConfig().discovery.templates.subdivisionArea: Template[]` – `Segelreviere {name}` (de, 2276), `Revierführer {name}` (de, 2276), `sailing areas {name}` (en, 2826), `{name} charter cruising areas` (en, 2826), `{name} sailing guide` (en, 2826).
- `getConfig().budgets.areaProbe: { maxSerpQueries: 30, maxDocuments: 60, maxModelEur: 2 }` (per subdivision probe; `budgetsSchema` keeps the per-service daily keys).
- `areaExtractTask: ModelTask<AreaExtractInput, AreaExtractOutput>` with `AreaExtractInput = { title: string; url: string; chunks: Array<{ index: number; text: string }> }` and output `{ areas: Array<{ chunk: number; quote: string; names: Array<{ name: string; language: string }>; boundary: string; members: string[]; boundaryMembers: string[] }> }`. Variables: `title`, `url`, `chunks` rendered as `[<index>]\n<text>` blocks.
- `config/models.json` `tasks["area-extract"] = { model: "claude-haiku-5-5", promptVersion: 1, effort: "low", maxTokens: 8000 }` (classification class).

- [ ] **Step 1: Failing tests:** `loads areas.json` (values above), `rejects duplicateOverlap outside 0..1` (message starts `Invalid config areas:`), `discovery has subdivisionArea templates with {name}`, `budgets.areaProbe loaded`; `area-extract prompt renders all variables` (`loadPrompt("area-extract", 1)` + `renderPrompt` with the task's variables does not throw and contains `[0]`), `area-extract output rejects an item without quote`.
- [ ] **Step 2: Run** `npx vitest run lib/config/__tests__/config.test.ts lib/ai/__tests__/area-extract.test.ts` → FAIL.
- [ ] **Step 3: Write config and prompt.** Prompt (system): extract every named sailing area (Segelrevier, cruising area, gulf or island group used as an area name) the text names; per area the verbatim quote (12–300 chars, copied exactly from the numbered chunk, no ellipsis) that names it, all names with ISO 639-1 language, the boundary in the text's words (empty when the text gives none), member names (islands, places, gulfs, archipelagos the text puts inside) and boundary names (capes or places the text uses as limits); no areas the text only mentions in passing as a country or region; no coordinates; answer only with JSON. Implement schema with zod `strictObject`, number ranges via `.min/.max`.
- [ ] **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(config): areas.json, subdivisionArea templates, area probe budget and area-extract prompt (spec 14)`.

### Task 2: Schema – area status, members, evidence, enums, pilot areas

**Files:**
- Modify: `lib/db/schema/geo.ts` (enums `area_status` (`candidate|approved|deferred|rejected`), `approval_kind` (`auto|manual`), `area_polygon_origin` (`computed|gulf|manual`); columns `geo_objects.area_status`, `approval_kind`, `area_polygon_origin`; tables `area_members`, `area_evidence`), `lib/db/schema/ops.ts` (`run_kind` + `area_probe`), `lib/db/schema/sources.ts` (`serp_level` + `subdivision`), `lib/db/schema/review.ts` (`review_kind` + `area_candidate`)
- Create: `drizzle/0058_areas_schema.sql` (generated), `drizzle/0059_areas_triggers_and_pilot.sql` (`--custom`)
- Test: `lib/db/__tests__/areas-schema.test.ts`

**Interfaces:**
- `area_members`: `area_id uuid → geo_objects not null`, `geo_object_id uuid → geo_objects not null`, `role area_member_role ('member'|'boundary') not null`, `origin area_member_origin ('extraction'|'review') not null`, `created_at`; PK `(area_id, geo_object_id)`; index on `geo_object_id`. Plain table (replaced per recomputation; DELETE allowed).
- `area_evidence`: `id uuid pk (newId)`, `area_id → geo_objects not null`, `document_version_id → document_versions not null`, `chunk_id → chunks not null`, `quote text not null`, `quote_start int not null`, `quote_end int not null` (UTF-16, end exclusive, check `0 <= start < end`), `names jsonb not null` (`[{name, language}]`), `boundary text not null default ''`, `resolved_member_ids uuid[] not null default '{}'`, `unresolved_members text[] not null default '{}'`, `boundary_member_ids uuid[] not null default '{}'`, `domain text not null` (registrable domain of the document's source, for lane counting), `extraction_run_id uuid → runs`, `model text`, `prompt_version int`, `created_at`. Unique `(area_id, chunk_id, quote_start)`. Index `area_id`. Append-only (`forbid_mutation('area_id')`: only `area_id` may change, for merges) + `_no_truncate`.
- Check constraints on `geo_objects`: `area_status is null or type = 'area'`; `approval_kind is not null when area_status = 'approved'`.
- Drizzle exports: `areaMembers`, `areaEvidence`, `areaStatusEnum`, `approvalKindEnum`, `areaPolygonOriginEnum`, types `AreaStatus`, `ApprovalKind`, `AreaPolygonOrigin`.
- 0059: recreate `geo_objects_record_history` with `'type,geom,parent_id,subdivision_id,sea_id,valid_to,area_status,approval_kind,area_polygon_origin,merged_into_id'`; append-only triggers for `area_evidence`; data: every valid `area` object without `area_status` → `area_status='approved'`, `approval_kind='manual'`, `area_polygon_origin='manual'` (the pilot areas `saronic`, `argolic`; spec Umstellung step 2).

- [ ] **Step 1: Failing tests:** `area_evidence rejects UPDATE of quote and DELETE`, `area_evidence allows moving area_id`, `area_status on a non-area is rejected`, `approved without approval_kind is rejected`, `status change writes geo_objects_history`, `run kind area_probe, serp level subdivision and review kind area_candidate accepted`, `area_members delete allowed`.
- [ ] **Step 2: Run** `npx vitest run lib/db/__tests__/areas-schema.test.ts` → FAIL.
- [ ] **Step 3: Schema + both migrations.** Enum additions (`ALTER TYPE … ADD VALUE`) must sit in 0058 alone if drizzle puts them in a transaction with uses; the data update in 0059 does not use new enum values of `run_kind`/`review_kind`.
- [ ] **Step 4: Run** → PASS; also `npx vitest run lib/db/__tests__` (no regressions in history tests); typecheck.
- [ ] **Step 5: Commit** `feat(db): area status, members, evidence; run kind area_probe, serp level subdivision, review kind area_candidate; pilot areas approved (spec 14)`.

### Task 3: Coarse gazetteer – islands, archipelagos, gulfs, towns

**Files:**
- Modify: `lib/adapters/overpass.ts` (`buildCoarseFeatureQuery`), `lib/pipeline/gazetteer/coarse.ts` (`importCoarseFeatures`, called by the `gazetteer.coarse` country job after boundaries), `lib/domain/gazetteer/osm-classify.ts` (if a type mapping is missing), `config/gazetteer.json` + schema (`coarse: { placeTypes: ["city","town"], islandMinAreaKm2: 1, gulfMinAreaKm2: 20, coastDistanceKm: 5 }`), `scripts/fixtures-record.ts` (`--coarse` also records the feature query)
- Create fixtures: `test/fixtures/http/overpass/*` for MT (record with `npx tsx scripts/fixtures-record.ts --coarse MT` against a `*_scratch` DB; network allowed only here)
- Test: `lib/adapters/__tests__/overpass-coarse.test.ts`, `lib/pipeline/__tests__/gazetteer-coarse.test.ts` (extend)

**Interfaces:**
- `buildCoarseFeatureQuery(country: string, cfg: GazetteerConfig["coarse"], timeoutSeconds: number): string` – inside `area["ISO3166-1"="<cc>"][admin_level=2]`: `place=island|archipelago` (ways/relations), `natural=bay` and `place=sea` relations/ways with a name (gulfs), `place=city|town` nodes; `out geom` (nodes `out`).
- `importCoarseFeatures(db, country: string, deps): Promise<{ islands: number; archipelagos: number; gulfs: number; towns: number }>` – filters islands below `islandMinAreaKm2` (islets stay for the fine gazetteer), gulfs below `gulfMinAreaKm2` and towns farther than `coastDistanceKm` from the land polygons' boundary; upserts by `osm_id` with the existing store (`origin 'osm'`, names from OSM tags incl. `name:<lang>`, public id per type); then `assignSubdivisions`, `assignSeas` and `assignParents` over the country's bbox. Idempotent. Gulfs are type `gulf`, archipelagos `archipelago`, islands `island`, towns the existing settlement type the fine gazetteer uses for `place=town` (look it up in `osm-classify.ts`).

- [ ] **Step 1: Record fixture** for MT.
- [ ] **Step 2: Failing tests:** query text for MT contains `place~"^(island|archipelago)$"` and `natural=bay`; replay imports Malta, Gozo, Comino (island ≥ 1 km² filter keeps Comino at 3.5 km²) and Valletta as town; second import changes nothing; imported island gets `subdivision_id` of the Malta subdivision (insert MT country + subdivision via the 14a test helpers).
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** → PASS; typecheck, lint.
- [ ] **Step 6: Commit** `feat(gazetteer): coarse gazetteer imports islands, archipelagos, gulfs and towns per country (spec 14)`.

### Task 4: Domain – resolve, merge, polygon, lanes

**Files:**
- Create: `lib/domain/areas/resolve.ts`, `lib/domain/areas/merge.ts`, `lib/domain/areas/polygon.ts`, `lib/domain/areas/lanes.ts`, `lib/domain/areas/store.ts`, `lib/domain/areas/system-decision.ts`
- Test: `lib/domain/areas/__tests__/{resolve,merge,polygon,lanes,store}.test.ts`; fixture `test/fixtures/areas/scene.ts` (subdivision + two neighbours' tiles, land polygon of a peninsula, islands, a gulf, a cape, outside the pilot box)

**Interfaces:**
- `resolveMemberNames(db, names: string[], subdivisionId: string, cfg: AppConfig): Promise<{ resolved: Map<string, string>; unresolved: string[] }>` – candidate objects = `candidateObjects(db, withNeighbours(subdivisionTileIds(db, subdivisionId), cfg.areas.extract.neighbourRing))` ∪ valid objects with `subdivision_id = subdivisionId` and types `island|archipelago|gulf|coast_section|cape|settlement types`; matching via `nameForms` → `findNameHits` → `resolveHits` (inside a transaction with `setTrigramThreshold`); only `sure` matches resolve, `ambiguous` counts as unresolved.
- `type AreaFinding = { names: Array<{ name: string; language: string }>; memberIds: string[]; boundaryIds: string[]; unresolved: string[]; evidence: EvidenceDraft }`, `EvidenceDraft = { documentVersionId; chunkId; quote; quoteStart; quoteEnd; boundary; domain; runId; model; promptVersion }`.
- `findMergeTarget(db, finding: AreaFinding, cfg): Promise<string | null>` – among valid, unmerged, not `rejected` areas: one name with `similarity(name_normalized, normalizeName(n)) >= merge.nameSimilarity` **and** member overlap ≥ `merge.memberOverlap` (if either side has no members, the name alone must match exactly after normalization); highest overlap, then name similarity, then id.
- `recordFinding(db, finding, subdivisionId, cfg): Promise<{ areaId: string; created: boolean }>` – merge target or new area (`type 'area'`, `origin 'text'`, `area_status 'candidate'`, `area_polygon_origin 'computed'`, `ar_` public id via the gazetteer store); `addNames(origin 'text')` with the first name per language preferred; evidence insert (`on conflict do nothing`); members: `recomputeMembers(db, areaId)` = union of all evidence `resolved_member_ids` (role `member`) and `boundary_member_ids` (role `boundary`), plus existing `origin 'review'` members, minus ids in the area's `tags.removedMembers: string[]` (review removals) → rewrite `area_members`.
- `computeAreaPolygon(db, areaId, cfg): Promise<{ origin: AreaPolygonOrigin; changed: boolean }>` – skip when `area_polygon_origin = 'manual'`; if a `gulf` member has a polygon covering ≥ `polygon.gulfCoverShare` of the other members (`ST_Covers` count) → its geometry, origin `gulf`; else `ST_ConcaveHull(ST_Collect(member geoms), concaveRatio)` buffered by `bufferNm × 1852 m` (geography), minus `ST_Buffer(land ∩ hull bbox, -inlandCutM)` (geography buffer of the land union), `ST_Multi(ST_MakeValid(...))`; one member or collinear members → buffer of the collection. Then `assignTiles` for tiles intersecting the old ∪ new polygon (rewrites `tile_geo_objects` of the area). Writes `geom` only when changed (history).
- `decideLane(stats: { sources: number; members: number; duplicate: { areaId: string } | null }, cfg): "auto" | "review" | "deferred"` (pure). `areaStats(db, areaId, cfg)` counts distinct evidence `domain`, members with role `member`, and finds a duplicate: another valid area (not rejected, not merged) with `ST_Area(ST_Intersection)/least(ST_Area a, ST_Area b) > duplicateOverlap` (geography) and a name with similarity ≥ `duplicateNameSimilarity`.
- `applyLane(db, areaId, cfg): Promise<{ lane; status: AreaStatus }>` – no-op for `approval_kind 'manual'` or `rejected`; `auto` → `approved/auto`; `review` → `approved/auto` + `createReviewTask(kind 'area_candidate', subjectType 'area', subjectId areaId, context { duplicateOf, suggestion: 'merge' })`; `deferred` → `deferred` (approval_kind null). Each status change is recorded with `recordSystemDecision`.
- `recordSystemDecision(db, { kind: ReviewKind; subjectType: string; subjectId: string; context: object; decision: object }): Promise<string>` – inserts a `review_tasks` row with status `decided` and a `review_decisions` row with `decided_by = 'system'`; returns the decision id. (There is no task-less decision: `review_decisions.task_id` is NOT NULL.)

- [ ] **Step 1: Failing tests:**
  - resolve: exact and transliterated Greek name resolve; an ambiguous name stays unresolved; a name of an object two tile rings away is not resolved.
  - merge: `Saronischer Golf` (de) then `Saronic Gulf` (en) with the same members → one area, both names, two evidence rows (Review Focus 1); same name with disjoint members → two areas; a merged area (`merged_into_id`) is never a target.
  - polygon: members on both sides of the peninsula → polygon intersects no land farther than 1 km from the coast (`ST_Intersects(geom, ST_Buffer(land, -1000))` is false) (Review Focus 4); single member → valid polygon; gulf member covering the others → gulf geometry, origin `gulf`; manual polygon unchanged; `tile_geo_objects` rows of the area follow the new polygon.
  - lanes: pure table for the three lanes (2 sources/2 members → auto; 1 source → deferred; 2/2 + 70 % overlap similar name → review); `applyLane` on a `manual` and on a `rejected` area changes nothing (Review Focus 2); deferred area with a second domain's evidence → `approved/auto`; each change writes one `review_decisions` row with `decided_by 'system'` and no open task (except the review lane).
- [ ] **Step 2: Run** `npx vitest run lib/domain/areas` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(areas): resolve members, merge findings, compute polygons and lanes with system decisions (spec 14)`.

### Task 5: Pipeline – Revier finding stages and `area_probe` run

**Files:**
- Create: `lib/pipeline/areas/{discover,fetch,extract,resolve,run}.ts`, `lib/jobs/handlers/areas.ts`
- Modify: `lib/domain/discovery/queries.ts` (`subdivisionAreaQueries`), `lib/domain/discovery/proposals.ts` (extract `proposeDomain(db, domain, urls, deps, ctx, cfg)` from `proposeSources` and reuse it), `lib/pipeline/fetch/url.ts` (`FetchUrlJob.probe?: boolean`: allowed for `proposed` sources, no `followLinks`, no frontier), `lib/pipeline/text/versions.ts` (`pendingVersions`, `scopedVersions`: only documents whose source is `approved` or uploads), `lib/jobs/{stages,queues,registry,batch-handlers}.ts`, `config/queues.json`, `lib/pipeline/subdivision-build.ts` (`AREA_PROBE_STAGES` before `SUBDIVISION_DISCOVERY_STAGES`), `app/(admin)/runs/{actions.ts,page.tsx}` („Reviere finden“ per Landesteil), `app/(admin)/_components/labels.ts` (run kind `area_probe` „Revier-Findung“, stage labels)
- Test: `lib/pipeline/__tests__/area-probe.test.ts`, `lib/pipeline/__tests__/fetch-url.test.ts` (extend), `lib/pipeline/__tests__/text-versions.test.ts` (extend or create), `lib/pipeline/__tests__/subdivision-build.test.ts` (stage list), `app/(admin)/__tests__/actions.test.ts`

**Interfaces:**
- `AREA_PROBE_STAGES = ["areas.discover", "areas.fetch", "areas.extract", "areas.resolve"] as const`.
- `startAreaProbeRun(db, boss, subdivisionKey, triggeredBy): Promise<{ id: string }>` – kind `area_probe`, scope `{ type: "subdivision", id: key }`, params `{ subdivisionKey }`; refuses excluded subdivisions (`requireSubdivision`).
- `areas.discover` (one job): `subdivisionAreaQueries(db, subdivisionKey, cfg)` = names of the subdivision's geo object and of its country (preferred per language) × `templates.subdivisionArea` filtered to the subdivision's source languages, level `subdivision`, `scopeId` = subdivision id, priority 0; capped by `budgets.areaProbe.maxSerpQueries`; executed with `runQueries` (reuse within `serp.reuseDays` included).
- `areas.fetch` (queue `fetch.url`, handler `fetchUrlHandler`): plan = distinct normalized hit URLs of this run's subdivision-level SERP queries (and reused queries of the same keywords) in rank order, capped by `budgets.areaProbe.maxDocuments`, skipping URLs whose document already has a current version; per URL: source by domain → `approved`: normal fetch with `probe: true`; `proposed`: fetch with `probe: true`; none: `proposeDomain` (creates the `proposed` source and its `source_approval` task) then fetch; `rejected`/paused: no job. Domains in `proposals.ignoreDomains` are skipped.
- `areas.extract` (batch, task `area-extract`): versions = documents fetched in this run ∪ current versions of active documents with `classified_doc_type ?? doc_type` in `areas.extract.docTypes` that have a mention of an object in the subdivision's scope tiles; one request per version with its first `maxChunksPerVersion` chunks up to `maxCharsPerVersion`; skip versions that already have an `area_evidence` row from the same prompt version (`model`, `prompt_version` on evidence). Batch result handler: for each item `locateQuote(chunk.text, quote, extraction.quote)`; failures are dropped and counted in the job result (`dropped_quotes`); kept items stored as pending findings in the job's batch remainder (or a run-scoped jsonb in `run_stages.result`), not as areas yet. Budget: stop submitting when the estimated cost of the run exceeds `budgets.areaProbe.maxModelEur`.
- `areas.resolve` (one job): for each kept item `resolveMemberNames` → `recordFinding` → `computeAreaPolygon` → `applyLane`; then re-evaluate every `deferred` area with a tile in the subdivision's scope: re-resolve its evidence's `unresolved_members` (new gazetteer objects), recompute members, polygon and lane. Result `{ findings, created, merged, approved, review, deferred, droppedQuotes }`.
- `SUBDIVISION_BUILD_STAGES` = gazetteer, datasets, seed, geometry, **`AREA_PROBE_STAGES`**, discovery (area, tile, propose) – the discovery area level then takes all areas active at that moment (spec Landesteil-Lauf step 6).

- [ ] **Step 1: Failing tests** (fixtures: SERP and page fixtures under `test/fixtures/http/` written by hand in the existing fixture format, MockModel answering `area-extract`):
  - `area probe run finds, merges and approves`: two pages from two domains naming the same Revier with two resolvable members → one `approved/auto` area with two evidence rows and a polygon; a third page with an invented quote → no evidence, `droppedQuotes = 1`.
  - `probe fetch on unknown, proposed and rejected domains` (Review Focus 3): unknown → source `proposed` + one open `source_approval` task; proposed → fetched, still one task; rejected → no job; none of the three documents is returned by `textRunVersions` with `pending: true`; after approving the source it is.
  - `probe fetch does not follow links`.
  - `deferred area is approved on a later run with a second source` (Review Focus 2).
  - `subdivision build has the probe stages before discovery.area`.
  - `runs action starts an area probe for a subdivision and rejects an excluded one`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; register stages, queues (`config/queues.json` entries for new queues `areas.discover`, `areas.extract`, `areas.resolve`), handlers and the batch handler for `area-extract`.
- [ ] **Step 4: Run** the listed tests plus `npx vitest run lib/pipeline/__tests__/text-run.test.ts lib/pipeline/__tests__/discovery.test.ts` → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(areas): Revier finding per subdivision (search, probe fetch, extraction, resolve) in builds and area_probe runs (spec 14)`.

### Task 6: Discovery, mentions and delivery read approved areas by id

**Files:**
- Modify: `lib/domain/discovery/queries.ts` (`areaQueries`), `lib/pipeline/text/versions.ts` (`scopeSources`), `lib/domain/mentions/scope.ts` (`sourceTiles`), `lib/domain/delivery/load.ts` (`loadAreas`), `lib/domain/subdivisions/view.ts` + `app/(admin)/subdivisions/[key]/page.tsx` (area status), `lib/domain/map-data.ts` (areas layer properties, see Task 9 for UI)
- Test: `lib/domain/__tests__/discovery-queries.test.ts`, `lib/domain/mentions/__tests__/scope.test.ts`, `lib/pipeline/__tests__/text-versions.test.ts`, `lib/domain/delivery/__tests__/load.test.ts` (or the existing delivery load test), `lib/domain/subdivisions/__tests__/view.test.ts`

**Interfaces:**
- `areaQueries(db, subdivisionKey, cfg)`: only areas with `area_status = 'approved'`, not merged; `scopeId` = area **id** (no longer `config_key`; areas without key are searched too); still once per `serp.reuseDays` by keyword reuse.
- SQL helper `areaOfSerpScope(scopeIdSql)` in `lib/domain/areas/store.ts`: maps a `serp_queries.scope_id` of level `area` to the current area id: `a.id::text = scope_id` or (legacy) `a.config_key = scope_id`, following `merged_into_id` to the surviving area. Used by `scopeSources` and `sourceTiles` (Review Focus 5).
- Mentions: rejected areas do not count in the prepass (`prepassTiles` excludes `area_status = 'rejected'`); approved, candidate and deferred areas still widen candidates (spec: Reviere erweitern die Kandidaten nur).
- Delivery `manifest.areas`: only `approved` areas (contract unchanged).
- `subdivisionDetail(...).areas[]` gains `status: AreaStatus` and `approvalKind`; page shows „freigegeben (automatisch|manuell)“, „Kandidat“, „zurückgestellt“, „verworfen“.

- [ ] **Step 1: Failing tests:** `deferred and rejected areas are not searched`, `area query scope_id is the area id`, `SERP of a merged area maps to the surviving area's tiles`, `legacy config_key scope still maps`, `rejected area is not a prepass object`, `manifest lists only approved areas`, `detail shows area status`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `refactor(discovery,mentions,delivery): only approved areas are searched and delivered; area SERP keyed by id (spec 14)`.

### Task 7: Mentions re-read when a subdivision starts

**Files:**
- Create: `lib/pipeline/text/reread.ts`
- Modify: `lib/domain/mentions/scope.ts` (export `prepassTiles(db, versionId, cfg, opts)` if not exported), `lib/pipeline/text/run.ts` (`startRereadRun`), `lib/jobs/{stages,queues,registry}.ts`, `config/queues.json`, `lib/pipeline/subdivision-build.ts` (stage `mentions.reread` right after `GAZETTEER_STAGES`)
- Test: `lib/pipeline/__tests__/mentions-reread.test.ts`

**Interfaces:**
- Stage `mentions.reread` (one job, scope subdivision): `rereadVersions(db, subdivisionKey, cfg): Promise<string[]>` = current versions of active documents of approved sources whose prepass tiles (`prepassTiles`, i.e. large objects named in the text: areas, gulfs, islands, archipelagos, admin regions, seas) intersect the subdivision's scope tiles; then `startRereadRun(db, boss, { subdivisionKey, documentVersionIds, triggeredBy: 'system' })` = kind `reprocess`, scope subdivision, stages 6–8 (`TEXT_RUN_STAGES`), params `{ subdivisionKey, documentVersionIds, rematch: true }`. The stage finishes after starting the run (the build does not wait: „parallel zu 4 ff.“). No versions → no run.
- Mentions stay idempotent (unique `(chunk_id, geo_object_id, char_start)`), so versions matched before only gain the new objects' mentions.

- [ ] **Step 1: Failing test:** document from source found in subdivision A (`Saronic Gulf` trip report) names a bay that only exists after subdivision B's fine gazetteer; after B's gazetteer the `mentions.reread` stage starts a reprocess run whose `mentions.batch` creates the mention of that bay; a second build of B creates no duplicate mention; a document of an unapproved source is not selected.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS plus `npx vitest run lib/pipeline/__tests__/subdivision-build.test.ts`; typecheck, lint.
- [ ] **Step 5: Commit** `feat(mentions): re-read prepass-touching documents when a subdivision is built (spec 14)`.

### Task 8: Area edit operations and review kind `area_candidate`

**Files:**
- Create: `lib/domain/areas/edit.ts`, `lib/domain/areas/view.ts`
- Modify: `lib/domain/gazetteer/names.ts` (`endName(db, nameId)`, `setPreferredName(db, geoObjectId, language, nameId)`), `lib/domain/review-decisions.ts` (schema + `ALLOWED["area_candidate/area"]` + dispatch), `lib/domain/review-view.ts` (subject type `area`), `app/(admin)/review/kinds.ts`, `app/(admin)/_components/labels.ts`, `app/(admin)/review/[id]/` (area decision form: Zusammenführen, Getrennt lassen, Verwerfen)
- Test: `lib/domain/areas/__tests__/edit.test.ts`, `lib/domain/__tests__/review-area.test.ts`

**Interfaces:**
- All edit operations take `(db, input, actor: string)`, run in one transaction, record a decided `area_candidate` task + `review_decisions` with `decided_by = actor` (via `recordSystemDecision` generalised to `recordDecision(db, { …, decidedBy })`), and set `approval_kind = 'manual'` where they decide status:
  - `confirmArea(db, { areaId }, actor)` – `approved/auto` → `approved/manual`; `candidate|deferred` → `approved/manual`.
  - `mergeAreas(db, { sourceId, targetId }, actor)` – moves names (`addNames` origin `review`, end the source's), evidence (`update area_evidence set area_id`), review members; ends the source with `valid_to = today`, `merged_into_id = targetId`; dismisses open tasks of the source (`dismissTasks`); recomputes target members, polygon (unless manual), keeps target status. Refuses merging into itself or into a merged/rejected area (`AreaEditNotAllowed`).
  - `addAreaName(db, { areaId, name, language }, actor)`, `removeAreaName(db, { areaId, nameId }, actor)` (refuses removing the last name), `setPreferredAreaName(db, { areaId, nameId }, actor)`.
  - `setAreaMembers(db, { areaId, add: string[]; remove: string[] }, actor)` – adds `origin 'review'` members, records removals in `tags.removedMembers`, recomputes polygon (unless manual).
  - `setAreaPolygon(db, { areaId, polygon: GeoJSON Polygon|MultiPolygon }, actor)` – validates (`ST_IsValid`, ≤ 5° extent), sets `area_polygon_origin 'manual'`, rewrites `tile_geo_objects`; `resetAreaPolygon` returns to `computed` and recomputes.
  - `rejectArea(db, { areaId }, actor)` – `rejected`, approval_kind null; documents and facts untouched.
- `areaDetail(db, areaId): Promise<{ id; publicId; status; approvalKind; polygonOrigin; names: Array<{ id; name; language; origin; isPreferred }>; members: Array<{ id; name; type; role; origin }>; evidence: Array<{ quote; boundary; url; domain; title; documentVersionId; createdAt }>; subdivisions: string[]; openTaskId: string | null; mergedIntoId: string | null }>`.
- Review decisions for `area_candidate/area`: `{ action: "merge_area", targetId }`, `{ action: "keep_separate" }` (sets `approval_kind manual`), `{ action: "reject_area" }`.

- [ ] **Step 1: Failing tests:** each operation's effect and its decision row; `merge moves evidence and dismisses the source's open task` (Review Focus 5); `merge into a merged area is refused`; `removing the last name is refused`; `manual polygon survives a later computeAreaPolygon and applyLane`; review `keep_separate` marks manual; `area_candidate is listed in open review tasks with its label`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS plus `npx vitest run lib/domain/__tests__/review*.test.ts`; typecheck, lint.
- [ ] **Step 5: Commit** `feat(areas): edit operations (confirm, merge, names, members, polygon, reject) and review kind area_candidate (spec 14)`.

### Task 9: Map layer „Reviere“ with detail panel and editing

**Files:**
- Modify: `lib/domain/map-data.ts` (areas layer properties), `lib/domain/map-limits.ts` if needed, `app/(admin)/_components/map-view.tsx` (fill + line layers, filters, sidebar), `app/(admin)/map/page.tsx`
- Create: `app/(admin)/map/actions.ts` (server actions wrapping Task 8 operations plus `areaDetailAction`), `app/(admin)/map/area-panel.tsx` (client), `app/(admin)/map/polygon-draw.ts` (click-to-add-vertex tool on MapLibre, no new dependency), `e2e/areas.spec.ts`; seed an area in `e2e/global-setup.ts`
- Test: `app/(admin)/__tests__/map-actions.test.ts`, `lib/domain/__tests__/map-data.test.ts` (extend), Playwright `e2e/areas.spec.ts`

**Interfaces:**
- Areas layer feature properties: `id`, `name`, `status`, `approvalKind`, `lane` (`auto` = approved/auto, `manual` = approved/manual, `candidate`, `deferred`, `rejected`), `subdivisionKeys` (comma-joined keys of subdivisions whose scope tiles the area touches). Request accepts `areaStatuses` and `subdivision` filters (zod in `mapDataRequest`); default shows all but `rejected`.
- Map: fill layer `areas-fill` (opacity 0.12, colour by lane: auto `#a78bfa`, manual `#7c3aed`, candidate `#f59e0b`, deferred `#9ca3af`, rejected `#ef4444`), line layer `areas-line` in the same colours; layer panel filter chips „Status“ and a Landesteil select; click on an area opens `AreaPanel`.
- `AreaPanel`: loads `areaDetailAction(id)`; shows names per language (preferred marked), members, evidence (quote, Quelle as link, Abgrenzung), status; buttons „Entscheidung übernehmen“, „Zusammenführen mit …“ (select among areas in view), „Namen bearbeiten“ (add, remove, Bevorzugt), „Abgrenzung ändern“ (mode: click geo objects in the map to toggle members, then „Polygon neu rechnen“), „Polygon zeichnen“ (vertex clicks, double click closes, „Speichern“/„Abbrechen“; „Berechnetes Polygon wiederherstellen“ when manual), „Verwerfen“. Every action returns `{ ok: true; message } | { ok: false; error }` (German), calls `revalidatePath("/map")`, and the panel reloads the layer.
- Actions validate with zod, call `requireAdmin()`, pass `admin.email` as actor, map `AreaEditNotAllowed` to its German message.

- [ ] **Step 1: Failing tests:** map-data `areas layer carries lane and subdivision keys and filters by status`; actions `confirm, merge, add name, set members, draw polygon, reject` each call through to the domain and return `ok`; refused merge returns the German error.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; read `node_modules/next/dist/docs/` on server actions first. **Step 4: Run** → PASS; Playwright `e2e/areas.spec.ts`: open `/map`, filter „Kandidat“, click the seeded area, see its quote, press „Entscheidung übernehmen“, see „freigegeben (manuell)“. `npm run build`, lint.
- [ ] **Step 5: Commit** `feat(admin): Reviere map layer with lanes, filters, detail and editing (spec 14)`.

### Task 10: Settings, runbook, design docs, full check

**Files:**
- Modify: `app/(admin)/settings/page.tsx` (panel „Reviere“ from `config/areas.json`: lane thresholds, merge, polygon, extract; plus `budgets.areaProbe`), `docs/runbook.md` (section „Reviere“: what the finding does, where to correct, how to start „Reviere finden“; „Umstellung auf Landesteile“ gets step 10: run „Reviere finden“ for `GR-I` and `GR-J` and check the result in the map against local knowledge; note that `tiles.area_id` and `comparison_set.area_id` are legacy and are dropped only after the server migration ran), `docs/superpowers/specs/2026-10-18-periplus-design.md` (glossary „Revier“: candidate/approved lanes; section 11 row for spec 14: complete; tables list `area_members`, `area_evidence`), `docs/superpowers/specs/2026-10-20-periplus-14-raumgliederung-design.md` (header: „Umgesetzt mit Plan 14a und 14b“; section „Was dem Builder überlassen ist“: decisions taken: `ST_ConcaveHull` ratio 0.3, status as columns with history, probe documents wait for source approval before text runs, system decisions as decided tasks)
- Test: `app/(admin)/__tests__/settings.test.tsx` if one exists, else covered by build

- [ ] **Step 1:** Settings panel and docs as listed.
- [ ] **Step 2:** Full suite `npx vitest run`, `npm run typecheck`, `npm run lint`, `npm run build`, Playwright `npx playwright test` → all green. Fix what breaks.
- [ ] **Step 3: Commit** `docs: Reviere in settings, runbook and design; spec 14 complete (spec 14)`.
