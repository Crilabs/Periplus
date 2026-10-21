# Periplus 14b – Reviere aus dem Revier-Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the Reviere delivered by the external Revier bot (`config/area-imports/GR.json`, 36 areas) as `area` geo objects with names, evidence, resolved members and computed polygons, use them in discovery, mentions, delivery and the map; plus the coarse gazetteer's islands, gulfs, archipelagos and towns and the mention re-read when a Landesteil starts. Completes spec 14.

**Architecture:** A pure parser validates bot files; `lib/domain/areas/*` resolves member names against the gazetteer, computes polygons (concave hull, buffered, land cut) and upserts areas idempotently by `config_key`. The import is run from the IDE (`npm run areas:import`) and as stage `areas.import` inside every subdivision build (after geometry, before discovery); there is no UI for it. Discovery, mentions and delivery key area SERP queries by the area id (legacy keys via aliases). The map shows the Revier layer read-only with a detail panel.

**Tech Stack:** Next.js 16 (App Router, server actions), TypeScript, Drizzle ORM + SQL migrations, Postgres/PostGIS, pg-boss, zod, MapLibre GL, vitest against the worktree test DB, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-periplus-14-raumgliederung-design.md` – section „Änderung 21.10.2026: Reviere kommen aus dem Revier-Bot“ (binding; it replaces the own finding, lanes, editing and `area_candidate`), plus „Reviere › Datenmodell“ (`area_members`, `area_evidence`), „Finden“ step 6 (polygon), „Gazetteer in zwei Stufen“ (coarse row), „Quellenfindung“, „Erwähnungen“, „Landesteil-Lauf“ step 3, „Folgen“ (`manifest.areas`), „Admin-UI“ `/map` and `/settings`, „Umstellung“ step 4. Plan 14a is merged.

## Global Constraints

- Code, identifiers, tables, API: English. UI copy: German. „Revier“ in UI, `area` in code, public id prefix `ar_`.
- Domain logic only in `lib/domain` and `lib/pipeline`; pages, API routes and job handlers stay thin.
- Thresholds, buffers, aliases, type mappings: `config/areas.json`, not code. Bot files live in `config/area-imports/<CC>.json` (shipped with the `config` directory in both Docker images). External services only via adapters; tests never call the network.
- Tests run against real Postgres (worktree DB `periplus_rv_test`, set in the skip-worktree `vitest.config.mts`; never commit that file), each in `withRollback`; committed geo rows must lie outside 23.0–23.75 E × 37.0–38.0 N.
- `area_evidence` is append-only (`forbid_mutation`, `_no_truncate`); `area_members` is working state (replaced per import); `geo_objects`/`geo_names` keep their stable-table rules (end via `valid_to`, never DELETE).
- The bot is the source of truth for which Reviere exist and what they contain; Periplus never edits an imported area's names, members or evidence by hand. An area missing from the file ends (`valid_to`), it is not deleted.
- Kein Revier ohne Zitat: an imported area has ≥ 1 evidence row with a non-empty quote and URL; a file area without evidence is rejected by the parser.
- The model never produces coordinates; polygons come only from resolved member geometries or a gulf member.
- Import is idempotent: a second import of the same file changes no row (no history rows, no new names, no new evidence).
- Before touching routes, `proxy.ts` or `next.config.ts`: read the Next 16 docs in `node_modules/next/dist/docs/`.
- Work happens in worktree branch `feat/reviere` (`.claude/worktrees/reviere`); never commit to `main`, never push.
- Per task finish: `npx vitest run <touched test files>`, then `npm run typecheck` and `npm run lint` before the commit. Migrations via `npm run db:generate` (schema) or `npx drizzle-kit generate --custom --name <name>` (triggers, data); next free number 0058.

## Review Focus

1. A member name that exists twice in the scope (two „Agios Nikolaos“ harbours, one on Crete, one in the Peloponnese) or matches only with the wrong type stays unresolved instead of pulling the polygon across the sea. Test in Task 3.
2. File lists the retired subdivision key `GR-L` (now `GR-CYC`, `GR-DOD`) or an unknown key: `GR-L` expands to its split groups; an unknown key is reported, the area still imports from its other keys. Test in Task 3.
3. Re-import after the bot changed a file (name added, member removed, evidence added, area dropped, area renamed key): only those differences are written; the dropped area ends, its tile links are removed, its old SERP history stays readable. Test in Task 3.
4. Hull of members on both sides of a peninsula: the polygon never contains land more than `inlandCutM` inland; one resolvable member below `minMembers` → no area yet („wartet auf Gazetteer“), never an SQL error on collinear or single points. Test in Task 3.
5. The pilot area `saronic` becomes `saronic-gulf` without a new geo object: same id, `ar_` id and area facts; SERP queries stored with scope `saronic` still map to its tiles. Tests in Tasks 3 and 5.

---

### Task 1: Schema, config and bot file parser

**Files:**
- Modify: `lib/db/schema/geo.ts` (tables `area_members`, `area_evidence`; enum `name_origin` + `import`; enum `geo_origin` + `import`), `lib/config/schemas.ts` (`areasConfigSchema`, `areaImportFileSchema`), `lib/config/index.ts` (`AppConfig.areas`), `app/(admin)/_components/labels.ts` (`NAME_ORIGIN_LABELS.import = "Revier-Bot"` and any other Record over the changed enums)
- Create: `config/areas.json`, `lib/domain/areas/file.ts`, `drizzle/0058_areas_schema.sql` (generated), `drizzle/0059_areas_triggers.sql` (`--custom`)
- Already present (commit it in this task): `config/area-imports/GR.json`
- Test: `lib/db/__tests__/areas-schema.test.ts`, `lib/domain/areas/__tests__/file.test.ts`, `lib/config/__tests__/config.test.ts`

**Interfaces:**
- `area_members`: `area_id uuid → geo_objects not null`, `geo_object_id uuid → geo_objects not null`, `role area_member_role ('member'|'boundary') not null`, `name text not null` (the file's name it was resolved from), `created_at`; PK `(area_id, geo_object_id, role)`; index `geo_object_id`. DELETE allowed.
- `area_evidence`: `id uuid pk (newId)`, `area_id → geo_objects not null`, `url text not null`, `publisher text not null default ''`, `language text not null`, `quote text not null check (length(quote) > 0)`, `file_generated_at date not null`, `created_at`; unique `(area_id, url, quote)`; index `area_id`. Append-only (`forbid_mutation('area_id')`, only `area_id` may change) + `area_evidence_no_truncate`.
- `config/areas.json` → `AreasConfig`:
  - `minMembers: 2`
  - `polygon: { bufferNm: 3, concaveRatio: 0.3, inlandCutM: 1000, gulfCoverShare: 0.9 }`
  - `neighbourRing: 1`
  - `memberTypes`: bot type → geo object types it may resolve to: `harbour` → `["harbour","marina","settlement","town"…]`, `island`/`islet` → `["island","islet"]`, `settlement` → settlement types, `bay` → `["bay","anchorage","cove"…]`, `gulf` → `["gulf","bay"]`, `cape` → `["cape"]`, `strait`/`channel` → `["strait","channel"]`, `archipelago` → `["archipelago"]`. Use exactly the `geo_object_type` enum values that exist (read the enum; leave out types that do not exist).
  - `aliases: { "saronic": "saronic-gulf", "argolic": "argolic-gulf" }` (legacy key → bot key)
- `parseAreaFile(json: unknown, source: string): AreaFile` in `lib/domain/areas/file.ts` with `AreaFile = { country: string; generatedAt: string; areas: ImportedArea[] }`, `ImportedArea = { key; names: Array<{ lang; name; preferred: boolean }>; subdivisions: string[]; members: Array<{ name; type }>; boundaryPoints: Array<{ name; type }>; boundary: string; related: Array<{ key; relation: "contains"|"within"|"overlaps" }>; evidence: Array<{ url; publisher; lang; quote }>; notes: string }`. Errors start with `Ungültige Revier-Datei <source>:`; rejects duplicate keys, an area without names or without evidence, and `related` pointing to a key not in the file.
- `loadAreaFiles(dir = "config/area-imports"): Promise<AreaFile[]>` – all `*.json`, sorted by file name.

- [ ] **Step 1: Failing tests:** schema – `area_evidence rejects UPDATE of quote and DELETE`, `area_evidence allows moving area_id`, `area_members delete allowed`, `name origin import accepted`; parser – `parses config/area-imports/GR.json with 36 areas, crete has 5 names and 3 boundary points`, `rejects duplicate key`, `rejects an area without evidence`, `rejects related to unknown key`; config – `loads areas.json with aliases saronic → saronic-gulf`.
- [ ] **Step 2: Run** `npx vitest run lib/db/__tests__/areas-schema.test.ts lib/domain/areas/__tests__/file.test.ts lib/config/__tests__/config.test.ts` → FAIL.
- [ ] **Step 3: Implement** schema, migrations (enum `ADD VALUE` in 0058; triggers in 0059), config, parser.
- [ ] **Step 4: Run** → PASS; `npx vitest run lib/db/__tests__` (no regressions); typecheck, lint.
- [ ] **Step 5: Commit** `feat(areas): area members and evidence tables, areas.json, bot file parser with the Greek delivery (spec 14)`.

### Task 2: Coarse gazetteer – islands, archipelagos, gulfs, towns

**Files:**
- Modify: `lib/adapters/overpass.ts` (`buildCoarseFeatureQuery`), `lib/pipeline/gazetteer/coarse.ts` (`importCoarseFeatures`, called by the `gazetteer.coarse` country job after boundaries), `lib/domain/gazetteer/osm-classify.ts` (only if a mapping is missing), `config/gazetteer.json` + schema (`coarse: { placeTypes: ["city","town"], islandMinAreaKm2: 1, gulfMinAreaKm2: 20, coastDistanceKm: 5 }`), `scripts/fixtures-record.ts` (`--coarse` also records the feature query)
- Create fixtures: `test/fixtures/http/overpass/*` for MT (record with `npx tsx scripts/fixtures-record.ts --coarse MT` against a `*_scratch` database; network is allowed only for this recording)
- Test: `lib/adapters/__tests__/overpass-coarse.test.ts`, `lib/pipeline/__tests__/gazetteer-coarse.test.ts` (extend or create)

**Interfaces:**
- `buildCoarseFeatureQuery(country: string, cfg: GazetteerConfig["coarse"], timeoutSeconds: number): string` – inside `area["ISO3166-1"="<cc>"][admin_level=2]`: ways/relations `place~"^(island|archipelago)$"`, ways/relations `natural=bay` with `name` (gulfs), nodes `place~"^(city|town)$"`; `out geom`.
- `importCoarseFeatures(db, country: string, deps): Promise<{ islands: number; archipelagos: number; gulfs: number; towns: number }>` – drops islands below `islandMinAreaKm2` (islets stay for the fine gazetteer), bays below `gulfMinAreaKm2`, towns farther than `coastDistanceKm` from the land polygons' boundary; upserts by `osm_id` through the existing gazetteer store and classifier (`origin 'osm'`, names incl. `name:<lang>`); then `assignSubdivisions`, `assignSeas`, `assignParents` over the country bbox. Idempotent; a feature the fine gazetteer already imported (same `osm_id`) is updated, not duplicated.

- [ ] **Step 1: Record fixture** for MT.
- [ ] **Step 2: Failing tests:** query text for MT contains `place~"^(island|archipelago)$"` and `natural=bay`; replay imports Malta, Gozo, Comino and Valletta; a second import changes nothing; the imported island gets the Malta subdivision's id (insert MT country + subdivision with the 14a test helpers).
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** → PASS; typecheck, lint.
- [ ] **Step 6: Commit** `feat(gazetteer): coarse gazetteer imports islands, archipelagos, gulfs and towns per country (spec 14)`.

### Task 3: Domain – resolve members, polygon, import

**Files:**
- Create: `lib/domain/areas/resolve.ts`, `lib/domain/areas/polygon.ts`, `lib/domain/areas/import.ts`, `lib/domain/areas/store.ts`; fixture `test/fixtures/areas/scene.ts` (two subdivisions incl. a split parent, coast tiles, a land polygon of a peninsula, islands, a gulf, two same-named harbours far apart, a cape; outside the pilot box)
- Test: `lib/domain/areas/__tests__/{resolve,polygon,import}.test.ts`

**Interfaces:**
- `scopeSubdivisionIds(db, keys: string[], cfg: AppConfig): Promise<{ ids: string[]; unknown: string[] }>` – a key replaced by `split` (`cfg.subdivisions.split[].parentKey`) expands to its group keys; keys without a valid subdivision go to `unknown`.
- `resolveAreaMembers(db, entries: Array<{ name: string; type: string; role: "member"|"boundary" }>, subdivisionIds: string[], cfg: AppConfig): Promise<{ resolved: Array<{ geoObjectId; name; role }>; unresolved: Array<{ name; type; role }> }>` – candidate objects: valid, unmerged objects with `subdivision_id` in `subdivisionIds` plus `candidateObjects(db, withNeighbours(scope tiles, cfg.areas.neighbourRing))`, filtered to `cfg.areas.memberTypes[type]`; match with `nameForms` → `findNameHits` → `resolveHits` inside one transaction (`setTrigramThreshold`); only a single `sure` hit resolves; several sure hits or `ambiguous` → unresolved (Review Focus 1).
- `computeAreaPolygon(db, memberIds: string[], cfg): Promise<{ geom: string /* EWKT or GeoJSON */; origin: "computed" | "gulf" } | null>` – null when fewer than `minMembers` members have a geometry; gulf rule: a `gulf`/`bay` member whose polygon covers ≥ `gulfCoverShare` of the other members → its geometry; else `ST_ConcaveHull(ST_Collect(geoms), concaveRatio)` buffered by `bufferNm × 1852` m (geography), minus `ST_Buffer(land, -inlandCutM)` (geography, land from `land_polygons` intersecting the hull's bbox), `ST_Multi(ST_CollectionExtract(ST_MakeValid(...), 3))`; single/collinear points still buffer to a polygon.
- `importAreaFile(db, file: AreaFile, cfg, today: string): Promise<AreaImportReport>` with `AreaImportReport = { created: string[]; updated: string[]; unchanged: string[]; ended: string[]; waiting: Array<{ key; resolved: number; unresolved: string[] }>; unknownSubdivisions: Array<{ key; subdivision }> }`. Per area: find the valid area by `config_key = key` or by an alias whose bot key is `key` (then set `config_key = key`, Review Focus 5); resolve; polygon; null polygon and no existing area → `waiting`; null polygon but existing area → keep its geometry, update the rest; create with type `area`, `origin 'import'`, `ar_` public id via the gazetteer store, `config_key = key`; names via `addNames(origin 'import', isPreferred from file)`, names of origin `import` missing from the file end (`valid_to`); evidence `insert … on conflict do nothing` with `file_generated_at`; `area_members` rewritten (resolved only); `tags` = `{ boundary, related, notes, unresolvedMembers, polygonOrigin, importCountry }` (only written when changed); `geom` only written when changed (`ST_Equals` false); after a geometry change `assignTiles` for tiles intersecting old ∪ new polygon. Areas of `file.country` (`tags.importCountry`) not in the file end with `valid_to = today` and lose their `tile_geo_objects` rows. Pilot areas matched by alias get `tags.importCountry` too.
- `importAllAreaFiles(db, cfg, today): Promise<AreaImportReport[]>` – `loadAreaFiles` then `importAreaFile` per file, one transaction per file.

- [ ] **Step 1: Failing tests:**
  - resolve: exact and transliterated Greek name resolve with the right type; same name twice in scope → unresolved (Review Focus 1); right name, wrong type → unresolved; name two tile rings away → unresolved; `GR-L`-style split parent expands, unknown key reported (Review Focus 2).
  - polygon: members on both sides of the peninsula → `ST_Intersects(geom, ST_Buffer(land::geography, -1000)::geometry)` is false (Review Focus 4); two members → valid polygon; collinear three → valid polygon; one member → null; covering gulf → gulf geometry, origin `gulf`.
  - import: scene file with 3 areas → created, names/evidence/members/tags written, tile links present; second import → all `unchanged`, no new history rows (count `geo_objects_history`), no new names/evidence; changed file (added name, removed member, new evidence, dropped area) → exactly those changes, dropped area ended without tile links (Review Focus 3); area with one resolvable member → `waiting`, no geo object; pilot-style area with `config_key 'saronic'` and alias → same id and public id afterwards, `config_key 'saronic-gulf'`, bot names added (Review Focus 5).
- [ ] **Step 2: Run** `npx vitest run lib/domain/areas` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(areas): import bot Reviere with resolved members, computed polygons and idempotent updates (spec 14)`.

### Task 4: Import script and build stage

**Files:**
- Create: `scripts/import-areas.ts`, `lib/pipeline/areas-import.ts`, `lib/jobs/handlers/areas.ts`
- Modify: `lib/jobs/{stages,queues,registry}.ts`, `config/queues.json`, `lib/pipeline/subdivision-build.ts` (`AREA_IMPORT_STAGE` after `GEOMETRY_RUN_STAGES`, before `SUBDIVISION_DISCOVERY_STAGES`), `app/(admin)/_components/labels.ts` (stage label „Reviere importieren“), `package.json` (`"areas:import": "tsx --env-file-if-exists=.env.local scripts/import-areas.ts"`)
- Test: `scripts/__tests__/import-areas.test.ts`, `lib/pipeline/__tests__/areas-import.test.ts`, `lib/pipeline/__tests__/subdivision-build.test.ts`

**Interfaces:**
- The import is started from the IDE, not from the admin UI (Christian, 21.10.2026): `npm run areas:import -- [--file config/area-imports/GR.json] [--dry-run]` imports the given file (default: all files in `config/area-imports/`) against `DATABASE_URL` and prints the report per file (created, updated, unchanged, ended, waiting with unresolved names, unknown subdivisions). `--dry-run` runs inside a rolled-back transaction. On the server: `dc run --rm worker node --import tsx scripts/import-areas.ts`. `parseArgs(argv): { file: string | null; dryRun: boolean }` exported for tests.
- `AREA_IMPORT_STAGE = "areas.import"` inside `SUBDIVISION_BUILD_STAGES` = gazetteer, datasets, seed, geometry, `areas.import`, discovery (area, tile, propose): one job, `importAllAreaFiles(db, getConfig(), today)`, report stored as the stage result. It re-resolves members that wait on this subdivision's gazetteer, so the discovery area level searches them in the same build. No admin button, no own run kind.

- [ ] **Step 1: Failing tests:** `parseArgs` (`--file x --dry-run`, defaults); `script --dry-run leaves no rows and prints the report`; `areas.import stage imports the scene file and stores the report`; `subdivision build has areas.import after geometry and before discovery.area`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(areas): import script for bot files and areas.import stage in subdivision builds (spec 14)`.

### Task 5: Discovery, mentions, delivery and detail page use areas by id

**Files:**
- Modify: `lib/domain/areas/store.ts` (`areaOfSerpScopeSql`), `lib/domain/discovery/queries.ts` (`areaQueries`), `lib/pipeline/text/versions.ts` (`scopeSources`), `lib/domain/mentions/scope.ts` (`sourceTiles`), `lib/domain/delivery/load.ts` (`loadAreas` key = `config_key`), `lib/domain/subdivisions/view.ts` + `app/(admin)/subdivisions/[key]/page.tsx`
- Test: `lib/domain/__tests__/discovery-queries.test.ts`, `lib/domain/mentions/__tests__/scope.test.ts`, the text-versions test, the delivery load test, `lib/domain/subdivisions/__tests__/view.test.ts`

**Interfaces:**
- `areaQueries(db, subdivisionKey, cfg)`: `scopeId` = area **id**; all valid, unmerged areas whose `tile_geo_objects` touch the subdivision's scope tiles (keys no longer required); languages and templates unchanged; a keyword searched within `serp.reuseDays` is reused (existing).
- `areaOfSerpScopeSql(scopeIdSql)`: a level-`area` `serp_queries.scope_id` maps to the valid area with `id::text = scope_id`, or `config_key = scope_id`, or `config_key = cfg.areas.aliases[scope_id]` (pass aliases as a jsonb parameter). Used by `scopeSources` and `sourceTiles` (Review Focus 5).
- `subdivisionDetail(...).areas[]` gains `key`, `members` (count), `waiting` is not shown (not a geo object); page column „Schlüssel“ and „Mitglieder“.

- [ ] **Step 1: Failing tests:** `area query scope_id is the area id`, `area without config key is searched`, `SERP stored under legacy key saronic maps to saronic-gulf tiles` (Review Focus 5), `SERP stored under the area id maps to its tiles`, `ended area is neither searched nor delivered`, `manifest.areas uses the bot key`, `detail lists area key and member count`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `refactor(discovery,mentions,delivery): areas keyed by id with legacy aliases (spec 14)`.

### Task 6: Mentions re-read when a subdivision starts

**Files:**
- Create: `lib/pipeline/text/reread.ts`
- Modify: `lib/domain/mentions/scope.ts` (export the prepass tile function if not exported), `lib/pipeline/text/run.ts` (`startRereadRun`), `lib/jobs/{stages,queues,registry}.ts`, `config/queues.json`, `lib/pipeline/subdivision-build.ts` (stage `mentions.reread` right after `GAZETTEER_STAGES`), labels
- Test: `lib/pipeline/__tests__/mentions-reread.test.ts`, `lib/pipeline/__tests__/subdivision-build.test.ts`

**Interfaces:**
- Stage `mentions.reread` (one job, scope subdivision): `rereadVersions(db, subdivisionKey, cfg): Promise<string[]>` = current versions of active documents whose prepass tiles (large objects named in the text: areas, gulfs, islands, archipelagos, admin regions, seas – `prepassTypes`) intersect the subdivision's scope tiles; then `startRereadRun(db, boss, { subdivisionKey, documentVersionIds, triggeredBy: "system" })` = kind `reprocess`, scope subdivision, `TEXT_RUN_STAGES` (stages 6–8), params `{ subdivisionKey, documentVersionIds, rematch: true }`. The stage ends after starting the run; the build does not wait („parallel zu 4 ff.“). No versions → no run.
- Mentions stay idempotent (unique `(chunk_id, geo_object_id, char_start)`).

- [ ] **Step 1: Failing test:** a document found for subdivision A (trip report naming „Saronic Gulf“ and a bay in subdivision B) has no mention of the bay while B is unbuilt; after B's gazetteer the `mentions.reread` stage starts a reprocess run whose `mentions.batch` creates the bay's mention; a second build of B adds no duplicate; a document whose prepass touches no tile of B is not selected; build stage list has `mentions.reread` right after the gazetteer stages.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(mentions): re-read prepass-touching documents when a subdivision is built (spec 14)`.

### Task 7: Map layer „Reviere“ with detail panel

**Files:**
- Modify: `lib/domain/map-data.ts` (areas layer properties, `subdivision` filter), `app/(admin)/_components/map-view.tsx` (fill + line layer, Landesteil filter, sidebar), `e2e/global-setup.ts` (seed one imported area with evidence)
- Create: `lib/domain/areas/view.ts`, `app/(admin)/map/area-detail/[id]/route.ts` (GET, admin session, JSON) or a server action – pick the pattern of `map-data/[layer]/route.ts`, `app/(admin)/map/area-panel.tsx`, `e2e/areas.spec.ts`
- Test: `lib/domain/areas/__tests__/view.test.ts`, `lib/domain/__tests__/map-data.test.ts` (extend), Playwright `e2e/areas.spec.ts`

**Interfaces:**
- Areas layer properties: `id`, `key`, `name`, `subdivisionKeys` (comma-joined keys of subdivisions whose scope tiles the area touches), `polygonOrigin`. Request accepts optional `subdivision` (key) in `mapDataRequest`.
- `areaDetail(db, areaId): Promise<{ id; publicId; key; names: Array<{ name; language; isPreferred }>; members: Array<{ id; name; type; role }>; unresolvedMembers: Array<{ name; type; role }>; boundary: string; related: Array<{ key; relation; id: string | null; name: string | null }>; evidence: Array<{ url; publisher; language; quote }>; notes: string; polygonOrigin: string; subdivisions: Array<{ key; name }>; importedFrom: string /* country */ } | null>`.
- Map: `areas-fill` (opacity 0.12) and `areas-line`, colour `AREA_COLOR`; overlapping areas stay visible (fill under line, no blending tricks); Landesteil select in the layer panel; click opens `AreaPanel` with Namen (je Sprache, bevorzugt fett), Mitglieder (aufgelöst als Links nach `/geo/<id>`, offene grau mit Typ), Abgrenzung, Beziehungen („enthält“, „liegt in“, „überlappt“), Belege (Zitat, Herausgeber, Link), Notizen, Hinweis „Quelle: Revier-Bot, Korrekturen dort“.

- [ ] **Step 1: Failing tests:** map-data `areas layer carries key and subdivision keys and filters by subdivision`; `areaDetail returns resolved and unresolved members, related with ids, evidence`; `ended area has no detail`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; Playwright `e2e/areas.spec.ts`: open `/map`, choose the seeded Landesteil, click the seeded area, see its quote and „Revier-Bot“. `npm run build`, lint.
- [ ] **Step 5: Commit** `feat(admin): Reviere map layer with Landesteil filter and detail panel (spec 14)`.

### Task 8: Settings, runbook, design docs, full check

**Files:**
- Modify: `app/(admin)/settings/page.tsx` (panel „Reviere“: `config/areas.json` values and the imported files with country, `generatedAt`, number of areas), `docs/runbook.md` (section „Reviere“: where the bot files go, how to import (`npm run areas:import`, on the server `scripts/import-areas.ts`), what „wartet auf Gazetteer“ means, that corrections happen in the bot; „Umstellung auf Landesteile“ step 10: run `scripts/import-areas.ts` after the migration and check Saronischer/Argolischer Golf in the map; note that `tiles.area_id` and `comparison_set.area_id` are legacy and are dropped only after the server migration ran), `docs/superpowers/specs/2026-10-18-periplus-design.md` (glossary „Revier“: delivered by the Revier-Bot, imported; table list `area_members`, `area_evidence`; section 11 row for spec 14: complete), `docs/superpowers/specs/2026-10-20-periplus-14-raumgliederung-design.md` (header: „Umgesetzt mit Plan 14a und 14b“; „Was dem Builder überlassen ist“ → decisions taken: `ST_ConcaveHull` ratio 0.3, `area_status` dropped with the bot change)
- Test: settings test if one exists, else covered by build

- [ ] **Step 1:** Settings panel and docs as listed.
- [ ] **Step 2:** Full suite `npx vitest run`, `npm run typecheck`, `npm run lint`, `npm run build`, Playwright `npx playwright test` → all green; fix what breaks.
- [ ] **Step 3: Commit** `docs: Reviere from the Revier bot in settings, runbook and design; spec 14 complete (spec 14)`.
