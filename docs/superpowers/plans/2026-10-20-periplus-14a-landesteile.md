# Periplus 14a – Landesteile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the configured area (Revier) as unit of work, hierarchy and delivery with the Landesteil (`subdivision`: country or first-level admin region with Mediterranean coast), built from OSM and Marine Regions, with a country → Landesteil admin view that starts builds manually.

**Architecture:** A coarse gazetteer imports IHO seas (Marine Regions), countries and admin regions (Overpass) and Mediterranean land polygons. `subdivisions.build` turns them plus `config/subdivisions.json` into rows of a stable `subdivisions` table. Tiles, run scopes, geo-object assignment (`geo_objects.subdivision_id`, nearest land), hierarchy, discovery languages, popularity, quality, comparison set and delivery (contract 2.0) switch from area to subdivision one subsystem per task. Existing area geo objects (`saronic`, `argolic`) stay as plain `area` objects; Plan 14b turns them into Reviere.

**Tech Stack:** Next.js 16 (App Router, server actions), TypeScript, Drizzle ORM + hand-written SQL migrations, Postgres/PostGIS, pg-boss, zod, vitest against `periplus_test`.

**Spec:** `docs/superpowers/specs/2026-10-20-periplus-14-raumgliederung-design.md` (sections Landesteile, Gazetteer in zwei Stufen, Elternkette, Landesteil-Lauf, Folgen, Admin-UI, Konfiguration, Umstellung). Not in this plan (→ Plan 14b): Revier data model (`area_status`, `area_members`, `area_evidence`), Revier finding, lanes, map editing, `area_candidate`, `subdivisionArea` templates, mentions re-read on subdivision start, coarse islands/gulfs/archipelagos/towns.

## Global Constraints

- Code, identifiers, tables, API, contract: English. UI copy: German. „Landesteil“ in UI, `subdivision` in code, public id prefix `sd_`.
- Domain logic only in `lib/domain` and `lib/pipeline`; pages, API routes and job handlers stay thin.
- Thresholds, levels, lists: `config/`, not code. External services only via adapters in `lib/adapters`; tests never call the network (recorded fixtures via `scripts/fixtures-record.ts`, `fixtureTransport`).
- Tests run against real Postgres (`periplus_test`), each in `withRollback`; committed geo rows must lie outside 23.0–23.75 E × 37.0–38.0 N.
- Stable tables reject DELETE and record history (pattern of `drizzle/0006_geo_triggers.sql`); new stable table `subdivisions` follows it.
- A subdivision with `built_at` is never replaced by `subdivisions.build`; it is only reported.
- A geo object's subdivision is the subdivision whose land (polygon ∩ land polygons) is nearest to its centroid. It decides package content, `popularity`, metrics and comparison set; `tiles.subdivision_id` (largest coastline share) only labels.
- Contract version 2.0: `area` → `subdivision` everywhere; 1.0 schemas stay published.
- Before touching routes, `proxy.ts` or `next.config.ts`: read the Next 16 docs in `node_modules/next/dist/docs/`.
- Work happens in worktree branch `feat/raumgliederung`; never commit to `main` (another session develops there).
- Per task finish: `npx vitest run <touched test files>`, then `npm run typecheck` and `npm run lint` before the commit.

## Review Focus

1. A country whose OSM first level has no ISO3166-2 tag (Montenegro, Libya mismatches, Keserwan-Jbeil) → key comes from config, never crashes the build. Test in Task 4.
2. A tile shared by two subdivisions is in both run scopes and its places stay assigned to the land they touch, even when the tile label is the other subdivision (Kastellorizo). Tests in Tasks 5 and 6.
3. Re-running `subdivisions.build` after a config change replaces only unbuilt subdivisions; built keys, `sd_` ids and package paths stay. Test in Task 4.
4. Admin starts „Alle offenen aufbauen“ twice or while a build runs → no duplicate runs, queue continues after a failed build. Test in Task 10.
5. A run, script or API call still passing an area key (`saronic`) fails with a clear message naming the subdivision to use instead, not a generic “Unknown”. Test in Task 7.

---

### Task 1: Configuration `config/subdivisions.json`

**Files:**
- Create: `config/subdivisions.json`
- Modify: `lib/config/schemas.ts` (new `subdivisionsConfigSchema`, export type `SubdivisionsConfig`), `lib/config/index.ts` (`AppConfig.subdivisions`, `loadConfig`, helper `countryConfig(iso)`)
- Test: `lib/config/__tests__/config.test.ts` (extend `Overrides` and `fixtureDir`)

**Interfaces:**
- Produces: `SubdivisionsConfig` and `getConfig().subdivisions` with:
  - `mediterranean: { marineRegionsMrgids: number[] }` (IHO seas counted as Mediterranean, incl. Strait of Gibraltar; Sea of Marmara excluded)
  - `countries: Record<Iso2, { firstLevel: number | "whole"; secondLevel?: number; sourceLanguages: string[]; season: {fromMonth,toMonth}; cycleDays: number; status?: "active"|"excluded"; statusReason?: string }>`
  - `split: Array<{ parentKey: string; groups: Array<{ key: string; names: Record<string,string>; memberWikidataIds: string[] }> }>`
  - `wholeCountry: Iso2[]`
  - `extra: Array<{ key: string; country: Iso2; osmRelationId: number; cutFrom: Iso2; names: Record<string,string> }>`
  - `merge: Array<{ key: string; memberKeys: string[]; names: Record<string,string> }>`
  - `notMediterranean: string[]` (unit keys touching the IHO polygon only via canals or river mouths)
  - `keyOverrides: Record<string /* osm relation id */, string>` (units without or with wrong ISO3166-2)
  - `overrides: Record<string /* subdivision key */, { status?, statusReason?, sourceLanguages?, season?, cycleDays?, coastSections?: CoastSection[] }>`
  - `countryConfig(iso: string): SubdivisionsConfig["countries"][string]` throws `Unknown country <iso>`.

- [ ] **Step 1: Write the failing tests** in `config.test.ts`:
  - `loads subdivisions.json`: `getConfig().subdivisions.countries.GR.firstLevel === 5`, `HR === 4`, `AL === 6`, `MC === "whole"`; `wholeCountry` contains `LB`, `IL`, `CY`; `split[0].parentKey === "GR-L"` with group keys `GR-CYC`, `GR-DOD`; `extra[0].osmRelationId === 2514541`; `countries.LY.status === "excluded"`.
  - `rejects a split group without members` and `rejects a merge key that is also a split group key` (error message starts with `Invalid config subdivisions:`).
  - `rejects coastSections with duplicate keys` (reuse `coastSectionSchema` refine).
- [ ] **Step 2: Run** `npx vitest run lib/config/__tests__/config.test.ts` → FAIL (`subdivisions` missing).
- [ ] **Step 3: Write `config/subdivisions.json`.** Levels from the OSM spike (`levels.json`): ES 4, FR 4, IT 4, HR 4, AL 6, GR 5 (secondLevel 6), TR 4, CY 5, SY 4, LB 4, IL 4, EG 4, LY 4, TN 4, DZ 4, MA 4; `whole` for MC, MT, SI, BA, ME, GI, PS, GB (Akrotiri/Dhekelia). `wholeCountry`: LB, IL, CY. `status: "excluded"` with reason for LY („Bürgerkrieg, kein Segelbetrieb“), SY („Krieg“), PS („Gaza, Sperrgebiet“). `split`: `GR-L` → `GR-CYC` Kykladen (regional units Andros, Kea-Kythnos, Milos, Naxos, Paros, Syros, Thira, Tinos, Mykonos) and `GR-DOD` Dodekanes (Kalymnos, Karpathos, Kos, Rhodes); look up the regional units' Wikidata ids once via Overpass `relation[boundary=administrative][admin_level=6](area:GR-L)` and write them in. `extra`: Nordzypern `CY-NC`, relation 2514541, `cutFrom: "CY"`. `notMediterranean`: `EG-IS`, `EG-SUZ`, `EG-GH`. `keyOverrides`: Keserwan-Jbeil → `LB-KJ`, Akrotiri/Dhekelia → `GB-SBA` (moot under `wholeCountry` but kept for the build report). `sourceLanguages` per country: official language(s) + `de` + `en` (GR `el`, HR `hr`, IT `it`, ES `es` + `ca` for ES-CT and ES-IB via `overrides`, FR `fr`, TR `tr`, …). `season` 4–10 and `cycleDays` 30 as in `config/areas/saronic.json`. Move `coastSections` of `saronic.json` (`methana`, `ermioni`, `porto-cheli`, …) into `overrides["GR-J"]`/`["GR-I"]` by location (Methana: GR-I; Ermioni, Porto Cheli: GR-J) — check each section's polygon centroid. `mediterranean.marineRegionsMrgids`: IHO sea areas inside the Mediterranean from Marine Regions (Alboran Sea, Balearic Sea, Ligurian Sea, Tyrrhenian Sea, Adriatic Sea, Ionian Sea, Aegean Sea, Mediterranean Sea – Western and Eastern Basin, Strait of Gibraltar); look the MRGIDs up once on marineregions.org.
- [ ] **Step 4: Implement schema and loader** with zod `strictObject`, `superRefine` for the two cross-checks; register `subdivisions: readJson(dir, "subdivisions", subdivisionsConfigSchema)` in `loadConfig`.
- [ ] **Step 5: Run** the config test → PASS. Run `npm run typecheck`.
- [ ] **Step 6: Commit** `feat(config): subdivisions.json with levels, splits, whole countries, Northern Cyprus and exclusions (spec 14)`.

### Task 2: Schema – subdivisions, geo types, columns

**Files:**
- Modify: `lib/db/schema/geo.ts` (enum `geo_object_type` + `country`, `admin_region`; enum `geo_origin` + `marine_regions`; table `subdivisions`; `geoObjects.subdivisionId`, `geoObjects.seaId`, `geoObjects.adminLevel` integer null; `tiles.subdivisionId` + index; `comparisonSet.subdivisionId` nullable FK), `lib/db/schema/ops.ts` (`run_scope_type` + `subdivision`), `lib/db/schema/quality.ts` (scope check + `subdivision`), `lib/domain/ids.ts` (`PublicIdPrefix` + `"sd"`)
- Create: `drizzle/0053_subdivisions_schema.sql` (generated), `drizzle/0054_subdivisions_triggers.sql` (`--custom`)
- Test: `lib/db/__tests__/subdivisions-schema.test.ts`

**Interfaces:**
- Produces table `subdivisions`: `id uuid pk (newId)`, `public_id text unique not null check like 'sd\_%'`, `key text not null` (unique where `valid_to is null`), `country text not null` (ISO alpha-2), `geo_object_id uuid not null → geo_objects`, `geom geometry(MultiPolygon,4326) not null`, `land_geom geometry(MultiPolygon,4326)` (null until computed), `status subdivision_status ('active'|'excluded') not null default 'active'`, `status_reason text`, `queued_at timestamptz`, `built_at timestamptz`, `valid_from date`, `valid_to date`, `created_at`, `updated_at`. GiST on `geom` and `land_geom`.
- Drizzle exports: `subdivisions`, `subdivisionStatusEnum`, type `SubdivisionStatus`.
- `tiles.area_id` and `comparison_set.area_id` stay (nullable from now on for `comparison_set`); they are read nowhere after Task 9 and dropped in Plan 14b.

- [ ] **Step 1: Write the failing tests:** `subdivisions rejects DELETE` (error from `forbid_delete`), `subdivisions update writes subdivisions_history` (change `status`, history row with old status), `public_id must start with sd_`, `two valid rows cannot share a key`, `geo_objects accepts types country and admin_region with public_id null`, `runs accept scope_type subdivision`.
- [ ] **Step 2: Run** `npx vitest run lib/db/__tests__/subdivisions-schema.test.ts` → FAIL.
- [ ] **Step 3: Schema + migrations.** `npm run db:generate` for 0053; `npx drizzle-kit generate --custom --name subdivisions_triggers` for 0054 with: `forbid_delete` trigger, `subdivisions_history` table + append-only trigger + `record_history('status,status_reason,geom,land_geom,queued_at,built_at,valid_to')`, `set_updated_at`, TRUNCATE guard; recreate `geo_objects_record_history` with `'type,geom,parent_id,subdivision_id,sea_id,valid_to'` and `tiles_record_history` with `'area_id,subdivision_id,has_coast,valid_to'`. `geo_objects_public_id_prefix_check` needs no change (`country`/`admin_region` fall to `''`, i.e. public_id null).
- [ ] **Step 4: Run** the test → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(db): subdivisions table, country/admin_region types, subdivision and sea columns (spec 14)`.

### Task 3: Adapters – Overpass boundaries and Marine Regions seas

**Files:**
- Modify: `lib/adapters/overpass.ts` (`buildBoundaryQuery`)
- Create: `lib/adapters/marine-regions.ts`
- Modify: `config/gazetteer.json` + `gazetteerSchema` (`marineRegions: { endpoint, timeoutMs }`)
- Modify: `scripts/fixtures-record.ts` (mode `--coarse <ISO2,…>` recording boundaries and seas)
- Create fixtures: `test/fixtures/http/overpass/*`, `test/fixtures/http/marine-regions/*` for MT and HR plus the configured MRGIDs
- Test: `lib/adapters/__tests__/overpass-boundaries.test.ts`, `lib/adapters/__tests__/marine-regions.test.ts`

**Interfaces:**
- Produces:
  - `buildBoundaryQuery(country: string, levels: number[], timeoutSeconds: number): string` – `area["ISO3166-1"="<cc>"][admin_level=2]` then `relation[boundary=administrative][admin_level~"^(l1|l2)$"](area)`, plus the country relation itself; `out geom`.
  - `buildRelationQuery(relationIds: number[], timeoutSeconds: number): string` (for `extra`).
  - `fetchSeas(transport, mrgids: number[], cfg): Promise<Array<{ mrgid: number; name: string; geometry: MultiPolygon }>>` via Marine Regions WFS GetFeature (layer `MarineRegions:iho`, filter by `mrgid`, `outputFormat=application/json`); responses that are not JSON → `RetryableHttpError`.

- [ ] **Step 1: Record fixtures** (network allowed only here): `npx tsx scripts/fixtures-record.ts --coarse MT,HR` against a `*_scratch` database.
- [ ] **Step 2: Write the failing tests:** boundary query text contains `admin_level~"^(4)$"` for HR and the area clause for `HR`; replaying the HR fixture through `overpassQuery` yields 21 level-4 relations incl. tag `ISO3166-2=HR-17`; `fetchSeas` on the fixture returns the configured MRGIDs with MultiPolygon geometry; an HTML error body raises `RetryableHttpError`.
- [ ] **Step 3: Run** both test files → FAIL.
- [ ] **Step 4: Implement** the two builders and `fetchSeas` (reuse `getTransport`, the timeout and retry pattern of `overpassQuery`).
- [ ] **Step 5: Run** → PASS; typecheck, lint.
- [ ] **Step 6: Commit** `feat(adapters): Overpass boundary queries and Marine Regions IHO seas with fixtures (spec 14)`.

### Task 4: Coarse gazetteer and `subdivisions.build`

**Files:**
- Create: `lib/pipeline/gazetteer/coarse.ts` (stage `gazetteer.coarse`), `lib/domain/subdivisions/plan.ts` (pure planning), `lib/domain/subdivisions/store.ts` (apply plan, land geometry), `lib/pipeline/subdivisions.ts` (stage `subdivisions.build`, `startSubdivisionsBuildRun`), job handlers in `lib/jobs/handlers/subdivisions.ts`, register in the handler index
- Modify: `scripts/import-land-polygons.ts` (`--mediterranean` instead of `--area`: bbox from the union of the configured seas' extents + `gazetteer.landBufferKm`), `lib/domain/gazetteer/osm-classify.ts` (boundary relations → `country` / `admin_region` with `admin_level`)
- Test: `lib/domain/subdivisions/__tests__/plan.test.ts`, `lib/pipeline/__tests__/subdivisions-build.test.ts`, `scripts/__tests__/import-land-polygons.test.ts`

**Interfaces:**
- Consumes: Task 1 config, Task 2 table, Task 3 adapters.
- Produces:
  - `importCoarse(db, country: string): Promise<{ countries: number; regions: number }>` and `importSeas(db): Promise<number>` (geo objects type `sea`, origin `marine_regions`, names `en` from Marine Regions; idempotent via `tags.mrgid`).
  - `type AdminUnit = { geoObjectId: string; country: string; adminLevel: number; iso: string | null; osmRelationId: number; wikidataId: string | null; geom: MultiPolygon; touchesMediterranean: boolean }`
  - `planSubdivisions(units: AdminUnit[], cfg: SubdivisionsConfig): Array<{ key: string; country: string; geoObjectId: string; memberGeoObjectIds: string[]; status: SubdivisionStatus; statusReason: string | null; names: Record<string,string> }>` – rules in this order: excluded countries → one row per country with status `excluded`; `wholeCountry` and `firstLevel: "whole"` → the country; else first-level units with `touchesMediterranean` minus `notMediterranean`; `split` replaces the parent by its groups (geometry = union of members, geo object = new `admin_region` with `config_key = group key`); `merge` likewise; `extra` adds the unit and cuts its geometry from the `cutFrom` country's rows. Key = `keyOverrides[osmRelationId]` ?? ISO3166-2 ?? `<country>-<wikidataId>`.
  - `applySubdivisionPlan(db, plan, today): Promise<{ inserted: number; replaced: number; unchanged: number; deviations: Array<{ key: string; reason: string }> }>` – rows with `built_at` untouched (difference reported as deviation); others ended via `valid_to` and recreated when geometry, members or status differ; stored `geom` = unit polygon ∪ 12 sm (22 224 m, geography buffer) around its land, so islands and coastal water are inside even where OSM boundaries stop at the coastline (neighbours may overlap in water; assignment goes by land); `land_geom = ST_Multi(ST_Intersection(geom, union of land_polygons within geom))`.
  - Stages `gazetteer.coarse` (per configured country, sub-jobs) and `subdivisions.build`; `startSubdivisionsBuildRun(db, boss, triggeredBy)` with scope `{ type: "system", id: "subdivisions" }`.
  - `touchesMediterranean`: unit geometry within 2 km of a configured sea polygon (`ST_DWithin` on geography).

- [ ] **Step 1: Write the failing plan tests** (pure, synthetic units): `excluded country yields one excluded row`, `whole country yields the country`, `split replaces GR-L by GR-CYC and GR-DOD`, `extra cuts CY-NC out of CY`, `notMediterranean drops a unit`, `unit without ISO takes keyOverrides, else <cc>-<Qid>` (Review Focus 1).
- [ ] **Step 2: Write the failing DB tests** (`withRollback`, units outside the pilot box): `applySubdivisionPlan inserts with sd_ ids and land_geom`, `second apply with same plan changes nothing`, `changed config replaces an unbuilt row and only reports a built one` (Review Focus 3), `importSeas is idempotent` (fixture), `importCoarse(MT)` creates one country geo object with `admin_level 2`.
- [ ] **Step 3: Run** the three test files → FAIL.
- [ ] **Step 4: Implement** classify, import, plan, store, stages, handlers, run starter; land-import script switch with test `parseArgs(["--shp","x","--mediterranean"])`.
- [ ] **Step 5: Run** → PASS; typecheck, lint.
- [ ] **Step 6: Commit** `feat(gazetteer): coarse gazetteer (seas, countries, admin regions) and subdivisions.build (spec 14)`.

### Task 5: Tiles per subdivision and run scope

**Files:**
- Modify: `lib/domain/gazetteer/tiles-ensure.ts` (replace area logic), `lib/pipeline/tile-scope.ts`, `lib/jobs/handlers/tiles.ts`
- Test: `lib/domain/gazetteer/__tests__/tiles-ensure.test.ts` (rewrite area cases), `lib/pipeline/__tests__/tile-scope.test.ts`

**Interfaces:**
- Consumes: `subdivisions` rows (Task 4).
- Produces:
  - `subdivisionByKey(db, key: string): Promise<{ id: string; publicId: string; key: string; country: string; status: SubdivisionStatus; bbox: Bbox } | null>` in `lib/domain/subdivisions/store.ts`.
  - `ensureSubdivisionTiles(db, subdivisionId: string): Promise<{ tiles: number; coast: number }>` – creates tiles of the subdivision's polygon bbox whose box intersects the polygon; `has_coast` from land polygons; `subdivision_id` = subdivision with the largest length of `ST_Boundary(land) ∩ tile box` among all valid subdivisions whose polygon intersects the tile; `cycle_days` from config (country default, override per key). No `coast_tile_without_area` task anymore.
  - `subdivisionTileIds(db, subdivisionId: string): Promise<string[]>` – valid coast tiles whose box intersects the subdivision polygon (both neighbours' scopes include a shared tile), ordered by id.
  - `seedTileIds(db, params)` accepts `params.subdivisionKey` (instead of `areaKey`); a passed `areaKey` throws `Revier-Schlüssel <k> ist kein Laufumfang mehr; Landesteil angeben (z. B. GR-I)`.
  - Excluded subdivision → `ensureSubdivisionTiles` throws `Landesteil <key> ist ausgeschlossen`.

- [ ] **Step 1: Failing tests:** `shared border tile is in both subdivision scopes` (Review Focus 2), `label goes to the subdivision with more coastline in the tile`, `excluded subdivision creates no tiles`, `seedTileIds with areaKey names the replacement` (Review Focus 5), `cycle_days from override`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(tiles): tiles and run scope per subdivision; coast tiles without area end (spec 14)`.

### Task 6: Assignment, sea and hierarchy

**Files:**
- Modify: `lib/domain/gazetteer/hierarchy.ts`, `lib/pipeline/gazetteer/hierarchy.ts`, `lib/pipeline/gazetteer/{osm,wikidata,geonames,stages}.ts`, `lib/domain/gazetteer/areas.ts` (keep `polygonBbox`; `syncAreas` → `syncCoastSections(db, subdivisionKey)` from config overrides)
- Test: `lib/domain/gazetteer/__tests__/hierarchy.test.ts`, `lib/pipeline/__tests__/gazetteer-run.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5.
- Produces:
  - `type GazetteerScope = { subdivisionId: string; key: string; country: string; bbox: Bbox; sourceLanguages: string[] }` and `gazetteerScope(db, key): Promise<GazetteerScope>`; `importOsm`, `importWikidata`, `importGeonames` take `{ scope: GazetteerScope }` instead of `{ area: AreaConfig }` (geonames country = `scope.country`; archive path `datasets/overpass/<key>/<date>.json`).
  - `assignSubdivisions(db, bbox: Bbox): Promise<number>` – sets `geo_objects.subdivision_id` for valid objects with centroid in bbox to the nearest `land_geom` (prefilter `ST_DWithin` 30 km, then `ORDER BY ST_Distance`), only changed rows.
  - `assignSeas(db, bbox): Promise<number>` – `sea_id` = sea polygon covering the centroid, else nearest.
  - `parentRules()`: local types → smallest island/coast section (unchanged rule) → else the subdivision's geo object; island/archipelago/gulf/coast_section → subdivision's geo object; `admin_region` of a split group → its country; first-level `admin_region` → country; `area` objects → no parent (`parent_id` null). Sea no longer a parent.
  - `startGazetteerRun(db, boss, subdivisionKey, triggeredBy)` scope `{ type: "subdivision", id: key }`, stages `tiles.ensure`, `gazetteer.osm`, `gazetteer.wikidata`, `gazetteer.geonames`, `gazetteer.hierarchy`.

- [ ] **Step 1: Failing tests:** `island near a foreign coast belongs to its own country's subdivision` (synthetic Kastellorizo: Greek island polygon 3 km from a Turkish subdivision polygon, centroid inside the Turkish polygon's water buffer; expect Greek subdivision) (Review Focus 2); `bay → island → admin_region → country chain`; `area object keeps no parent`; `sea_id set`; gazetteer run replays the existing `aegina-west` fixtures with a subdivision scope and yields the same object count as before.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Replace the `aegina-west` area fixture by a subdivision fixture (`test/fixtures/subdivisions/aegina-west.ts` inserting country + admin region + subdivision row around the fixture bbox). **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(gazetteer): subdivision assignment by nearest land, sea chain, hierarchy over subdivisions (spec 14)`.

### Task 7: Run starters, handlers, scripts, datasets, wikivoyage

**Files:**
- Modify: `lib/pipeline/{seed,geometry-run,datasets-run,datasets,discovery-run}.ts`, `lib/pipeline/fetch/run.ts` (`startWikivoyageRun`), `lib/pipeline/sources/wikivoyage.ts`, `lib/domain/geometry/{seabed,check}.ts`, `lib/jobs/handlers/{gazetteer,datasets,discovery,wikivoyage,tiles}.ts`, scripts `check-gazetteer`, `check-geometry`, `import-land-polygons`, `fixtures-record` (`--subdivision`), `app/(admin)/runs/{actions.ts,page.tsx}`, `app/(admin)/_components/labels.ts` (scope label `subdivision: "Landesteil"`, new reasons)
- Create: `drizzle/0055_seabed_subdivision_key.sql` (rename `seabed_polygons.area_key` → `subdivision_key`)
- Test: existing `lib/pipeline/__tests__/{seed,datasets,geometry-golden,wikivoyage,discovery}.test.ts`, `app/(admin)/__tests__/actions.test.ts`

**Interfaces:**
- Consumes: `subdivisionByKey`, `subdivisionTileIds`, `gazetteerScope` (Tasks 5, 6).
- Produces: every starter takes `subdivisionKey: string` and uses scope `{ type: "subdivision", id: key }`, params `{ subdivisionKey }`; `subdivisionKeyOf(params): string` in `lib/jobs/handlers/tiles.ts` replaces `areaKeyOf`; unknown key → `Unbekannter Landesteil <key>`; area key → message from Task 5. `datasetBox(scope: GazetteerScope)`. Runs page selects a subdivision (grouped by country) instead of an area.

- [ ] **Step 1: Adapt tests first:** replace the `vi.mock("@/lib/config")` area injection in the listed tests by the subdivision fixture from Task 6; add `startSeedRun with an area key fails with the replacement hint` (Review Focus 5) and `runs action rejects an unknown subdivision`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the listed tests → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `refactor(runs): gazetteer, seed, geometry, datasets, wikivoyage and their scripts run per subdivision (spec 14)`.

### Task 8: Discovery, mentions and text selection

**Files:**
- Modify: `lib/domain/discovery/queries.ts`, `lib/pipeline/discovery.ts`, `lib/domain/mentions/scope.ts`, `lib/domain/mentions/tile-borders.ts`, `lib/pipeline/text/{mentions,versions,run}.ts`, `config/mentions.json` (`prepassTypes` + `country`, `admin_region`, `sea`)
- Test: `lib/domain/__tests__/discovery-queries.test.ts`, `lib/pipeline/__tests__/discovery.test.ts`, `lib/domain/mentions/__tests__/scope.test.ts`, `lib/pipeline/__tests__/text-run.test.ts`, `lib/domain/consolidation/__tests__/followup.test.ts`

**Interfaces:**
- Produces:
  - `sourceLanguagesOfTile(db, tileId): Promise<string[]>` – from the tile's `subdivision_id` (override ?? country default). `tileQueries` and `placeQueries` use it; a tile without subdivision throws `Kachel <id> hat keinen Landesteil`.
  - `areaQueries(db, subdivisionKey, cfg)`: for every valid `area` geo object whose `tile_geo_objects` touch the subdivision's scope tiles, names × `templates.area` in the subdivision's languages; `scopeId` stays the area's `config_key` (Plan 14b moves it to the id); a query already made within `serp.reuseDays` is skipped (existing reuse).
  - Mentions: `prepassTiles` drops the `tiles.area_id` branch (areas reach tiles via `tile_geo_objects`); `sourceTiles` maps SERP `level='area'` → area object → its `tile_geo_objects`; `fallbackTiles(db, subdivisionKeys)`; callers pass `subdivisionKeys` (active subdivisions with tiles).
  - Text selection `scopeTiles`/`scopeSources` by `subdivisionKey`.

- [ ] **Step 1: Failing tests:** `area touching two subdivisions is searched once per reuse window`, `tile query languages come from the subdivision override`, `prepass hit on an area yields its tile_geo_objects tiles`, `fallback uses subdivision tiles`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `refactor(discovery,mentions): languages and scopes from subdivisions; areas reach tiles via tile_geo_objects (spec 14)`.

### Task 9: Consolidation, popularity, quality, comparison, revisit

**Files:**
- Modify: `lib/domain/consolidation/derived/popularity.ts` (`popularityForSubdivision`), `lib/domain/profile-view.ts`, `lib/domain/consolidation/targets.ts`, `lib/pipeline/consolidation/run.ts`, `lib/domain/comparison.ts`, `lib/domain/quality/*` (scope `{ subdivisionKey, tileId? }`, snapshot `scope_type 'subdivision'`), `lib/pipeline/quality-run.ts`, `lib/domain/revisit/*`, `lib/pipeline/revisit-*.ts`, `lib/domain/place-merge.ts`, `lib/domain/acceptance/profiles.ts`, `lib/domain/quality/reports.ts` (`cycleDays` from subdivision config), `config/quality.json` (`perAreaMin/Max` → `perSubdivisionMin/Max`, `extrapolation.areas*` → `subdivisions*`), scripts `check-profiles`, `consolidate`, `compare-navily`, `report-costs`, `report-pilot`, `sim/*`, admin `quality`, `quality/compare`, `sources` pages/actions
- Test: the quality, comparison, revisit, consolidation-run, place-merge and admin action tests listed in the area map (`metrics`, `metrics-ops`, `snapshot`, `regression`, `navily-*`, `verify`, `sim-verify`, `quality`, `revisit`, `consolidation-run`, `place-merge`, `actions`)

**Interfaces:**
- Produces: `popularityForSubdivision(db, subdivisionId, today): Promise<Map<string, number>>` normalised over places with `geo_objects.subdivision_id = subdivisionId`; `QualityScope = { subdivisionKey: string; tileId?: string }`; `comparison_set.subdivision_id` written and read (place's `geo_objects.subdivision_id`); `place-merge` same-scope check by `subdivision_id`.

- [ ] **Step 1: Adapt tests:** `insertQualityArea` → `insertQualitySubdivision` in `test/quality.ts`; add `popularity normalises within the subdivision of the place, not the tile label` (Kastellorizo-style place in a tile labelled with the neighbour).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the listed tests → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `refactor(quality,consolidation): popularity, metrics, comparison set and revisit per subdivision (spec 14)`.

### Task 10: Delivery – contract 2.0

**Files:**
- Create: `contract/v2/*` (copy of v1 with changes), `contract/schema/2.0/*.schema.json` (`npm run contract:generate`), `drizzle/0056_deliveries_subdivision.sql` (`deliveries.subdivision_id`, `delivered_objects.subdivision_id` NOT NULL for new rows; old area rows stay readable), API routes `app/api/v2/subdivisions/route.ts`, `app/api/v2/subdivisions/[subdivision]/package/route.ts`, `…/package/[file]/route.ts`, `…/changes/route.ts`
- Modify: `contract/index.ts` (`SCHEMA_VERSION = "2.0"`), `contract/schema/published.ts` (keep `1.0`, add `2.0`), `lib/domain/delivery/{build,load,types,draft,map-region,versioning,validate,read,view}.ts`, `lib/pipeline/delivery{,-run}.ts`, `lib/domain/overview.ts`, `scripts/delivery-consume.ts`, admin `deliveries/*`; remove `app/api/v1/areas/**`
- Test: `contract/__tests__/contract.test.ts`, `lib/domain/delivery/__tests__/*`, `lib/db/__tests__/delivery-schema.test.ts`, `lib/pipeline/__tests__/delivery-run.test.ts`, `app/__tests__/api-package.test.ts`, `test/fixtures/delivery/area.ts` → `subdivision.ts`, `test/fixtures/delivery/expected/*` regenerated

**Interfaces:**
- Produces: envelope `{ schemaVersion: "2.0", subdivision: publicId("sd"), dataVersion, generatedAt }`; `manifest.subdivision: { id, key, name, names[], polygon }`, `manifest.areas: Array<{ id: ar_, key, names[] }>` (areas whose `tile_geo_objects` touch the scope tiles); `region.parentId: rg_ | null`; package content = places/POIs/regions with `geo_objects.subdivision_id` = subdivision; manifest `tiles` = `subdivisionTileIds` with their state; storage `deliveries/<subdivision-key>/<dataVersion>/`; `dataVersion` starts at 1 per subdivision; `buildDelivery(db, archive, subdivisionId, opts)`; `startDeliveryRun(db, boss, subdivisionKey, triggeredBy)`.
- A place whose `subdivision_id` changed: removed in the old feed, added in the new one, same `sp_` id.

- [ ] **Step 1: Failing tests:** contract 2.0 schemas pinned; `package contains the Kastellorizo place in the Greek subdivision although its tile label is Turkish`; `manifest.areas lists touching areas`; `partly built subdivision packages only processed tiles` (tiles without run listed with empty state); `1.0 schema route still serves 1.0`; `GET /api/v2/subdivisions/GR-I/package` returns the manifest.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; read `node_modules/next/dist/docs/` on route handlers first. **Step 4: Run** → PASS; `npm run build`, lint.
- [ ] **Step 5: Commit** `feat(delivery): contract 2.0 with subdivisions; packages by place assignment; API v2 (spec 14)`.

### Task 11: Admin view „Länder und Landesteile“, map, settings, review cleanup

**Files:**
- Create: `app/(admin)/subdivisions/page.tsx`, `app/(admin)/subdivisions/[key]/page.tsx`, `app/(admin)/subdivisions/actions.ts`, `app/(admin)/subdivisions/loading.tsx`, `lib/domain/subdivisions/view.ts`, `lib/pipeline/subdivision-build.ts`
- Modify: admin navigation, `lib/domain/map-data.ts` + `_components/map-view.tsx` (layers `subdivisions`, `seas`; tile property `subdivisionKey`), `app/(admin)/settings/page.tsx` (show `subdivisions.json`), `lib/domain/geo-view.ts` + `app/(admin)/tiles/[id]/page.tsx` (subdivision instead of area), `app/(admin)/review/kinds.ts` + `labels.ts` + `lib/domain/review-view.ts` + `lib/domain/review-decisions.ts` (drop `coast_tile_without_area` from lists and decision schemas; enum value stays; open tasks of that kind are dismissed by migration `drizzle/0057_dismiss_coast_tile_tasks.sql`)
- Test: `lib/domain/subdivisions/__tests__/view.test.ts`, `lib/pipeline/__tests__/subdivision-build.test.ts`, `app/(admin)/__tests__/actions.test.ts`, one Playwright case in `e2e/`

**Interfaces:**
- Consumes: all starters (Tasks 6, 7).
- Produces:
  - `SUBDIVISION_BUILD_STAGES` = the stages of `startGazetteerRun`, `startDatasetImportRun`, `startSeedRun`, `startGeometryRun` and the area/tile stages of `startDiscoveryRun`, in that order, from their exported constants. Fetch, text, consolidation and delivery stay separate runs (they wait on source approval).
  - `startSubdivisionBuild(db, boss, key, triggeredBy): Promise<{ id: string } | { alreadyRunning: string }>` – one run kind `full`, scope subdivision; refuses excluded; a running build for the key returns `alreadyRunning`.
  - On successful completion of that run: `built_at = now()`, `queued_at = null`, then `startNextQueued(db, boss, country)` starts the oldest queued subdivision of the same country. On failure: `queued_at = null` for the failed one and the queue continues.
  - `queueCountry(db, boss, country, triggeredBy): Promise<{ queued: number; started: string | null }>` – sets `queued_at` on all active, never-built, unqueued subdivisions of the country; starts one if none of the country runs.
  - `subdivisionTree(db): Promise<Array<{ country: string; name: string; whole: boolean; summary: { total; built; running; failed; excluded }; subdivisions: Array<{ key; publicId; name; status: "nicht begonnen"|"läuft"|"aufgebaut"|"fehlgeschlagen"|"ausgeschlossen"; statusReason: string|null; coastTiles: number; processedTiles: number; lastRunAt: string|null; costEur: number; queued: boolean }> }>>`
  - Page `/subdivisions` „Länder und Landesteile“: tree country → Landesteile; whole-country rows without children; per row status, Küstenkacheln, davon bearbeitet, letzter Lauf, Kosten; button „Aufbauen“ per Landesteil (also when built), „Alle offenen aufbauen“ per country; none for excluded; filter by status. Detail page per key with tiles, touching areas, metrics, runs.

- [ ] **Step 1: Failing tests:** `tree groups by country and marks whole countries`, `status mapping for each of the five states`, `startSubdivisionBuild twice returns alreadyRunning`, `queueCountry twice queues nothing new` and `failed build starts the next queued one` (Review Focus 4), `excluded subdivision has no start action`, `coast_tile_without_area is not offered in review lists`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; read the Next 16 docs on server actions and `loading.tsx` first. **Step 4: Run** → PASS; Playwright: open `/subdivisions`, expand Griechenland, see Attika with „Aufbauen“. `npm run build`, lint.
- [ ] **Step 5: Commit** `feat(admin): Länder und Landesteile view with status and manual builds; map layers; coast-tile review retired (spec 14)`.

### Task 12: Pilot migration, cleanup of area config, docs

**Files:**
- Create: `scripts/migrate-subdivisions.ts` (backfill after `gazetteer.coarse` + `subdivisions.build`), `scripts/check-subdivision-migration.ts` (before/after comparison), `scripts/__tests__/migrate-subdivisions.test.ts`
- Delete: `config/areas/`, `readAreas`, `areaConfigSchema`, `AppConfig.areas`, `areaByKey`, `syncAreas`, `endUnconfiguredAreas`, `areaTileIds`, `areaGeoObjectId` (grep must find no caller)
- Modify: `docs/runbook.md` (Umstellung steps), `docs/superpowers/specs/2026-10-18-periplus-design.md` (section 4 rows from spec 14 „Abweichungen“, glossary „Revier“ new meaning + „Landesteil“ `subdivision`, IDs list + `sd_`, roadmap M9, section 11 rows 14, section 12 „Revier-Polygone“ closed), `docs/superpowers/specs/2026-10-20-periplus-12-pruefung-echtdaten-design.md` (Umfangsleiter: Probekachel → Landesteil Attika `GR-I` → Peloponnes `GR-J`; `--area saronic` → `--subdivision GR-I`)

**Interfaces:**
- Produces:
  - `snapshotPilot(db): Promise<PilotSnapshot>` – per pilot tile: place public ids, fact ids, current profile versions; written to JSON.
  - `migrateSubdivisions(db, today): Promise<{ tiles: number; objects: number; comparison: number; seabed: number }>` – runs `ensureSubdivisionTiles` for every subdivision that contains a pilot tile, `assignSubdivisions` and `assignSeas` over the pilot bbox, hierarchy, `comparison_set.subdivision_id` from the place, `seabed_polygons.subdivision_key` from location; idempotent.
  - `check-subdivision-migration --before a.json --after b.json` exits 0 only if every pilot place, fact and profile version is unchanged.

- [ ] **Step 1: Failing test:** on the delivery fixture: snapshot, migrate, snapshot → equal; second migrate changes nothing.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, then delete the area config code paths; `grep -rn "areaByKey\|config/areas\|AreaConfig\|areaKey" lib app scripts` → only Revier (`area` geo object) uses remain. **Step 4:** full suite `npm test`, `npm run build`, lint → PASS.
- [ ] **Step 5: Docs** as listed; runbook order: deploy → `import-land-polygons --mediterranean` → `gazetteer.coarse` → `subdivisions.build` → check list on `/subdivisions` → `snapshotPilot` → `migrate-subdivisions` → `snapshotPilot` → `check-subdivision-migration` → rebuild packages for GR-I, GR-J.
- [ ] **Step 6: Commit** `refactor: pilot migrates to subdivisions; area config removed; design, runbook and spec 12 updated (spec 14)`.
