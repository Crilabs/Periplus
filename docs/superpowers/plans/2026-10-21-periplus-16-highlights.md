# Periplus 16 – Highlights je Ort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every place gets at most five highlights per category (ranked by a comparable importance 1–5 within a reach that depends on importance) and a level `none | some | many` per category; only selected POIs are consolidated, deduplicated, reviewed and delivered.

**Architecture:** POIs stay `geo_objects` of type `poi` (candidates). A pure selection in `lib/domain/highlights/` ranks the candidates around a place; the place's consolidation stores the result as profile attribute `derived.highlights` and in a working table `highlight_selections`. A new stage `consolidation.highlights` consolidates exactly the selected POIs after `consolidation.geo`; delivery reads the selections for `highlight.spotIds`, `spot.highlightIds` and the new `spot.highlightLevels`.

**Tech Stack:** Next.js 16, TypeScript, Drizzle ORM + SQL migrations, Postgres/PostGIS, pg-boss, zod, vitest against `periplus_test`.

**Spec:** `docs/superpowers/specs/2026-10-21-periplus-16-highlights-design.md`

## Global Constraints

- Code, identifiers, tables, contract: English; UI copy German („Highlights“, „nur das“, „einiges mehr“, „sehr viel mehr“, Kategorien wie `POI_CATEGORY_LABELS`).
- Domain logic only in `lib/domain` and `lib/pipeline`; pages, routes, job handlers stay thin.
- Thresholds, weights and lists in `config/`: `gazetteer.poiCoastDistanceKm` = 20; consolidation version `v2` with `importance.tagBonus` and `highlights.maxPerCategory` = 5, `highlights.reachKm` = `[1, 1, 5, 20, 20]` (index = importance − 1), `highlights.levelWeights` = `[0.005, 0.2, 1, 3, 6]`, `highlights.levelThresholds` = `[1, 6]` (start values, calibrated in Task 9), `highlights.textNameImportance` = 2.
- Level: weighted rest `< levelThresholds[0]` → `none`, `< levelThresholds[1]` → `some`, else `many`.
- Ranking: importance desc, score desc, distance asc, geo object id asc.
- Reach: straight-line distance from the place's anchor position, else its position.
- Candidates get importance only (no profile, no summary, no change events, no image); full POI consolidation only for selected POIs.
- Duplicates before ranking: same normalized name and same category under `validation.highlightDuplicateM` (500 m) count as one (higher importance, tie by id).
- Unassigned text names (in `highlight.<category>` facts of the place, not linked to a POI mention) count once per normalized name with `textNameImportance` in the level; a category with only such names still appears in the levels.
- Freshness: when a run touches a POI (mention, fact, new object), it re-selects every place within the largest reach (20 km) of it.
- No pair tasks POI ~ POI from the gazetteer; pair tasks only between selected highlights of the same category with similar, not equal names between 500 m and 2 km.
- Contract minor version `2.2`: new optional `spot.highlightLevels: Record<category, "none"|"some"|"many">`; highlight not selected is dropped with reason `not_selected`; `highlight.spotIds` = selecting spots by distance.
- Tests never call the network; committed geo rows lie outside 23.0–23.75 E × 37.0–38.0 N; every DB test in `withRollback`.
- Per task: `npx vitest run <touched tests>`, `npx tsc --noEmit -p .`, `npx eslint <touched files>` before the commit. Commit on branch `pruefung/echtdaten`.

## Review Focus

1. A place with zero candidates and zero text names gets no `derived.highlights` categories and an empty `highlightLevels` (no crash, no empty objects). Test in Task 3.
2. A POI selected by place A whose place B in the same subdivision is excluded or merged: B never appears in `spotIds`. Test in Task 7.
3. Two places 30 m apart select the same POI: it appears once in `highlights.json` with both spot ids ordered by distance. Test in Task 7.
4. A POI that was a delivered highlight and is no longer selected appears in the change feed as removed, keeps its `hl_` id, and re-appears with the same id when selected again. Test in Task 7.
5. A text run that adds a mention to a POI 15 km from a place (importance rises to 4) changes that place's selection in the same run. Test in Task 5.

---

### Task 1: Configuration

**Files:**
- Modify: `lib/config/schemas.ts` (gazetteer `poiCoastDistanceKm: z.number().positive()`; consolidation `importance.tagBonus: z.record(z.string(), z.number().nonnegative())`; new `highlights` object with the five keys of Global Constraints, `reachKm` and `levelWeights` length 5, `levelThresholds` length 2 ascending)
- Modify: `config/gazetteer.json` (`"poiCoastDistanceKm": 20`)
- Create: `config/consolidation/v2.json` (copy of v1 plus `importance.tagBonus` and `highlights`); Modify: `config/consolidation/active.json` → `{ "version": "v2" }`
- Test: `lib/config/__tests__/config.test.ts`

`tagBonus` keys are `"<osm key>=<value>"` or `"wikidata:<Qid>"`. Start: `historic=castle` 2, `historic=archaeological_site` 2, `historic=monastery` 1.5, `historic=ruins` 1, `tourism=museum` 1.5, `man_made=lighthouse` 1, `natural=cave_entrance` 1, `tourism=viewpoint` 0.5, `wikidata:Q839954` (archaeological site) 2, `wikidata:Q44613` (monastery) 1.5, `wikidata:Q33506` (museum) 1.5, `wikidata:Q39715` (lighthouse) 1.

- [ ] **Step 1: Failing tests** `consolidation v2 is active and has highlights` (asserts `maxPerCategory === 5`, `reachKm` equals `[1, 1, 5, 20, 20]`, `levelThresholds[0] < levelThresholds[1]`), `highlights rejects reachKm of length 4`, `gazetteer has poiCoastDistanceKm 20`.
- [ ] **Step 2: Run** `npx vitest run lib/config` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(config): consolidation v2 with highlight selection and tag bonus; POI coast distance (spec 16)`

### Task 2: Gazetteer – POIs near the sea, kept kinds, no POI pairs

**Files:**
- Create: `lib/domain/gazetteer/sea-distance.ts`
- Modify: `lib/pipeline/gazetteer/osm.ts` (`KEPT_TAGS` + `man_made`; skip POIs beyond the distance), `lib/pipeline/gazetteer/wikidata.ts` (POI: `tags.wikidata_class = <matched class Qid>`; skip beyond the distance; no `openPairTask` when both objects are `poi`)
- Create: `drizzle/0063_dismiss_poi_pair_tasks.sql` (custom migration, journal entry; dismiss open `place_candidate` tasks with `subject_type = 'geo_object_pair'` whose two objects are both `poi`, pattern of `0052`)
- Test: `lib/domain/gazetteer/__tests__/sea-distance.test.ts`, `lib/pipeline/__tests__/gazetteer-osm.test.ts`, `lib/pipeline/__tests__/gazetteer-wikidata.test.ts`

**Interfaces:**
- Produces: `nearSea(db: Db, points: Array<{ key: string; lon: number; lat: number }>, km: number): Promise<Set<string>>` – keys of points within `km` of an IHO sea (`geo_objects` type `sea`, origin `marine_regions`, valid). Uses a temp table of `ST_Subdivide(geom, 128)` pieces with a gist index inside a transaction (pattern of `setSubdivisions` in `lib/domain/gazetteer/hierarchy.ts`) and `ST_DWithin(::geography)` on the KNN-nearest pieces.

- [ ] **Step 1: Failing tests**
  - `nearSea keeps a point 15 km from the sea and drops one 25 km inland` (synthetic sea square and two points).
  - osm: `skips a POI farther than poiCoastDistanceKm from the sea, keeps a settlement rule unchanged`; `keeps man_made=lighthouse in tags`.
  - wikidata: `an uncertain match between two POIs opens no pair task`; `a wikidata POI stores its class as tags.wikidata_class`; `an uncertain match between two bays still opens a pair task`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** In `importOsm` and `importWikidata` call `nearSea` once per run on all POI candidates before the upsert loop.
- [ ] **Step 4: Run** the three test files and `npx vitest run lib/domain/gazetteer` → PASS. Run `npm run db:migrate` against `periplus_test` via the test setup (migrations apply in `test/setup`).
- [ ] **Step 5: Commit** `feat(gazetteer): POIs only near the sea, kinds for the importance bonus, no pair tasks between POIs (spec 16)`

### Task 3: Pure selection

**Files:**
- Create: `lib/domain/highlights/select.ts`
- Test: `lib/domain/highlights/__tests__/select.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HighlightLevel = "none" | "some" | "many";
  export type HighlightCandidate = { geoObjectId: string; category: PoiCategory; name: string | null; nameNormalized: string | null;
    importance: 1|2|3|4|5; score: number; distanceKm: number; lon: number; lat: number };
  export type TextName = { category: PoiCategory; nameNormalized: string };
  export type CategorySelection = { ids: string[]; level: HighlightLevel;
    candidates: Array<{ geoObjectId: string; importance: number; score: number; distanceKm: number }>; textNames: string[] };
  export function selectHighlights(candidates: HighlightCandidate[], textNames: TextName[], cfg: ConsolidationConfig["highlights"], duplicateM: number): Partial<Record<PoiCategory, CategorySelection>>;
  ```
  Candidates outside `reachKm[importance − 1]` are filtered here (the loader in Task 4 loads up to the largest reach). `candidates` in the result are those in reach after duplicate collapse (provenance). Duplicate distance via haversine on `lon/lat`.

- [ ] **Step 1: Failing tests** (values from the spec)
  - `island with one ruin`: one culture candidate importance 2 at 0.8 km → `{ culture: { ids: [ruin], level: "none" } }`.
  - `city with 300 culture candidates`: one importance 5 at 8 km, ten importance 3 at ≤ 4 km, 289 importance 1 at ≤ 0.9 km → `ids.length === 5`, `ids[0]` is the 5, level `many`.
  - `1000 importance-1 candidates alone are not many`: 1000 culture candidates importance 1 at 0.5 km → rest 995 × 0.005 = 4.975 → level `some`.
  - `ten importance-4 candidates are many`: ten culture candidates importance 4 at 10 km → five selected, rest 5 × 3 = 15 → `many`.
  - `reach`: importance 5 at 15 km is selected, importance 2 at 3 km is not.
  - `ties`: same importance → higher score first, then nearer, then smaller id.
  - `duplicates`: two candidates `nameNormalized` "kastro" 300 m apart, importance 3 and 2 → one id (the 3), counted once.
  - `text names`: no candidates, two text names in `food` with the same normalized name → `{ food: { ids: [], level: "none", textNames: ["taverna x"] } }` with `textNameImportance` weight counted once.
  - `empty`: no candidates, no names → `{}`.
- [ ] **Step 2–4: Run → FAIL, implement, run → PASS.**
- [ ] **Step 5: Commit** `feat(highlights): select at most five highlights per category with level (spec 16)`

### Task 4: Candidate loader and importance with kinds

**Files:**
- Modify: `lib/domain/consolidation/derived/importance.ts` (`ImportanceInput` gains `kinds: string[]`; score adds the largest `tagBonus` of the kinds)
- Create: `lib/domain/highlights/candidates.ts`
- Test: `lib/domain/consolidation/derived/__tests__/importance.test.ts`, `lib/domain/highlights/__tests__/candidates.test.ts`

**Interfaces:**
- Produces: `poiKinds(tags: Record<string, unknown>): string[]` (in `candidates.ts`; `"<key>=<value>"` for `historic`, `tourism`, `man_made`, `natural`, `amenity`, plus `"wikidata:<tags.wikidata_class>"`).
- Produces: `loadHighlightCandidates(db: Db, placeGeoObjectId: string, cfg: ConsolidationConfig, today: string): Promise<{ candidates: HighlightCandidate[]; textNames: TextName[] }>` – valid, unmerged, categorised POIs within `max(highlights.reachKm)` of the place's anchor (else position), with importance from `importanceOf` (sources = counting sources of their mentions, sitelinks from `wikidata_sitelinks`, kinds); text names = normalized names of the place's active `highlight.<category>` facts that no mention of a POI in reach carries (`matchPoi` links names to POI mentions at extraction). One SQL for the candidates (index-friendly: `ST_DWithin(::geography)` after a bbox `&&`), one for sources and sitelinks of all candidate ids, one for the facts.
- Consumes: `HighlightCandidate`, `TextName` (Task 3), `countingSourceSql` (inputs.ts).

- [ ] **Step 1: Failing tests**
  - importance: `castle tag adds its bonus`, `the largest bonus of several kinds counts once`, `wikidata class bonus applies`.
  - loader: `loads POIs within 20 km with importance, not one at 21 km`; `a name linked to a POI mention is not a text name, an unlinked one is`; `merged and ended POIs are left out`.
- [ ] **Step 2–4.** Existing callers of `importanceOf` pass `kinds` from the POI's tags (`loadDerivedInputs`).
- [ ] **Step 5: Commit** `feat(highlights): candidate loader with importance from sources, sitelinks and kinds (spec 16)`

### Task 5: Place consolidation stores the selection

**Files:**
- Modify: `lib/db/schema/profiles.ts` (table `highlight_selections`: `place_geo_object_id uuid`, `poi_geo_object_id uuid`, `category poi_category`, `rank int`, `distance_km real`, `profile_version int`; PK (`place_geo_object_id`, `poi_geo_object_id`); index on `poi_geo_object_id`), generated migration `drizzle/0064_*.sql`
- Modify: `lib/domain/consolidation/inputs.ts` (`DerivedInputs.highlights` for level `place` via `loadHighlightCandidates`), `lib/domain/consolidation/build.ts` (set `derived.highlights` = `{ <category>: { ids: <geo object ids in rank order>, level } }`; provenance carries the `CategorySelection` provenance), `lib/domain/consolidation/store.ts` (when a place profile is stored, replace its rows in `highlight_selections`; when a place ends or is merged, delete its rows)
- Modify: `lib/domain/consolidation/targets.ts` (POI targets are replaced by the geo objects of confirmed or candidate places within `max(reachKm)` of them; POIs themselves leave the geo stage)
- Test: `lib/domain/consolidation/__tests__/build.test.ts`, `lib/domain/consolidation/__tests__/targets.test.ts`, `lib/domain/consolidation/__tests__/store.test.ts`

**Interfaces:**
- Produces: profile attribute `derived.highlights: Partial<Record<PoiCategory, { ids: string[]; level: HighlightLevel }>>`; table `highlight_selections` as above; `selectedPoiIds(db: Db, placeGeoObjectIds: string[]): Promise<string[]>` in `lib/domain/highlights/selections.ts`.

- [ ] **Step 1: Failing tests**
  - build: `place profile gets derived.highlights with ids and level`; `place without candidates has no derived.highlights`.
  - store: `storing a place profile replaces its highlight_selections rows`; `a merged place has no selection rows`.
  - targets: `a text run with a mention on a POI targets the places within 20 km, not the POI` (Review Focus 5); `a tile run excludes POIs`.
- [ ] **Step 2–4.**
- [ ] **Step 5: Commit** `feat(consolidation): places select their highlights and store them (spec 16)`

### Task 6: Stage `consolidation.highlights` and pair tasks among highlights

**Files:**
- Create: `lib/pipeline/consolidation/highlights.ts`
- Modify: `lib/pipeline/consolidation/stages.ts` (`CONSOLIDATION_HIGHLIGHTS_STAGE = "consolidation.highlights"`, inserted after `CONSOLIDATION_GEO_STAGE` in `CONSOLIDATION_STAGES` and `GEOMETRY_CONSOLIDATION_STAGES`), `lib/jobs/{stages,queues,registry}.ts`, `config/queues.json` (same settings as `consolidation.geo`), `lib/pipeline/consolidation/summary.ts` (`summaryTargets` includes the POIs this stage consolidated), `app/(admin)/_components/labels.ts` (stage label „Highlights konsolidieren“)
- Test: `lib/pipeline/__tests__/consolidation-highlights.test.ts`

**Interfaces:**
- Consumes: `selectedPoiIds` (Task 5), `consolidateGeoJob` (`lib/pipeline/consolidation/geo.ts`), `openPairTask` (`lib/domain/gazetteer/merge.ts`).
- Produces: `consolidationHighlightJobs(db, run): Promise<JobData[]>` = one job per POI selected by the places the geo stage consolidated in this run; `openHighlightPairTasks(db: Db, poiIds: string[]): Promise<number>` – for each pair of selected highlights of the same category with trigram similarity ≥ `gazetteer.merge` uncertain threshold, different normalized names, distance 500–2000 m.

- [ ] **Step 1: Failing tests** `the stage consolidates exactly the POIs selected by the run's places`; `an unselected POI gets no profile`; `two selected highlights 'Kastro Poros' and 'Kastro Porou' 800 m apart get a pair task, two unselected do not`; `text, geometry and consolidateAfter runs list consolidation.highlights after consolidation.geo`.
- [ ] **Step 2–4.**
- [ ] **Step 5: Commit** `feat(consolidation): stage consolidation.highlights for selected POIs, pair tasks among highlights (spec 16)`

### Task 7: Contract 2.2 and delivery

**Files:**
- Modify: `contract/v2/spot.ts` (`highlightLevels: z.partialRecord(highlightCategory, z.enum(["none","some","many"])).optional()`), `contract/v2/manifest.ts` + `contract/index.ts` (`"2.2"`), `contract/schema/published.ts` + generated `contract/schema/2.2/*.schema.json`, `config/delivery.json` (`schemaVersion`)
- Modify: `lib/domain/delivery/load.ts` (`loadPoiRows`: only POIs in `highlight_selections` of the subdivision's places; `PoiSource.selectedBy: Array<{ placeGeoObjectId: string; distanceKm: number }>`), `lib/domain/delivery/map-highlight.ts` (spotIds = delivered, unmerged, not excluded selecting spots by distance, at most `maxSpotIds`; reason `not_selected` replaces `no_spot_in_radius`; `ctx.radiusNm` removed), `lib/domain/delivery/map-spot.ts` (`highlightLevels` from the place profile's `derived.highlights`, categories sorted), `lib/domain/delivery/validate.ts` (`highlight_radius` → `highlight_selected`: every spotId selects the highlight), `lib/domain/delivery/changes.ts` (`FIELD_LABELS_DE.highlightLevels = "Highlight-Stufen"`)
- Test: `lib/domain/delivery/__tests__/map-highlight.test.ts`, `…/map-spot.test.ts`, `…/validate.test.ts`, `contract/__tests__/contract.test.ts`, `app/__tests__/api-package.test.ts`

- [ ] **Step 1: Failing tests** `highlight spotIds are the selecting spots by distance`; `excluded or merged selecting spot is left out` (Review Focus 2); `two spots 30 m apart selecting one POI → one highlight with both ids` (Review Focus 3); `unselected POI is dropped with not_selected`; `spot.highlightLevels maps derived.highlights`; `empty derived.highlights → no highlightLevels` (Review Focus 1); `a no longer selected highlight is removed in the change feed and returns with the same hl_ id` (Review Focus 4); contract `2.2 validates highlightLevels`.
- [ ] **Step 2–4.** `npm run contract:generate` regenerates the JSON schemas; `npm run db:generate` is not needed here.
- [ ] **Step 5: Commit** `feat(delivery): contract 2.2 with spot.highlightLevels; highlights by selection (spec 16)`

### Task 8: Admin UI

**Files:**
- Create: `app/(admin)/places/[id]/highlights-panel.tsx`; Modify: `app/(admin)/places/[id]/page.tsx` (panel in the overview below Eckdaten), `lib/domain/highlights/view.ts` (`placeHighlightsView(db, placeGeoObjectId): Promise<Array<{ category; label; level; levelLabel; highlights: Array<{ geoObjectId; name; importance; distanceKm }>; others: number }>>` from the profile attribute and its provenance)
- Modify: `lib/domain/map-data.ts` + `app/(admin)/_components/map-view.tsx` (geo-object type filter „Highlight“ shows only POIs in `highlight_selections`; a toggle „alle POI-Kandidaten“ shows the rest)
- Test: `lib/domain/highlights/__tests__/view.test.ts`, `lib/domain/__tests__/map-data.test.ts`

Level labels: `none` „nur das“, `some` „einiges mehr“, `many` „sehr viel mehr“. Each highlight links to `/geo/<id>`; `others` is the number of candidates in reach beyond the five („und 12 weitere Kandidaten“, internal).

- [ ] **Step 1–4** (view test: categories in `POI_CATEGORY_LABELS` order, highlights by rank; map-data test: only selected POIs by default).
- [ ] **Step 5: Commit** `feat(admin): highlights per category on the place page; map shows selected highlights (spec 16)`

### Task 9: Calibration, docs, full check

**Files:**
- Modify: `config/consolidation/v2.json` (`levelThresholds`, `tagBonus` after calibration), `docs/runbook.md` (section Highlights: selection, levels, stage), `docs/superpowers/specs/2026-10-18-periplus-design.md` (Abschnitt 4 deviations of spec 16, Abschnitt 11 plan link), `docs/superpowers/specs/2026-10-21-periplus-16-highlights-design.md` (calibrated start values)
- Create: `lib/domain/highlights/__tests__/calibration.test.ts` (fixture: Agistri-like, Poros-like, Athens-like candidate sets built synthetically outside the pilot box, asserting levels `none`, `some`, `many` for culture)

- [ ] **Step 1:** Write the calibration test with the three fixtures; choose `levelThresholds` so it passes; record the values.
- [ ] **Step 2:** `npx vitest run`, `npm run lint`, `npm run build` → all green.
- [ ] **Step 3: Commit** `docs: highlights per place in runbook and design; calibrated levels (spec 16)`

### Task 10: Reset and restart the check (operations, no code)

- [ ] Stop worker and dev server of the check worktree.
- [ ] Wipe the dev database `periplus` except `users` (and `drizzle` migrations): `TRUNCATE` every table of schema `public` but `users`, `CASCADE`; clear the `pgboss` schema jobs. S3 archives stay (archive-first; Overpass answers are reused only by date).
- [ ] `npm run db:migrate`; start worker and web; continue with Teil-Spec 12 from P0 (protocols P0–P2 are rewritten; findings B1–B13 stay with their status).
