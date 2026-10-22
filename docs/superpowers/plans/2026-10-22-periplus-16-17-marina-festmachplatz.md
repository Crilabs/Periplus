# Periplus 16 + 17 – Marina-Websites, Festmachplatz, Auslieferung nach Beleg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Places are confirmed (and thus delivered and imaged) by evidence instead of by hand: anchorages and mooring fields by text evidence, marinas by their own website (found via OSM, Wikidata or Google search and read by the AI) or text evidence; spots carry `berthable` and `contact` (contract 2.2); fact schema v3 sharpens fuel/water and adds `berthable` and `place.kind_evidence`; highlight categories lose fuel stations, pharmacies, ATMs, taps and dive shops.

**Architecture:** Website addresses are collected per place in an append-only `place_websites` table (OSM tags, Wikidata P856, or a SERP hit the AI accepted) and become an approved source of origin `place_website`; pages under a bound start URL get `bound` mentions on every chunk so the whole page is extracted for that place. The confirmation rule runs inside `consolidateGeo` before `buildProfile`: it reads the place's active-run inputs and route stops, decides confirm / no_anchoring / kind switch, records a `system` decision and updates the place in the same transaction. Delivery and images keep their status gate (`delivery.spots.statuses`).

**Tech Stack:** Next.js 16 (App Router, server actions), TypeScript, Drizzle + SQL migrations, Postgres/PostGIS, pg-boss, zod 4, vitest against real Postgres, MockModel, DataForSEO via the existing adapter.

**Spec:** `docs/superpowers/specs/2026-10-21-periplus-16-marina-services-design.md` (Teil A–C, revised 22.10.) and `docs/superpowers/specs/2026-10-22-periplus-17-festmachplatz-auslieferung-design.md`. Both go live together, including reprocessing every subdivision with fact schema v3 (Christian, 22.10.2026).

## Global Constraints

- Code, identifiers, tables, API, prompts: English. UI copy: German („Festmachplatz“, „Automatisch bestätigt“, „Marina-Websites suchen“).
- Domain logic only in `lib/domain` and `lib/pipeline`; pages, actions, handlers, scripts stay thin.
- Thresholds, templates, source-type lists, tag lists: `config/` (`delivery.json` › `confirmation`, `discovery.json` › `placeWebsite`, `gazetteer.json` › `commercialHarbourTags`), never in code.
- No fact without a verbatim quote; a missing quote never yields `false`. Append-only tables (`place_websites`, `review_decisions`, `mentions`, `facts`, `document_versions`, `*_history`) are never updated or deleted.
- Admin decisions win: `rejected`, `no_anchoring` and an admin-chosen kind are never overridden by evidence. A confirmed place is never un-confirmed by losing evidence.
- Automatic decisions: `review_decisions.decided_by = 'system'`, decision payload carries `auto: true`, `rule` and the evidence ids.
- External services only via adapters (`searchOrganic`, `fetchFollowing`, `model.call`); tests never call the network; AI via `MockModel`.
- Tests against real Postgres in a worktree DB (`periplus_fm_test`, set in the skip-worktree `vitest.config.mts`, never committed), each in `withRollback`; committed geo rows outside 23.0–23.75 E × 37.0–38.0 N.
- Work in worktree `.claude/worktrees/festmachplatz` on branch `feat/festmachplatz-marina` (already exists, carries the two specs); never commit to `main`, never push.
- Per task: `npx vitest run <touched tests>`, then `npm run typecheck` and `npm run lint` before the commit. Migrations: `npm run db:generate` (schema) or `npx drizzle-kit generate --custom --name <name>` (enum values, data); next free number **0063**. Migrations stay compatible with the previous release (`docs/runbook.md` › Rollback).
- Before touching routes or actions: read the Next 16 docs in `node_modules/next/dist/docs/`.

## Deviations from the specs (decided here, flag in the PR)

1. Spec 16 „Bestand aus archivierten Overpass-Antworten nachtragen“ → the rollout reruns `gazetteer.osm` and `gazetteer.wikidata` per subdivision instead (free, rate-limited, no archive listing needed; the S3 adapter has no `list`).
2. Spec 17 „Ortsart-Wechsel als neue Zeile oder Update“ → update in place; `places_history` already records `kind` changes (trigger `places_record_history`).
3. Spec 17 „Routen-Stopp eines Törnberichts“ counts only when its mention's (version, geo object) has an active extraction run (`activeExtractionRunIdSql`), so nothing confirms on v2 leftovers before the subdivision is reprocessed. This replaces a per-subdivision switch for „erst nach dem Reprozessieren“.
4. Images: `eligibleSpots` additionally requires `public_id is not null`, so images follow delivery exactly (today a seed-excluded place without public id gets an image but is not delivered).

## Review Focus

1. A SERP hit for the neighbour marina („Marina Poros“ when searching „Poros town quay“) or a charter company: the AI rejects it, no source and no binding are created, and the place stays a candidate. Test in Task 4.
2. One municipality homepage named as website by three harbours: no binding for any of them; a `berthable` fact from that page confirms none of them. Tests in Tasks 4 and 6.
3. A place whose only evidence is two trip reports on the same domain, or a mention without an anchoring fact („we sailed past X“): stays a candidate. Test in Task 6.
4. A candidate with an open `geo_object_pair` task (also when it is the larger id in `subject_id`): not confirmed until the pair is decided. Test in Task 6.
5. Switch to v3 before a subdivision is reprocessed: no place there is auto-confirmed from v2 facts or route stops, already confirmed places stay delivered, and `berthable` is derived (`true`/`false`) rather than missing. Tests in Tasks 6 and 7.

---

### Task 1: Highlight categories cleanup (spec 16 Teil A)

**Files:**
- Modify: `config/categories.json` (`supply` = `shop: [supermarket, convenience]`; drop the `amenity` fuel/pharmacy/atm/drinking_water rule, `shop=scuba_diving`, `bakery`, `butcher`; `active` = `tourism=viewpoint`), `lib/domain/gazetteer/osm-classify.ts` (export `categoryForTags`), `contract/v2/spot.ts` (`.describe()` of `services.shop`: „Supermarket or mini market nearby or by text“)
- Create: `lib/domain/gazetteer/poi-reclassify.ts`, `scripts/reclassify-pois.ts`, `package.json` script `"pois:reclassify": "tsx --env-file-if-exists=.env.local scripts/reclassify-pois.ts"`
- Test: `lib/domain/gazetteer/__tests__/osm-classify.test.ts`, `lib/domain/gazetteer/__tests__/poi-reclassify.test.ts`, `lib/domain/delivery/__tests__/map-spot.test.ts`

**Interfaces:**
- Produces: `categoryForTags(tags: Record<string, string>, categories: CategoriesConfig): PoiCategory | null` – the rule loop of `classifyOsm` without the name check; `classifyOsm` uses it.
- Produces: `reclassifyPois(db: Db, categories: CategoriesConfig, opts?: { dryRun?: boolean }): Promise<{ cleared: number; changed: number; geoObjectIds: string[] }>` – only valid, unmerged `type='poi'` rows with `origin='osm'` and non-empty `tags` (Wikidata/review POIs have no tags); sets `category = categoryForTags(tags)` where it differs; returns the ids of the places within `poiRadiusM` of a changed POI for re-consolidation. Script: `--dry-run`, prints counts, then starts nothing (rollout reruns consolidation).

- [ ] **Step 1: Failing tests:** `categoryForTags`: `amenity=fuel` → null, `shop=convenience` → supply, `shop=bakery` → null, `shop=scuba_diving` → null, `amenity=restaurant` → food; `reclassifyPois`: fuel station and pharmacy POIs lose their category, supermarket keeps supply, a POI tagged `amenity=fuel` + `shop=convenience` becomes supply, a Wikidata POI with empty tags is untouched, second call changes nothing; `services.shop is unknown when only a fuel station is nearby` (after reconsolidation via fixtures).
- [ ] **Step 2: Run** `npx vitest run lib/domain/gazetteer lib/domain/delivery/__tests__/map-spot.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(gazetteer): highlight categories for trip planning only, reclassify stored POIs (spec 16 A)`.

### Task 2: Website addresses from OSM and Wikidata, `place_websites`

**Files:**
- Modify: `lib/pipeline/gazetteer/osm.ts` (`KEPT_TAGS` + `website`, `contact:website`, `harbour:category`), `lib/adapters/wikidata.ts` (`OPTIONAL { ?item wdt:P856 ?website }`, `WikidataItem.website?: string`), `lib/pipeline/gazetteer/wikidata.ts` (writes `geo_objects.website_wikidata` on link/create), `lib/db/schema/geo.ts` (column `website_wikidata text`), `lib/db/schema/sources.ts` (table `place_websites`, enum `place_website_origin`; `source_origin` + `place_website`; `serp_level` + `place_website`), `app/(admin)/_components/labels.ts` (`SOURCE_ORIGIN_LABELS.place_website = "Website des Ortes"`)
- Create: `lib/domain/places/websites.ts`, migrations `0063_place_websites.sql` (generated), `0064_place_websites_enums.sql` (`--custom`: enum `ADD VALUE`s, append-only trigger on `place_websites`, `_no_truncate`)
- Test: `lib/db/__tests__/place-websites-schema.test.ts`, `lib/domain/places/__tests__/websites.test.ts`, `lib/adapters/__tests__/wikidata.test.ts`, `lib/pipeline/__tests__/gazetteer-osm.test.ts`

**Interfaces:**
- `place_websites`: `id uuid pk`, `place_id → places not null`, `geo_object_id → geo_objects not null`, `url text not null`, `url_normalized text not null`, `origin place_website_origin ('osm'|'wikidata'|'serp') not null`, `serp_query_id → serp_queries null`, `quote text null`, `confidence real null`, `source_id → sources null`, `bound boolean not null`, `run_id → runs null`, `created_at`. Index `(place_id, created_at desc)`, `url_normalized`. Append-only. Current website of a place = newest row.
- Produces: `knownWebsites(geo: { tags: Record<string, string>; websiteWikidata: string | null }): Array<{ url: string; origin: "osm" | "wikidata" }>` – order `website`, `contact:website`, Wikidata; only `http(s)`; drops `isForbiddenUrl` (delivery `forbiddenDomains`) and `discovery.proposals.ignoreDomains` (export the existing `ignored()` from `proposals.ts` as `isIgnoredDomain(domain, cfg)`).
- Produces: `currentPlaceWebsite(db, placeId): Promise<PlaceWebsiteRow | null>`.

- [ ] **Step 1: Failing tests:** OSM fixture with `website` keeps it in `tags`; Wikidata fold returns P856; `knownWebsites` order and filtering (facebook.com, booking.com, google.* dropped, `ftp:` dropped); `place_websites` rejects UPDATE/DELETE; enum values `place_website` accepted for `source_origin` and `serp_level`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(places): website addresses from OSM and Wikidata, place_websites table (spec 16 C)`.

### Task 3: Fact schema v3 and extraction prompt v6

**Files:**
- Create: `config/fact-schema/v3.ts`, `config/prompts/extract-facts/v6.md`
- Modify: `config/fact-schema/v2.ts` (export `textOnly`, no other change), `config/fact-schema/index.ts` (register v3), `config/fact-schema/active.json` (`v3`), `config/models.json` (`extract-facts.promptVersion: 6`), `config/consolidation/v1.json` (`gaps.ignore`: `place.kind_evidence` for every kind; `berthable` nowhere), `lib/domain/facts/labels.ts` (`berthable` „Festmachplatz“, `place.kind_evidence` „Ortsart laut Quelle“), `lib/ai/tasks/extract-facts.ts` (variable `bound_note`), tests pinning `"v2"` (`lib/domain/facts/__tests__/schema.test.ts`, `schema-v2.test.ts` → keep v2 tests by explicit version, add `schema-v3.test.ts`)
- Test: `lib/domain/facts/__tests__/schema-v3.test.ts`, `app/(admin)/__tests__/fact-labels.test.ts`, `lib/ai/__tests__/extract-facts.test.ts`

**Interfaces:**
- v3 = v2 with, on level `place`:
  - `services.fuel` description: „Whether the place itself offers refuelling (diesel) for boats: a fuel dock or a tanker truck at the quay. A petrol station in town does not count.“
  - `services.water` description: „Whether fresh water can be taken on at the berth or quay of the place (tap, hose, water connection). A fountain or tap in the village does not count.“
  - `textOnly("berthable", z.boolean(), "latest_observation", <spec 17 text verbatim>)`
  - `textOnly("place.kind_evidence", z.enum(["anchorage","port","marina","mooring_field"]), "latest_observation", "What kind of place this is: marina = leisure harbour where pleasure boats berth, including a town quay where yachts moor stern-to; anchorage = place to anchor; mooring_field = buoys a visiting boat can pick up; port = commercial or industrial harbour (ferries, cargo, fishing, shipyard) without berths for pleasure boats")`
  - all other defs identical (assert by key/rule/description diff in the test).
- Prompt v6 = v5 plus one line after the „Only facts about the named object“ rule: `{{bound_note}}`; `bound_note` = „This text is the object's own website: statements about "our marina", "the marina" or "the harbour" are about the object.“ when the unit has a `bound` mention (Task 5), else empty. `ExtractFactsInput` gains `boundToWebsite: boolean`.

- [ ] **Step 1: Failing tests:** v3 differs from v2 exactly in `services.fuel`, `services.water` descriptions and the two new keys; `attributesForPrompt("place","v3")` contains „A petrol station in town does not count“; every v3 key has a German label; prompt renders `bound_note` only when `boundToWebsite`; config loads with active v3 (`checkUnionKeys` passes).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run lib/domain/facts lib/ai app/(admin)/__tests__/fact-labels.test.ts lib/config` → PASS; then the full suite `npx vitest run` (v3 active must not break consolidation fixtures; fix fixtures that hardcode v2 by pinning their version, not by changing assertions); typecheck, lint.
- [ ] **Step 5: Commit** `feat(facts): fact schema v3 with berthable, kind evidence and sharpened fuel/water, extract-facts prompt v6 (specs 16 B, 17)`.

### Task 4: Find and approve marina websites (stage `places.website`)

**Files:**
- Create: `lib/domain/places/website-find.ts`, `lib/domain/places/website-source.ts`, `lib/ai/tasks/check-place-website.ts`, `config/prompts/check-place-website/v1.md`, `lib/pipeline/places/website-stage.ts`, `lib/pipeline/places/stage-name.ts`, `lib/pipeline/place-website-run.ts`, `lib/jobs/handlers/place-website.ts`
- Modify: `config/discovery.json` + `discoverySchema` (`placeWebsite: { templates: [{ template: "{name} marina", lang: "en", locationCode: 2826 }, { template: "{name} {island} marina", lang: "en", locationCode: 2826 }, { template: "μαρίνα {name}", lang: "el", locationCode: 2300 }], maxResults: 5, retryDays: 180, minConfidence: 0.8, crawl: { maxDepth: 2, maxPagesPerStartUrl: 30 } }`), `config/models.json` (`check-place-website`: `claude-haiku-5-5`, promptVersion 1, effort low, maxTokens 512), `lib/domain/discovery/proposals.ts` (`domainCandidates` ignores `serp_queries.level = 'place_website'`), `lib/jobs/{stages,queues,registry}.ts`, `config/queues.json`, `lib/pipeline/subdivision-build.ts` (`places.website` right after `seed.tile`), `app/(admin)/runs/page.tsx` + `actions.ts` (button „Marina-Websites suchen“, `startPlaceWebsiteAction`), labels (stage label)
- Test: `lib/domain/places/__tests__/website-find.test.ts`, `lib/domain/places/__tests__/website-source.test.ts`, `lib/pipeline/__tests__/place-website-run.test.ts`, `lib/domain/__tests__/proposals.test.ts`, `app/(admin)/__tests__/place-website-action.test.ts`

**Interfaces:**
- Consumes: `knownWebsites`, `currentPlaceWebsite` (Task 2); `searchOrganic`/`runQuery` (level `place_website`, `scopeId` = geo object id, `tileId` = place tile); `fetchFollowing` + `decodeHtml` + `htmlToMarkdown` with a synthetic `Source` (`DEFAULT_CRAWL_RULES`, hit domain) as in `compareSample`.
- `checkPlaceWebsiteTask`: input `{ names: string[]; island: string | null; kindProposal: PlaceKind; lat: number; lon: number; url: string; pageText: string /* ≤ 6000 chars */ }`, output `{ isOwnSite: boolean; quote: string; confidence: number }`. Accept only `isOwnSite && confidence ≥ minConfidence && quote` found verbatim (normalised) in `pageText` and containing one of `names` (normalised).
- `placesNeedingWebsite(db, subdivisionKey): Promise<Array<{ placeId; geoObjectId }>>` – valid, unmerged places of kind `marina`/`port`, status `candidate`/`confirmed`, without a `place_websites` row.
- `findPlaceWebsite(db, place: { placeId; geoObjectId }, deps: { transport; archive; model }, ctx: { runId; tileId }): Promise<{ outcome: "known" | "serp" | "none" | "searched_recently"; url?: string }>` – known website first (no SERP, no AI); else, unless a `place_website` SERP query for this geo object is younger than `retryDays`, run the templates, take up to `maxResults` hits outside forbidden/ignored domains and outside domains of approved sources whose type is not `marina`, check them in rank order, first accepted wins.
- `attachPlaceWebsite(tx, input: { placeId; geoObjectId; url; origin: "osm" | "wikidata" | "serp"; serpQueryId?; quote?; confidence?; runId }, cfg): Promise<{ sourceId: string | null; bound: boolean }>` – writes the `place_websites` row; source by registrable domain: none → create approved source (`origin 'place_website'`, type `marina`, weight from `source-types.json`, `crawlRules.startUrls = [url]`, `maxDepth 2`, `maxPages 30`); `approved` → add start URL, `maxPages += 30`, keep type/weight; `proposed` → approve via `decideReviewTask` with `decidedBy: "system"` and the proposed settings, then add start URL; `paused`/`rejected` → no source, `bound = false`. `bound = false` also when another current `place_websites` row of a different place has the same `url_normalized` (then set the other place's binding off too by a new row with `bound = false`, Review Focus 2) or when `suggestType([url], proposals)` is `authority` (then type stays as is and no `marina` source is created).
- Stage `places.website` (one job per place, queue `places-website`), plan = `placesNeedingWebsite`; after all jobs, the run's `params.sourceIds` gets the touched source ids (pattern `freezeRevisitRun`).
- `startPlaceWebsiteRun(db, boss, { subdivisionKey }, triggeredBy): Promise<{ id: string }>` – kind `stage`, scope subdivision, stages `["places.website", ...FETCH_RUN_STAGES, ...TEXT_RUN_STAGES]` with `params.pending = true`; `startExclusiveFetchRun` semantics.

- [ ] **Step 1: Failing tests (DataForSEO fixture transport, MockModel):** known OSM website → `known`, no SERP call (count `external_calls`); no website → SERP, neighbour-marina hit rejected by the mock (`isOwnSite:false`), second hit accepted → `serp` with quote (Review Focus 1); accepted but quote not in page text → rejected; nothing accepted → `none`, no review task, a second call within 180 days → `searched_recently` without SERP; rejected place not listed by `placesNeedingWebsite`; `attachPlaceWebsite` for new domain / approved domain (start URL added, `maxPages` +30, type kept) / proposed domain (approved, task decided by `system`) / rejected domain (no source); same URL for two places → both `bound = false` (Review Focus 2); `domainCandidates` ignores `place_website` SERP results; build stage order has `places.website` after `seed.tile`; action requires admin and redirects to `/runs`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(places): find marina websites via OSM, Wikidata or Google search with AI check, approve them as sources (spec 16 C)`.

### Task 5: Bound mentions for place websites

**Files:**
- Modify: `lib/db/schema/text.ts` (`match_kind` + `bound`), migration `0065_match_kind_bound.sql` (`--custom`), `lib/pipeline/text/mentions.ts` (`matchVersion` adds bound mentions after `storeSureMentions`, same transaction), `lib/domain/extraction/units.ts` (a unit with a `bound` mention takes every chunk of the version, split into parts of `maxChunksPerUnit`), `lib/pipeline/text/extract.ts` (`unitInputs` sets `boundToWebsite`), `lib/domain/text-annotations.ts` + `app/(admin)/documents/[id]/page.tsx` (bound mentions as a line „An Ort gebunden: <Name> (Website des Ortes)“ above the text, not as inline span), labels (`MATCH_KIND_LABELS.bound = "Website des Ortes"`)
- Create: `lib/domain/mentions/bound.ts`
- Test: `lib/domain/mentions/__tests__/bound.test.ts`, `lib/pipeline/__tests__/mentions.test.ts`, `lib/domain/extraction/__tests__/units.test.ts`

**Interfaces:**
- Consumes: `place_websites` (Task 2), `bound` flag.
- `boundGeoObjectFor(db, urlNormalized: string): Promise<string | null>` – the geo object of the place whose current `place_websites` row has `bound = true` and whose start URL is the longest prefix of `urlNormalized` (path prefix on the same host); null if none, if two places tie, or if the place is rejected; follows `merged_into_id` to the surviving place.
- Bound mention per chunk: `char_start = 0`, `char_end = 0`, `surface = ''`, `confidence = 1`, `match_kind = 'bound'`, `type_hint = null`; `onConflictDoNothing`.

- [ ] **Step 1: Failing tests:** page under a bound start URL without the marina's name → one bound mention per chunk and one unit covering all chunks (two parts for 8 chunks with `maxChunksPerUnit` 6); page of a chain under the other place's start URL → bound to that place; URL used by two places (`bound = false`) → no bound mention; rematch is idempotent; bound and name mention of the same object share one unit group; `unitInputs` sets `boundToWebsite` true only for such units.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(mentions): pages of a place's own website are bound to the place and extracted whole (spec 16 C)`.

### Task 6: Confirmation by evidence (spec 17)

**Files:**
- Create: `lib/domain/places/evidence.ts`, `lib/domain/places/auto-status.ts`
- Modify: `config/delivery.json` + `deliverySchema` (`confirmation`, below), `config/gazetteer.json` + schema (`commercialHarbourTags: { "harbour:category": ["ferry","fishing","industrial","cargo","container","naval"], "seamark:harbour:category": ["fishing","ferry_terminal","container","bulk","tanker","roro","naval"] }`), `lib/domain/consolidation/store.ts` (call `applyAutoStatus` after `loadDerivedInputs`, before `buildProfile`, `mode === "regular"` only; reload `context.place` from its result), `lib/domain/consolidation/task-locks.ts` (`dismissTasks` reason + `"auto_confirmed"`), `lib/domain/quality/metrics.ts` (`PSEUDO_TASK_SUBJECT_TYPES` + `place_kind`)
- Test: `lib/domain/places/__tests__/evidence.test.ts`, `lib/domain/places/__tests__/auto-status.test.ts`, `lib/domain/consolidation/__tests__/store.test.ts`

**Interfaces:**
- `config/delivery.json` › `confirmation`: `{ "aloneTypes": ["pilot_guide","authority"], "pairTypes": ["trip_report","forum","travel_guide","other"], "pairMinDomains": 2, "ownSiteTypes": ["marina"], "berthAttributes": ["berthable","mooring.types","mooring.buoys","mooring.line_ashore_required","anchoring.*","bottom","shelter.*","depth.*"], "routeStops": true }` – `anchoring.*` etc. are prefixes; the executor lists the exact v3 keys that exist (no key that is not in v3).
- `Evidence = { rule: "alone" | "pair" | "own_website" | "commercial_port" | "osm_commercial"; factIds: string[]; documentIds: string[]; routeStopIds: string[] }`.
- `berthEvidence(tx, input: { geoObjectId; placeId; kind: PlaceKind; tags: Record<string,string> }, inputs: ConsolidationInput[], cfg: AppConfig): Promise<Evidence | null>`:
  - berth inputs = `origin 'text'`, attribute matches `berthAttributes`, `berthable` only when `value === true`; plus route stops of the geo object whose mention's (version, geo object) has an active extraction run (deviation 3).
  - `alone`: one berth input with `sourceType ∈ aloneTypes`; `pair`: berth inputs from ≥ `pairMinDomains` distinct `sourceKey`s with `sourceType ∈ pairTypes ∪ aloneTypes`; `own_website` (kind `marina` only): a `berthable === true` input whose mention is `bound` to this place; `commercial_port` (kind `port`): `place.kind_evidence === 'port'` or `berthable === false` text input; `osm_commercial` (kind `port`): a tag in `commercialHarbourTags` and no `leisure=marina`.
  - `marina` source type counts only through `own_website`, never for `alone`/`pair` (spec 17 table).
- `applyAutoStatus(tx, context: ProfileContext, inputs: ConsolidationInput[], cfg: AppConfig, now: Date): Promise<AutoStatusOutcome>` with `AutoStatusOutcome = { action: "none" | "confirmed" | "no_anchoring" | "kind_changed"; kind?: PlaceKind; evidence?: Evidence }`. Order:
  1. Only valid, unmerged places. Lock order: open place tasks (`lockOpenPlaceTasks`), then the place `FOR UPDATE` (the advisory profile lock is already held).
  2. Kind switch: if the consolidated `place.kind_evidence` (apply its rule to the inputs) differs from `places.kind` and the kind is not admin-locked (a decided `place_candidate` task of the place whose `confirm.kind` differs from its `context.kind`, or a `place_kind` decision not by `system`): update `kind`, record a decided pseudo task `{ kind: "place_candidate", subjectType: "place_kind", subjectId: placeId, context: { previous } }` with decision `{ action: "set_kind", kind, auto: true, factIds }`, `decided_by 'system'`.
  3. Confirmation only for `status = 'candidate'`, no open `geo_object_pair` task containing the geo object id on either side, and `berthEvidence` not null.
  4. `recheckExclusion` while still candidate; `excluded` → `no_anchoring` is set by it; then give the place a `sp_` public id so it is delivered, record decision `{ action: "no_anchoring", auto: true, rule, ... }`; else update `status 'confirmed'`, `statusReason null`, `publicId ?? newPublicId("sp")`, record pseudo task `subjectType 'place_status'` with decision `{ action: "confirm", auto: true, rule, factIds, documentIds, routeStopIds }`.
  5. Dismiss the place's open `place_candidate` tasks with `subject_type = 'place'` (reason `auto_confirmed`); pair tasks stay.
  - `rejected`, `no_anchoring`, `confirmed`, `abandoned` → no status change ever.

- [ ] **Step 1: Failing tests:** pilot-guide anchoring fact → confirmed with rule `alone`, decision by `system`, `sp_` id, open seed task dismissed `auto_confirmed`; one trip report → candidate; two trip reports on two domains → `pair`; two on one domain → candidate; mention without berth fact → candidate (Review Focus 3); route stop in an active run → counts, route stop whose unit only has a v2 run → does not (Review Focus 5); marina with bound-page `berthable: true` → `own_website`; same fact from an unbound municipality page → candidate (Review Focus 2); trip report „private moorings only“ (`berthable false`) on a mooring field → not confirmed by it; port with `place.kind_evidence port` → confirmed; OSM `harbour:category=fishing` port → `osm_commercial`; open pair task (geo object as larger id) → candidate (Review Focus 4); candidate inside a restricted area → `no_anchoring` with `sp_` id; rejected place with new evidence → unchanged; confirmed place whose only evidence document is `gone` → stays confirmed (Review Focus 5); seed marina with `kind_evidence port` → kind `port`, `place_kind` decision; admin-chosen kind (confirm kind ≠ context kind) → unchanged; `consolidateGeo` profile of an auto-confirmed place has `place.status confirmed` and emits `place_new` in the same run; evaluation mode changes nothing.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run lib/domain/places lib/domain/consolidation` → PASS; typecheck, lint.
- [ ] **Step 5: Commit** `feat(places): confirm places and correct their kind from evidence during consolidation (spec 17)`.

### Task 7: `berthable` derivation and contract 2.2

**Files:**
- Modify: `lib/domain/consolidation/build.ts` (derived `berthable` when no value: `no_anchoring` or kind `port` → `false`; confirmed `anchorage`/`marina`/`mooring_field` → `true`; else no value; origin `derived`), freeze `contract/v2` as `contract/v2_1/*` and register (`CONTRACT_SCHEMAS_V2_1`, `SCHEMAS_BY_VERSION`) as done for 2.0 in commit d98fb49; `contract/v2/spot.ts` (`berthable: z.boolean().nullable().describe("Charter crew can moor here on a short stay")`, `contact: z.strictObject({ vhf: z.string().nullable(), phone: z.string().nullable(), url: z.url().nullable() }).nullable().describe("How to call the marina or harbour")`, `kind` `.describe()` with the four definitions of spec 17), version literals `2.2` (`contract/index.ts`, `v2/common.ts`, `v2/manifest.ts`, `config/delivery.json`, config test, contract tests and `test/fixtures/delivery/expected/*.json`), `npm run contract:generate` → `contract/schema/2.2/*`, `contract/schema/published.ts`; `lib/domain/delivery/map-spot.ts` (`SPOT_FIELDS.berthable = { attributes: ["berthable"], note }`, `SPOT_FIELDS.contact = { attributes: ["contact"], note }`, mapping, provenance groups), `lib/domain/delivery/types.ts`, `lib/pipeline/images/stage.ts` (`eligibleSpots` + `p.public_id is not null`, deviation 4)
- Test: `lib/domain/consolidation/__tests__/build.test.ts`, `lib/domain/delivery/__tests__/map-spot.test.ts`, `contract/__tests__/*`, `lib/pipeline/images/__tests__/stage.test.ts`, `lib/domain/delivery/__tests__/validate.test.ts`

**Interfaces:**
- Consumes: v3 keys (Task 3), statuses (Task 6).
- Produces: `SpotBody.berthable: boolean | null`, `SpotBody.contact: { vhf; phone; url } | null` (all three null → `contact: null`).

- [ ] **Step 1: Failing tests:** derived `berthable`: confirmed anchorage without fact → true (`derived`), port → false, no_anchoring marina → false, fact `false` on confirmed mooring field wins over derivation, candidate → no value; spot carries `berthable` and `contact` (`vhf "71"`, phone, url) and validates against 2.2; package of a non-berthable port validates; highlight `spotIds` never include a candidate (existing check, add fixture); images: `no_anchoring` place without public id is not eligible.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npx vitest run contract lib/domain/delivery lib/pipeline/images`; typecheck, lint.
- [ ] **Step 5: Commit** `feat(delivery): contract 2.2 with berthable and contact, berthable derived for confirmed places (spec 17)`.

### Task 8: Admin, quality metrics, cost estimate, runbook

**Files:**
- Modify: `lib/domain/geo-view.ts` (`PlaceDetail.autoDecision: { action: "confirm" | "no_anchoring" | "set_kind"; rule; decidedAt; factIds; documentIds; routeStopIds } | null`, `PlaceDetail.website: { url; origin; bound } | null`), `app/(admin)/places/[id]/page.tsx` (Eckdaten: „Automatisch bestätigt am <Datum> (Regel: <Label>)“ with links to the documents; „Website“ with origin label; „Festmachplatz“ ja/nein/unbekannt from the profile), labels (`AUTO_RULE_LABELS`: alone „Revierführer/Behörde“, pair „Zwei unabhängige Berichte“, own_website „Eigene Website“, commercial_port „Quelle: gewerblicher Hafen“, osm_commercial „OSM: gewerblicher Hafen“), `lib/db/schema/quality.ts` (`METRIC_KEYS` + `place_confirmation`, `place_websites`, `marina_services`) + migration `0066_quality_metrics_places.sql` (re-add the CHECK, pattern 0046), `lib/domain/quality/{metrics,snapshot,dashboard,reports}.ts`, `app/(admin)/quality/page.tsx`, `app/(admin)/runs/page.tsx` (reprocess dialog shows the estimate), `docs/runbook.md` (new section „Umstellung auf Fact-Schema v3 und Bestätigung nach Beleg (Teil-Spec 16/17)“)
- Create: `lib/domain/extraction/reprocess-estimate.ts`
- Test: `lib/domain/__tests__/geo-view.test.ts`, `lib/domain/quality/__tests__/metrics.test.ts`, `lib/domain/extraction/__tests__/reprocess-estimate.test.ts`, Playwright `e2e/places.spec.ts` (auto line visible)

**Interfaces:**
- Metrics per subdivision (`MetricResult`):
  - `place_confirmation`: value = share of confirmed places confirmed automatically; details `{ candidates, autoConfirmed, manualConfirmed, withoutEvidence, kindChanged, deliveredByKind: { [kind]: { yes, no, unknown } } }`.
  - `place_websites`: value = share of marinas/ports (candidate or confirmed) with a website; details `{ withWebsite, bySource: { osm, wikidata, serp }, fetched }` (`fetched` = bound start URL with ≥ 1 document version).
  - `marina_services`: value = share of confirmed marinas with a `services.fuel` and a `services.water` value; details `{ fuel, water, fromWebsite }`.
- `estimateReprocessCostEur(db, subdivisionKey, cfg): Promise<{ mentions: number; costPerMentionEur: number | null; estimateEur: number | null }>` – mentions in scope (as `textRunVersions` with `reprocess`) × mean `stats.costPerMentionEur` of the last 5 finished regular/reprocess extraction runs; null when no run has stats.
- Runbook section, verbatim order per subdivision:
  1. Deploy (migrations 0063–0066; v3 active from here, text facts count again only after step 5).
  2. `npm run pois:reclassify -- --dry-run`, then without `--dry-run` (once, all subdivisions).
  3. Läufe › „Gazetteer aufbauen“ for the subdivision (website tags, P856; deviation 1).
  4. Läufe › „Marina-Websites suchen“ (finds, approves, fetches, binds, extracts with v3).
  5. Läufe › „Reprozessieren für Landesteil“ (check the estimate first; also runs follow-up discovery and images).
  6. Quality page: `place_confirmation`, `place_websites`, `marina_services`; then delivery.

- [ ] **Step 1: Failing tests:** place detail returns the system decision with rule and evidence ids, and the current website; metrics on a fixture subdivision (2 auto, 1 manual, 1 candidate; one marina with OSM website, one with SERP website; fuel only) give the expected values and details; estimate = mentions × mean cost, null without stats; e2e: auto-confirmed place shows „Automatisch bestätigt“.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; typecheck, lint; `npm run build`.
- [ ] **Step 5: Commit** `feat(admin): show automatic confirmation and place website, quality metrics and reprocess estimate, runbook for the v3 rollout (specs 16, 17)`.
