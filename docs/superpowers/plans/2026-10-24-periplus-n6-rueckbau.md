# Periplus N6 – Rückbau des alten Ansatzes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den alten quellengetriebenen Ansatz vollständig entfernen (Erwähnungen, alte Extraktion, Klassifikation, Quellenfreigabe, Crawl, Profile/Zeitachse, Zusammenfassungen, alte Highlights, Revisit-Simulation, Vergleiche, alte Vertragsversionen), die geteilten Helfer an neutrale Orte verschieben und das Schema auf eine neue Basis-Migration bringen.

**Architecture:** Reihenfolge nach den Kopplungen (Bestandsaufnahme vom 24.10.2026 auf dem Stand von N4b, Anhang A; vor Task 1 gegen `main` nach N5 auffrischen): (1) geteilte Helfer verschieben, (2) `facts`, `documents/store`, Bilder-Zielauswahl, Tor und Bestätigung von Profilen und Erwähnungen lösen, (3) Queues/Stufen/Handler kappen, (4) Dateien und Admin-Seiten löschen, (5) Schema bereinigen und eine Basis-Migration erzeugen, (6) Doku.

**Tech Stack:** wie bisher.

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-neuausrichtung-design.md` (7.2, 8, 9)

## Global Constraints

- **Voraussetzung:** N5 (Vertrag 4.0) ist auf `main`; die Lieferung liest nur noch `berth_states`. Branch `feat/n6-rueckbau` von `main`.
- Nach JEDER Aufgabe: volle Suite grün (`npx vitest run`), `tsc`, `lint`, `npm run build`. Kein Rückbau-Schritt darf eine Funktion des neuen Ansatzes ändern; Verhaltensänderungen nur dort, wo das Design sie verlangt.
- Was bleibt (nicht löschen): Gerüst (Gazetteer, Landesteile, Reviere, Kacheln, Seed, Geometrie, Datensätze), `computations` und berechnete `facts`, KI-Batch-Infrastruktur, Archiv (`documents`, `document_versions`, S3), `sources` (als Domänen-Tabelle für Dokumente), SERP-Tabellen, `place_websites`, Ortsbilder, Navily-Tor und Vergleichswerkzeuge, Lieferung 4.0, Review-Grundlage mit Arten `place_candidate`, `failed_job`, `place_image`, `research_conflict`.
- Nur anfügend bleiben Archiv (`document_versions`) und Kosten (`external_calls`); History-Tabellen und `record_history`-Trigger fallen weg (Design 7.2).
- Produktion wird aus der neuen Basis neu aufgesetzt; das Archiv wird per Skript übernommen (Design 9) — eigene Aufgabe, Ausführung nach Freigabe des Merges.
- Code englisch, Oberfläche deutsch; Commit-Trailer wie bisher.

## Review Focus

- Nach dem Rückbau läuft ein kompletter Recherche-Lauf + Folgekette + Paketbau auf einer frischen DB aus der Basis-Migration (End-to-End-Test Task 6).
- Kein verbleibender Import zeigt auf gelöschte Module (tsc), kein Queue-Name ohne Handler (Worker-Start-Test).
- Die Dokument-Ansicht funktioniert ohne Chunks (liest das Markdown aus dem Archiv).
- Das Navily-Tor misst Kernwerte gegen `berth_states`, nicht mehr gegen Profile (gebaut in Plan `2026-10-25-periplus-tor-kernwerte.md`; nach dem Rückbau muss der Tor-Test unverändert grün sein).

---

### Task 1: Geteilte Helfer verschieben

Verschieben (Re-Export entfällt, alle Importe anpassen): `lib/pipeline/text/stage-batch.ts` → `lib/pipeline/stage-batch.ts`; `titleOf` (text/classify) → `lib/domain/documents/title.ts`; `plausibleDate`, `firstWords` (mentions/classification), `jsonUuids` (mentions/scope), `stripAffix` (mentions/affixes) → `lib/domain/research/util/`; `locateQuote`, `normalizeForQuote` (extraction/quote), `nameInQuote` (extraction/facts), `routeSections` (extraction/routes) → `lib/domain/research/text/`; Konsolidierungsregeln (`rules/*`, `applyRule`, `ConsolidationInput`/`RuleName`, `byAttributeDateId`, `attributeIn`, `derivedBerthable`, `computedInputs`) → `lib/domain/rules/`; `task-locks` → `lib/domain/review/task-locks.ts`; `hasOpenPairTask`, `recordDecision`, `SYSTEM_ACTOR` (places/auto-status) → `lib/domain/review/system-decisions.ts`; `discovery/queries` Teilmenge (`DiscoveryQuery`, `namesByLanguage`, `queryKey`, `dedupeQueries`) und `runQueries` → `lib/domain/search/`; Einzel-URL-Teil von `pipeline/fetch/url.ts` (`fetchFollowing`, `decodeHtml`, `formatOf`, `urlJobKey`, `FetchUrlDeps`) → `lib/pipeline/fetch/page.ts`; `validAt`/`validAtAlias` (timeline) → `lib/db/valid-at.ts`; `routeSectionBatchEntry` ohne den alten `extraction.route`-Zweig.

- [ ] Steps: verschieben, Importe anpassen, volle Suite grün, commit `refactor: move shared helpers out of the old pipeline (N6)`.

### Task 2: Neue Teile von Profilen und Erwähnungen lösen

- `pipeline/images/stage.ts` + `consolidation/targets.ts`: Bildziele aus bestätigten Plätzen mit `berth_states` statt `profiles`.
- `research-confirm.ts`: kein `startConsolidationRun` mehr.
- Qualitätsseite (`quality/navily-compare.ts`, `comparison-values.ts` `loadComparisonSubjects`): Werte aus `berth_states` statt `latestProfiles`/`evaluation_profiles`, über `attributesFromState` wie das Tor. Das Tor selbst liest seit Plan `2026-10-25-periplus-tor-kernwerte.md` schon `berth_states` und `places` und vergleicht die Kernwerte; hier nur prüfen, dass kein Profil-Import zurückkommt.
- `geometry-run.ts`: keine Konsolidierungsstufen mehr anhängen (Geometrie → fertig; Folgekette nicht nötig).
- `subdivision-build.ts`: keine Reread- und Discovery-Stufen; stattdessen optional Recherche-Lauf am Ende (Entscheidung im Bericht).
- `documents/store.ts` `storeFetched`: keine Chunks, keine Shingles, keine Embeddings; Dokument-Ansicht liest Markdown aus dem Archiv.
- `place-website`-Zweig: `website-source.ts` ohne `source_approval`, ohne `mentions/bound`, ohne `pipeline/text/versions`; Website wird gebunden und als Recherche-Seite genutzt (N3b).

- [ ] Steps: je Punkt Test anpassen/ergänzen, umbauen, volle Suite grün, commit `refactor: new pipeline no longer reads profiles, mentions or chunks (N6)`.

### Task 3: Queues, Stufen, Handler kappen

Entfernen aus `QUEUES`, `config/queues.json`, `STAGES`, `HANDLERS`, `BATCH_HANDLERS`: `mentions.*`, `discovery.*`, `fetch.source`, `embed.chunks`, `sources.wikivoyage`, `compare.converters`, `classify.document_version`, `extraction.*`, `consolidation.*`, `revisit.freeze`; `fetch.url`/`places.website*` nach Entscheidung aus Task 2.

- [ ] Steps: entfernen, Worker-Start-Test, volle Suite, commit `refactor: drop old queues and stages (N6)`.

### Task 4: Dateien, Skripte, Admin-Seiten löschen

Gemäß Bestandsaufnahme Abschnitte 1.1–1.13, 1.16, 1.19 (Domänen-, Pipeline-, Handler-Dateien, Prompts und Tasks `classify-document`, `disambiguate-mention`, `extract-facts`, `summarize-profile`, Fact-Schemas v1–v3, Konfigurationsdateien/-schlüssel, Skripte und `package.json`-Einträge, Admin-Seiten `compare/**`, `sources/**`, Profil-/Zeitachsen-/Highlight-Reiter, Erwähnungs-Komponenten, Reprozess-Formular, alte Qualitätskennzahlen, Revisit-Simulation inkl. `adapters/simulation`-Verflechtung, alte Vertragsversionen 1.0–2.3 und `/api/v1`).

- [ ] Steps: löschen in mehreren Commits je Bereich, nach jedem volle Suite + build, commit-Präfix `chore(n6): remove …`.

### Task 5: Schema bereinigen und Basis-Migration

- Tabellen, Enums, Trigger der Bestandsaufnahme 1.1–1.15 entfernen; `facts` auf berechnete und Review-Zeilen beschränken (FKs zu `mentions`, `chunks`, `extraction_runs` und zugehörige CHECKs entfernen); History-Tabellen und `record_history`/`forbid_delete`-Trigger entfernen; Review-Arten bereinigen.
- Alle Migrationen zu einer Basis-Migration `0000_base` zusammenfassen (drizzle-kit aus dem bereinigten Schema), alte Migrationen archivieren (`drizzle/archive/`), Test-DB-Setup auf die Basis.
- Datenübernahme-Skript `scripts/migrate-archive.ts`: Dokumente, Versionen, Quellen-Domänen, SERP, Recherche-Tabellen, Geo-Gerüst, Plätze, Bilder aus der alten DB in eine frische DB (für Produktion, Design 9).

- [ ] Steps: Schema, Basis-Migration, Skript mit Test gegen eine Kopie, volle Suite auf frischer Test-DB, commit `chore(db): one base migration for the realigned schema (N6)`.

### Task 6: End-to-End und Doku

- End-to-End-Test auf frischer DB: Gerüst-Fixture → Recherche-Lauf (MockModel) → Bestätigung → Folgekette → Paket 4.0.
- `CLAUDE.md`, Gesamtdesign (Abschnitte 4, 6, 7, 10), Runbook (Befehle, Betrieb ohne alte Stufen), `docs/pilot/pruefung/befunde.md` (erledigte Befunde schließen).

- [ ] Steps: Test, Doku, commit `docs: realigned system after removal (N6)`.

---

## Anhang A: Bestandsaufnahme (24.10.2026, Stand N4b)

Read-only inventory for the removal plan (worktree n4b, branch feat/n4b-landrecherche). Nothing was modified. All paths are relative to the repository root. "T" means the module's own `__tests__` dir plus matching tests under `lib/**/__tests__`, `app/**/__tests__`, `test/`, `scripts/__tests__` and `e2e/`.

Findings that change the plan:
- **No `source_assessments` table exists** in `lib/db/schema` or `drizzle` (0000-0077). Only `pageAssessments` (research, kept) exists. Spec 11 "Autofreigabe" lives in `lib/domain/discovery/proposals.ts`, `sources.status` (`source_status` enum) and the `source_approval` review kind.
- **The history tables exist only in SQL.** There are no TS table definitions for them. See section 1.14.
- **`facts` has FKs to removal targets.** `mention_id` references `mentions`, `quote_chunk_id` references `chunks`, and `extraction_run_id` references `extraction_runs` (`lib/db/schema/derived.ts`). It also carries CHECK constraints like `facts_quote_for_mention`. Mentions, chunks and extraction_runs cannot be dropped until `facts` is reshaped to computation-only rows.
- **A lot of new code still depends on old consolidation, text-pipeline and `profiles` code.** See section 2.

#### 1. Removal targets

#### 1.1 Mentions, match, disambiguation, geocode, reread, check, recheck, retractions, unmatched, ambiguous, shingles
- **Domain:** `lib/domain/mentions/*` (affixes, bound, classification, match, ngrams, scope, store, tile-borders, unmatched) + T (`bound`, `classification`, `match`, `ngrams`, `scope`).
  - Partial survivors, see section 2: `affixes.ts` (`stripAffix`), `classification.ts` (`firstWords`, `plausibleDate`), `scope.ts` (`jsonUuids`).
- **Pipeline:** `lib/pipeline/text/{mentions,disambiguate,geocode,reread,check,versions,run}.ts`.
  - Survivors: `stage-batch.ts`, plus `classify.ts` (`titleOf`) and `routes.ts` (`routeSectionBatchEntry`) until they are moved.
- **Handlers:** `lib/jobs/handlers/{text,reread,reread-start}.ts`. They contain the mentions.batch, disambiguate, geocode, extraction.* and classify stages.
- **Other code:**
  - `lib/domain/{text-annotations,review-decisions}.ts` (the name-candidate and retraction parts), `lib/domain/acceptance/texts.ts`.
  - Admin: `app/(admin)/_components/{mentions-panel,annotated-text,quote-context}.tsx`, `app/(admin)/review/[id]/name-candidate.tsx`.
  - Scripts: `scripts/check-texts.ts`.
  - Pipeline: `lib/pipeline/subdivision-build.ts` imports `REREAD_STAGE` from `pipeline/text/reread`, so `startRereadForSubdivision` has to be cut there.
- **Tables** (`lib/db/schema/text.ts`): `mentions`, `ambiguous_matches`, `unmatched_names`, `name_candidates`, `pipeline_passes`.
  - Enums: `match_kind`, `ambiguous_status`, `name_candidate_status`.
  - Triggers: `mentions_append_only` (0024), `ambiguous_matches_set_updated_at`, `name_candidates_set_updated_at`, `mentions_no_truncate` (0049).
  - Note: `mentions` is not deletable in the drizzle migration chain because of the `forbid_mutation` and `no_truncate` guards. Drop the triggers first or rebase.
- **Shingles:** `text_shingles` table (`lib/db/schema/sources.ts`), written in `lib/domain/documents/store.ts` (`storeFetched`), `lib/domain/documents/shingles.ts`.
  - `shingleWords` is still used by `lib/domain/research/verbatim.ts`.
- **Queues:** `mentions.reread`, `mentions.batch`, `mentions.disambiguate`, `mentions.geocode`.
- **Config:** `config/mentions.json`, `config/name-affixes.json` (still used by `research/assign` and `quality/navily-assistant` via `stripAffix`), `config/prompts/disambiguate-mention/`, `config/models.json` task `disambiguate-mention`.
  - Task file: `lib/ai/tasks/disambiguate-mention.ts`.
- **Review kinds touched:** `place_candidate` also carries name candidates and is still used by research confirmation (see section 3).
- **Scripts/package.json:** `check:texts`.
- **Also affected:** `lib/domain/quality/metrics.ts`, `lib/domain/areas/{store,resolve,polygon}.ts`, `lib/domain/geo-facts.ts`, `lib/domain/delivery/load.ts`, `lib/domain/highlights/candidates.ts`, `lib/domain/consolidation/{inputs,followup,weights,targets}.ts`, `app/(admin)/{places/[id]/page,places/[id]/state-tab,geo/[id]/page,documents/[id]/page}.tsx`, `app/(admin)/_components/labels.ts`, `app/(admin)/runs/reprocess-form.tsx`. These import `lib/domain/mentions` or read mentions tables.
- **Mention retractions:** none exist as a separate table. They are `mentions` rows with status values plus parts of `review-decisions` and `mentions/store.ts`.
- **Related:** `lib/domain/places/website-source.ts` and `lib/pipeline/places/website-stage.ts` use `mentions/bound` for binding keys and `pipeline/text/versions`.

#### 1.2 Old classify (`classify.document_version`)
- `lib/pipeline/text/classify.ts`, `lib/ai/tasks/classify-document.ts`, `config/prompts/classify-document/v1.md`, `config/models.json` task `classify-document`.
- `lib/domain/mentions/classification.ts` (`storeClassification`, `activeClassifier`, `effectiveVersionMeta`).
- Queue `classify.document_version`, stage `classifyDocumentVersionStage` (in `lib/jobs/handlers/text.ts`), `BATCH_HANDLERS[classify-document]` in `lib/jobs/batch-handlers.ts`.
- `config/extraction.json` key `classifyWords`.
- Survivors: `titleOf` (used by `research/assess`) and `firstWords` and `plausibleDate`. The page-kind enum lives in `schema/research.ts`.
- The old doc_type/observed_at classification columns on `document_versions` stay (see section 3).

#### 1.3 Old extraction (`extraction.mention/route/check`)
- **Domain:** `lib/domain/extraction/*` (active-run, comparison, facts, fidelity, quote, reprocess-estimate, routes, run-status, run-view, unit-status, units) + T.
  - Survivors: `quote.ts` (`locateQuote`, used by research extraction and discovery and `places/website-find`), `routes.ts` (`routeSections`), and `facts.ts` (`nameInQuote`).
  - `routes.ts` also has `assignStop` and `storeRoute`, which write `routes`/`route_stops` (old). Keep only the section splitter.
- **Pipeline:** `lib/pipeline/text/{extract,routes,check,run}.ts`, `lib/jobs/handlers/text.ts`.
- **Tables:** `extraction_runs`, `extraction_units`, `routes`, `route_stops` (old, not `research_route_stops`).
  - Enums: `extraction_status`, `extraction_purpose`, `extraction_run_status`, `extraction_run_block_reason`, `unit_status`.
  - Triggers: `routes_append_only`, `route_stops_append_only`, `extraction_units_set_updated_at` (0024), `routes_no_truncate`, `route_stops_no_truncate` (0049).
  - Keep: `mooring_kind` enum (imported by `lib/ai/tasks/extract-route.ts`).
- **Queues:** `extraction.mention`, `extraction.route`, `extraction.check`.
- **Prompts/tasks:** `config/prompts/extract-facts/v1..v6.md`, `lib/ai/tasks/extract-facts.ts`, `config/models.json` task `extract-facts`.
  - `extract-route` is shared: the new `research.routes` also uses it. Keep the task and prompt.
- **Config:** `config/extraction.json` (keys quote, unit, maxFactsPerUnit, unitsPerBatch, classifyWords, routeSectionWords, routeMaxStops, routeStop, properNameMaxChars, poiMatchRadiusM, poiSimilarity, geocode, earliestDate, acceptance, comparison). Check which of these `lib/domain/research/*` reads before deleting. `quote` and `routeSectionWords` are shared.
- **Fact-schema:** `config/fact-schema/{v1,v2,v3}.ts` and `active.json` (`{"version":"v3"}`). `v4` is used by research (`config/research.json` `extraction.factSchema = "v4"`). `lib/domain/facts/schema.ts` is read by new code (see section 2).
- **Admin:** `app/(admin)/runs/reprocess-form.tsx`, `app/(admin)/runs/actions.ts` (reprocess/reread), parts of `app/(admin)/runs/[id]/page.tsx`.
- **Model comparison:** `compare/models/*`, `lib/domain/model-comparison-view.ts`, `lib/domain/extraction/comparison.ts`, tables `model_comparisons`, `model_comparison_units`, `model_comparison_ratings` plus `comparison_verdict` enum, `scripts/compare-models.ts`, `scripts/model-report.ts`.
- **Scripts:** `compare:models`, `report:models`.

#### 1.4 Chunks and embeddings
- The new pipeline does not use chunk rows itself. But `lib/domain/documents/store.ts` `storeFetched`, called from `lib/pipeline/fetch/store-page.ts` `convertAndStore`, which `lib/pipeline/research/fetch.ts` calls, still writes `chunks`, `text_shingles` and carried embeddings. See section 2.
- **Delete after `storeFetched` is stripped:**
  - Files: `lib/domain/documents/{chunker,carry}.ts`, `lib/pipeline/embed.ts`, `lib/jobs/handlers/embed.ts`, `lib/adapters/voyage.ts`.
  - Tables: `chunks` (incl. `embedding`, `carried_from_chunk_id`) and `text_shingles`.
  - Triggers: `chunks_append_only` (0017), `chunks_no_truncate` (0049).
  - Config: `config/embeddings.json`, `config/fetch.json` key `chunk`, `config/budgets.json` key `voyage`.
- **Consumers:**
  - `worker/index.ts` calls `assertEmbeddingDimension` at start.
  - `lib/domain/document-view.ts`, `app/(admin)/documents/[id]/page.tsx` and `lib/domain/text-annotations.ts` read chunks. The Dokument-Ansicht is kept by spec. Check that it can read the archive markdown instead.
  - Queue `embed.chunks`, stage `embedChunksStage`, `EMBED_STAGE` in `lib/pipeline/fetch/run.ts`, `startEmbedBackfillRun`.
  - FKs to `chunks`: `mentions.chunk_id`, `ambiguous_matches`, `unmatched_names`, `route_stops`, `facts.quote_chunk_id`.
  - `lib/domain/consolidation/inputs.ts`, `lib/domain/acceptance/sources.ts`, `lib/adapters/simulation.ts` mention chunks.
- Spec 11 leaves open whether long pages (PDF guides) still need chunks. The new extraction uses `research_units` (`lib/db/schema/research-extract.ts`, FKs `documentVersions` and `places`, not `chunks`). So nothing in the new schema needs chunks.

#### 1.5 Discovery area/tile/propose/place
- **Pipeline:** `lib/pipeline/discovery.ts` is mixed. Delete `discoverArea`, `planTileDiscovery`, `planPlaceDiscovery`, `placeDiscoveryIds`, `DISCOVERY_*_STAGE` and keep `runQueries`, `discoveryQuerySchema` and `SearchSummary` (used by `research/search` and `research/landside-search`).
  - Also delete `lib/pipeline/discovery-run.ts` (`startDiscoveryRun`, `startProposalRun`, `startPlaceDiscoveryRun`, `resumePlaceDiscoveryRun`).
- **Handler:** `lib/jobs/handlers/discovery.ts` + `lib/jobs/__tests__/discovery-handler.test.ts`.
- **Domain:** `lib/domain/discovery/proposals.ts`. Delete it, but see section 2: `suggestType` and `isIgnoredDomain` are used by `places/website-*`.
  - `lib/domain/discovery/queries.ts`: delete `areaQueries`, `tileQueries`, `placeQueries`, `sourceLanguagesOfTile`, `capQueries`. Keep `DiscoveryQuery`, `namesByLanguage`, `queryKey`, `dedupeQueries` (used by `research/queries`, `research/landside-queries`, `places/website-find`).
  - `lib/domain/discovery/serp.ts` (`runQuery`) stays (serp tables).
- **Queues:** `discovery.area`, `discovery.tile`, `discovery.propose`, `discovery.place`.
- **Config:** `config/discovery.json` keys `templates.{area,tile}`, `proposals`, `bay` (check, geometry may use it). Keep `serp`, `placeWebsite`.
- **Table:** `place_discovery_requests` (`lib/db/schema/profiles.ts`, only used by `discovery-run.ts`).
- **Enum:** `serp_level` has values `area`, `tile`, `place`, `place_website`, `research`. Keep the enum (serp tables stay) and optionally prune `area`, `tile`, `place`.
- **Admin:** `app/(admin)/sources/actions.ts` (starts discovery runs), `app/(admin)/tiles/[id]/*`.
- **Also affected:** `lib/domain/review-view.ts`, `app/(admin)/review/[id]/page.tsx` import `domain/discovery`; `lib/pipeline/subdivision-build.ts` and `lib/pipeline/consolidation/followup.ts` import `pipeline/discovery`.

#### 1.6 Source proposals, approval, auto-assessment
- **Domain:** `lib/domain/sources/store.ts` (setSourceStatus, getSource, approval lifecycle) and `lib/domain/sources-view.ts`.
  - Keep: `robots.ts`, `urls.ts` (`normalizeUrl`, `registrableDomain`), `forbidden-domains.ts`.
  - `crawl-rules.ts`: used by `research/sources.ts`. Check whether crawl rules can go.
- **Review:** kind `source_approval` (`lib/db/schema/review.ts`), `lib/domain/review-decisions.ts` source branch, `app/(admin)/review/[id]/*` source parts, `app/(admin)/sources/*` (page, [id], actions, tones.ts), `app/(admin)/_components/crawl-rules-fields.tsx`, e2e `sources.spec.ts`.
- **Tables:** `sources` columns `status`, `format`, `change_rate`, `crawl_rules`, `origin` (enum `source_origin`, enums `source_status`, `source_format`, `change_rate`).
  - The table itself must stay (section 3).
- **Triggers:** `sources_forbid_delete`, `sources_history_append_only`, `sources_record_history`, `sources_set_updated_at`, `sources_no_truncate` (0017/0049).
- **Config:** `config/source-types.json`, `config/sources-whitelist.json`, `config/delivery.json` `forbiddenDomains` (keep, used by `isForbiddenUrl`).
- **Scripts:** `check:sources` (`scripts/check-sources.ts`, `lib/domain/acceptance/sources.ts`).
- **Place websites:** `lib/domain/places/website-source.ts` (`attachPlaceWebsite`) creates sources and `source_approval` tasks via `suggestType`, `setSourceStatus`, `decideReviewTask`. Rework or remove together with the `places.website` pipeline (section 3).

#### 1.7 Wikivoyage
- `lib/pipeline/sources/wikivoyage.ts`, `lib/jobs/handlers/wikivoyage.ts`, queue `sources.wikivoyage`, stage `wikivoyageStage`, `startWikivoyageRun` in `lib/pipeline/fetch/run.ts`, test `lib/pipeline/__tests__/wikivoyage.test.ts`.
- The source origin enum value is `whitelist`.

#### 1.8 fetch.source, crawl_frontier, outlinks, link graph
- **Pipeline:** `lib/pipeline/fetch/{source,run}.ts`, parts of `lib/pipeline/fetch/url.ts` (`planFetchUrls`, `followLinks`, `fetchUrl`, `urlJobKey` and frontier bookkeeping).
  - Keep from `url.ts`: `fetchFollowing`, `decodeHtml`, `formatOf`, `FetchUrlDeps`, `urlJobKey` (the first three used by `places/website-find` and `research/fetch`).
  - Keep `store-page.ts` (`convertAndStore`).
- **Handler:** `lib/jobs/handlers/fetch.ts` (`fetchSourceStage`/`fetchSourceHandler` go; `fetchUrlStage`/`fetchUrlHandler` is still used: `places.website` and revisit depend on `fetch.url`. Decide whether `research.fetch` replaces it.)
- **Queues:** `fetch.source`; keep or retire `fetch.url` depending on `places.website`.
- **Tables:** `crawl_frontier`, `outlinks`, `frontier_status` enum.
- **Domain:** `lib/domain/documents/links.ts`.
- **Config:** `config/fetch.json` keys `defaultConverter`, `converterBySource`, `decision`, `renderMinMainChars`, `trackingParams`, `chunk`.
  - Keep: `timeoutMs`, `maxRawBytes`, `maxRateWaitMs`, `goneAfter`, `languages`, `pdf`, `jina`, `firecrawl`, probably `defaultConverter`.
- **Admin:** `app/(admin)/sources/[id]/actions.ts`.

#### 1.9 Compare converters and models
- **Converters:** `lib/pipeline/compare-converters.ts`, `lib/pipeline/compare-converters-run.ts`, `lib/jobs/handlers/compare.ts`, `lib/domain/converter-comparison.ts`, `app/(admin)/compare/converters/*`, `scripts/converter-report.ts`, `scripts/pdf-compare.ts` (also uses `pdf-layout`, which `lib/adapters/pdf/index.ts` and `lib/domain/documents/` still use), tests `compare-converters.test.ts`.
  - Queue: `compare.converters`.
  - Tables: `converter_samples`, `converter_outputs`, enum `converter_name` (check `adapters/fetch` use before dropping the enum).
- **Models:** `app/(admin)/compare/models/*`, `lib/domain/model-comparison-view.ts`, `lib/domain/extraction/comparison.ts`, `scripts/compare-models.ts`, `scripts/model-report.ts`, tables `model_comparisons`, `model_comparison_units`, `model_comparison_ratings`, `config/models.json` key `comparison`.
  - `app/(admin)/_components/nav.tsx` has the link.
- **Scripts:** `compare:models`, `report:models`, `report:converters`, `pdf:compare`.

#### 1.10 Revisit simulation
- **Domain:** `lib/domain/revisit/*` (draft, guard, preflight, scenario, scope, sim-verify, verify).
  - `guard.ts` (`assertSimulationEnv`) is imported by `lib/startup.ts`, `worker/index.ts`, and scripts (`auto-decide-pairs`, `consolidate`, `compare-models`, `fixtures-record`, `smoke-ai`). Cut those imports.
- **Pipeline:** `lib/pipeline/revisit-run.ts`, `lib/pipeline/revisit-stages.ts`, `lib/jobs/handlers/revisit.ts`, queue `revisit.freeze`.
- **Adapters:** `lib/adapters/simulation.ts` and `lib/adapters/fetch/simulated.ts`. `simulation.ts` is imported by `adapters/{overpass,nominatim,dataforseo,openai-image,voyage,s3,http}`, `ai/anthropic.ts`, `pipeline/images/stage.ts`, `lib/env.ts`. Unwind these when removing.
- **Domain:** `lib/domain/quality/reports.ts`, `lib/domain/change-feed.ts` (used only by `revisit/verify`).
- **Scripts:** `scripts/sim/*` (`clone.sh`, `draft-scenario.ts`, `revisit.ts`, `verify.ts`), `scripts/__tests__/{draft-scenario,sim-verify}.test.ts`, `scripts/sim/__tests__/clone-test.sh`, `test/revisit/**`, `.env.sim`. package.json: `sim:clone`, `sim:worker`, `sim:draft-scenario`, `sim:revisit`, `sim:verify`, and `test:ops` (clone-test).
- **Run kind:** `run_kind` enum value `revisit`, `run_scope_type` value `source`.
- **Admin:** `app/(admin)/runs/actions.ts` (revisit action), `app/(admin)/__tests__/revisit-action.test.ts`.

#### 1.11 Profiles, change events, profile summaries, consolidation summary/followup
- **Tables** (`lib/db/schema/profiles.ts`): `profiles`, `change_events`, `profile_summaries`, `evaluation_profiles`, `highlight_selections`, `place_discovery_requests`.
  - Enums: `change_type`, `change_severity`, `summary_status`.
  - Triggers: `profiles_append_only`, `change_events_append_only`, `profile_summaries_append_only` (0032), `profiles_valid_from_monotonic` (0034), `*_no_truncate` (0049, includes `change_events`, `profiles`, `profile_summaries`).
  - Keep: `wikidata_sitelinks` (same file, used by `research/landside-queries`).
- **Domain:** `lib/domain/consolidation/{changes,followup,summary,store,build,inputs,targets,skipped,exclude,format,weights,types,active-rules,berthable,task-locks}.ts`, `derived/*` (confidence, importance, popularity, quietness, season), `rules/*`.
  - Many of these must stay, see section 2.
  - `lib/domain/{profile-view,profile-timeline,profile-entry-removal,timeline,change-feed}.ts`.
  - Of `timeline.ts`, `validAt`/`validAtAlias` are generic and widely used; `latestProfiles`/`profileAsOf` etc. are profile-specific.
- **Pipeline:** `lib/pipeline/consolidation/{followup,geo,highlights,run,stages,summary}.ts`, `lib/jobs/handlers/{consolidation,consolidation-followup}.ts`, `lib/pipeline/follow-ups.ts`.
- **Queues:** `consolidation.geo`, `consolidation.highlights` (mapped to the same handler as geo), `consolidation.summary`, `consolidation.followup`.
- **Prompts:** `config/prompts/summarize-profile/v1.md`, `lib/ai/tasks/summarize-profile.ts`, task `summarize-profile`.
- **Config:** `config/consolidation/{v1,v2,v3,active}.json` (keys include `summary`, `followup`, `change`, `severity`, `highlights`; see section 2 for `rules`).
  - `config_activations` table (`lib/db/schema/quality.ts`, used by `active-rules.ts` and `quality/regression.ts`), review kind `uncertain_change`.
- **Admin:** `app/(admin)/places/[id]/{profile-tab,timeline-tab,version-slider,highlights-panel,auto-decision}.tsx`, `app/(admin)/review/[id]/profile-decision.tsx`, `app/(admin)/tiles/[id]/*` (consolidate action), `app/(admin)/geo/[id]/page.tsx` profile parts.
- **Scripts:** `consolidate`, `check:profiles` (`scripts/check-profiles.ts`, `lib/domain/acceptance/profiles.ts`), e2e `profile.spec.ts`, `facts.spec.ts`.
- **Quality:** `lib/domain/quality/{metrics,regression,comparison-values,snapshot,reports}.ts` use profiles; `evaluation_profiles`.

#### 1.12 Old auto-status and evidence
- `lib/domain/places/auto-status.ts`, `lib/domain/places/evidence.ts` (no non-test importer found for `evidence`), `app/(admin)/places/[id]/auto-decision.tsx`, `scripts/auto-decide-pairs.ts` (`review:auto-pairs`).
- Coupled: `lib/domain/research/confirmation.ts` imports `hasOpenPairTask`, `recordDecision`, `SYSTEM_ACTOR` from `auto-status`. Move those out first (section 2).
- `lib/domain/consolidation/store.ts` imports `places/auto-status` too.

#### 1.13 Old highlights selection
- **Domain:** `lib/domain/highlights/{candidates,categories,select,selections,view}.ts` + T.
- **Pipeline:** `lib/pipeline/consolidation/highlights.ts`.
- **Table:** `highlight_selections` (`profiles.ts`). Enum `poi_category` stays (used by `research-state` nearby, `research/reach`).
- **Delivery coupling:** `lib/domain/delivery/{load,map-highlight}.ts` call `countingSelectionsAt`, `popularityForSubdivision`. Contract highlights files (`contract/v2*/highlight.ts`) are part of old contracts. `lib/domain/{map-data,place-status,gazetteer/merge,review-decisions}.ts` import `domain/highlights`.
- **Admin:** `app/(admin)/places/[id]/highlights-panel.tsx`.
- **Config:** `config/consolidation/*.json` key `highlights`, `config/delivery.json` key `highlights`, `config/categories.json` (check which parts).

#### 1.14 History tables and `record_history` triggers
- Defined in SQL only: `drizzle/0006_geo_triggers.sql` (`record_history()`, `forbid_delete()`, history tables for `geo_objects`, `geo_names`, `places`, `tiles`), `0008` (`restricted_areas_history`), `0017` (`sources_history`, `documents_history`), `0054` (`subdivisions_history`), `0059` (`imagery_tiles_history`, `place_images_history`).
- Per table: `*_history_append_only`, `*_record_history` (BEFORE UPDATE), `*_history_no_truncate` (0049).
- `forbid_delete` triggers: `geo_objects`, `geo_names`, `places`, `tiles`, `restricted_areas`, `sources`, `documents`, `subdivisions`, `imagery_tiles`, `place_images`.
- Most history tables belong to tables that stay (`places`, `geo_objects`, `subdivisions`, `images`). Dropping history = dropping triggers + `<t>_history` tables. Only the `sources_history` and `documents_history` ones relate to removal. `lib/db/schema/geo.ts` header comment documents it.
- The 70+ migrations can be flattened into one base migration (spec 9 recommendation). `drizzle/meta` holds the snapshots.

#### 1.15 Old contract versions 1.0 to 2.3
- **Types:** `contract/v1/*`, `contract/v2_0/*`, `contract/v2_1/*`, `contract/v2_2/*`. `contract/v2/*` is the current 2.3 (spec 7.3 plans 4.0), and `contract/index.ts`, `contract/schema/published.ts`.
- **Schemas:** `contract/schema/{1.0,2.0,2.1,2.2,2.3}/*.schema.json`. Note `2.3` has a schema dir but there is no `v2_3` dir. `contract/v2` is 2.3.
- **API:** `app/api/v1/ping/route.ts`, `app/api/v1/schema/[version]/[file]/route.ts`. `app/api/v2/*` stays as the base for 4.0 (`spots/[id]`, `subdivisions/*`, `subdivisions/[subdivision]/changes`, `.../package`, `.../package/images`, `schema/[version]/[file]`, `ping`).
  - The `changes` route goes with change events/versioning.
- **Delivery:** `lib/domain/delivery/{changes,versioning}.ts` (change feed and per-object versions, used only inside `delivery/build.ts`, plus `deliveries.ts` columns), `lib/domain/delivery/archive.ts`/`read.ts` (version routing, check before dropping), `scripts/contract-generate.ts`, `scripts/delivery-consume.ts` (`delivery:consume`).
- **Tests:** `app/__tests__/api-changes-spots.test.ts`, `api-package.test.ts`, `contract/__tests__/*`, `test/fixtures/delivery/*`.

#### 1.16 Admin pages for removal targets (`app/(admin)/`)
- Delete: `compare/**`, `sources/**` (page, [id], actions, tones), `tiles/**` if it only runs discovery/consolidate/text runs (check), `places/[id]/{profile-tab,timeline-tab,version-slider,highlights-panel,auto-decision,facts-tab}.tsx`, `review/[id]/{profile-decision,name-candidate,comparison-decision}.tsx` (comparison relates to `comparison_results` and quality, decide), `_components/{mentions-panel,annotated-text,quote-context,crawl-rules-fields,diff-view}.tsx`, `runs/reprocess-form.tsx`, `settings/page.tsx` parts (extract-facts, consolidation config activation), `quality/*` metrics parts.
  - Kept pages: `map`, `map-data`, `subdivisions`, `costs`, `deliveries`, `documents`, `geo`, `images`, `jobs`, `runs`, `review`, `places/[id]` (state-tab, research-tab, image-tab, geometry-tab, delivery-tab, anchor-map), `quality/compare` (Navily gate).
- Tests: `app/(admin)/__tests__/` for the above (e.g. `profile-tab`, `profile-decision`, `mentions-panel`, `source-page`, `sources-actions`, `compare-converters`, `revisit-action`, `annotated-text`, `auto-decision`, `review-source`, `review-profile`, `profile-actions`).

#### 1.17 Review kinds (`lib/db/schema/review.ts`)
- Remove: `source_approval`, `conflict` (profile conflicts), `uncertain_change`, `comparison_deviation` (if the quality metrics go), `coast_tile_without_area` (already obsolete).
- Keep: `place_candidate` (research confirmation, geometry, gazetteer merge), `failed_job`, `place_image`, `research_conflict`.
- Touchpoints: `app/(admin)/review/kinds.ts`, `app/(admin)/_components/labels.ts`, `lib/domain/review-{decisions,view}.ts`.

#### 1.18 Queues to remove (`lib/jobs/queues.ts`, `config/queues.json`, `lib/jobs/registry.ts`, `lib/jobs/stages.ts`)
Remove from all four: `mentions.reread`, `discovery.area`, `discovery.tile`, `discovery.propose`, `discovery.place`, `fetch.source`, `embed.chunks`, `sources.wikivoyage`, `compare.converters`, `classify.document_version`, `mentions.batch`, `mentions.disambiguate`, `mentions.geocode`, `extraction.mention`, `extraction.route`, `extraction.check`, `consolidation.geo` (see section 2), `consolidation.highlights`, `consolidation.summary`, `consolidation.followup`, `revisit.freeze`.
- Maybe: `fetch.url`, `places.website`, `places.website.freeze` (depends on the `places.website` decision).
- `queues.ts` throws at startup if `config/queues.json` has no entry for a queue in `QUEUES`, so edit both together.
- `STAGES` in `stages.ts` and `HANDLERS` in `registry.ts` are `Record<QueueName,...>`, so they type-check once the union shrinks.
- Keep: `system.ping`, `run.advance`, `tiles.ensure`, `gazetteer.*`, `subdivisions.build`, `seed.tile`, `datasets.import`, `areas.import`, `geometry.*`, `ai.batch.poll`, `images.place`, `delivery.build`, `quality.measure` (decide), `fetch.url` and `research.*` (search, fetch, assess, extract, routes, discover, confirm, state, state_facts, landside_search, landside_extract).

#### 1.19 Other scripts and package.json entries
Remove: `check:texts`, `check:profiles`, `check:sources`, `consolidate`, `review:auto-pairs`, `compare:models`, `report:models`, `report:converters`, `pdf:compare`, `sim:*`, `fixtures:record` (needs rework, it records classify/disambiguate/extract-facts), `report:pilot`/`report:costs` (use `quality/reports`; `report:costs` may stay).
Keep: `research:gate`, `compare:navily`, `check:gazetteer`, `check:geometry`, `contract:generate` (rework for 4.0), `delivery:consume` (rework), `import:*`, `migrate:subdivisions`, `check:subdivision-migration`, `pois:reclassify`, `images:scene`, `smoke:ai`, `areas:import`, user/apikey.
Docs to update: `scripts/__tests__/runbook-commands.test.ts` and `docs/runbook.md` (check that every runbook command exists).

### 2. Couplings: new code that still imports or reads removal targets (move or keep)

**`lib/pipeline/text/stage-batch.ts`** (`submitStageJobBatch`) is imported by `pipeline/research/{assess,extract,routes,state,landside-extract}.ts`. Move it to `lib/pipeline/` (next to `batches.ts`). Its dependencies are `pipeline/batches.ts`, which stays.

**`lib/pipeline/text/classify.ts`** `titleOf` is imported by `research/assess.ts`. **`lib/pipeline/text/routes.ts`** `routeSectionBatchEntry` is imported by `research/routes.ts`; the batch entry for `extract-route` is shared and dispatches by stage (comment in `lib/jobs/batch-handlers.ts`). Move both helpers. `routeSectionBatchEntry` writes to old `routes`/`route_stops` for the `extraction.route` stage, so strip that branch.

**`lib/domain/mentions/*`** (new code imports):
- `classification.ts`: `plausibleDate` (research/assessment, discovery, extraction), `firstWords` (pipeline/research/assess).
- `scope.ts`: `jsonUuids` (research/discovery, pipeline/research/routes).
- `affixes.ts`: `stripAffix` (research/assign, quality/navily-assistant which is used by the gate).
- Move these small pure functions to `lib/domain/research/` or a util.

**`lib/domain/extraction/*`**:
- `quote.ts` (`locateQuote`): used by research/extraction, discovery, `places/website-find`. Keep or move to a neutral module.
- `facts.ts` (`nameInQuote`, a pure function): research/extraction.
- `routes.ts` (`routeSections`): pipeline/research/routes. Extract these before deleting.

**`lib/domain/consolidation/*`** (research `state-core.ts`, which builds berth states, and others):
- `berthable.ts` (`derivedBerthable`) is also used by `delivery/map-spot`, `geo-view`, `quality/metrics`.
- `build.ts` (`byAttributeDateId`), `inputs.ts` (`computedInputs`), `rules/index.ts` (`applyRule`) and the rule files, `types.ts` (`ConsolidationInput`, `RuleName`), `weights.ts` (`attributeIn`).
  - `computedInputs` (lines 271-375 of `inputs.ts`) reads the geometry computed facts (`computations`/`facts`). The rest of `inputs.ts` (`loadInputs`, `loadContext`, `loadDerivedInputs`, `highlightInputs`, text-fact SQL) is old.
  - Move to `lib/domain/research/` or `lib/domain/facts/`: `computedInputs`, the `ConsolidationInput`/`RuleName` types, `applyRule` and rules, `byAttributeDateId`, `attributeIn`, `derivedBerthable`.
  - Spec: "Regeln je Kernwert bleiben".
- `task-locks.ts` (`dismissTasks`, `lockOpenPlaceTasks`): research/confirmation, and also `place-status`, `place-merge`, `gazetteer/merge`, `images/generate`, `review-decisions`. Keep or move to `lib/domain/review`.
- `active-rules.ts` (`activeRulesVersion`, `consolidationConfigFor`): used by `pipeline/research-run.ts`, `handlers/research.ts` (berth state is built with the rules version frozen in run params), `berth-followup-run.ts`, `geometry-run.ts`, `delivery/build.ts`, `subdivision-build.ts`, `place-website-run.ts`. It reads `config_activations` and `config/consolidation/*.json`.
  - Decide whether to keep one rules file (e.g. `config/consolidation/` as `config/rules/`) and drop `config_activations`/versioning.
- `config/consolidation/v*.json` key `rules` is consumed through `VersionedConsolidationConfig`.
- `lib/pipeline/consolidation/run.ts` (`startConsolidationRun`) is called by `handlers/research-confirm.ts` after confirmation ("a consolidation of the objects whose status changed so profiles and place_new follow"), and by `quality-run.ts`, `geometry-run.ts`, `follow-ups.ts`, and admin actions. Remove that call from research-confirm along with profiles.
- `consolidation/targets.ts` (`consolidationTargets`, `reselectionTargets`) is used by `pipeline/images/stage.ts`. It also reads `profiles` (the images stage selects places from the `profiles` table at `pipeline/images/stage.ts:6`). The images pipeline needs to read confirmed `berth_states`/`places` instead. `images/generate.ts` imports `task-locks`.
- `consolidation/skipped.ts` is imported by `pipeline/runs.ts` and `domain/runs.ts`.
- `consolidation/stages.ts` is imported by `geometry-run.ts` (geometry then consolidation stages: `GEOMETRY_CONSOLIDATION_STAGES = [geo, highlights, summary, followup]`).
  - After removal the geometry run no longer chains consolidation. Check `geometry-run.ts` and `pipeline/geometry.ts` for the follow-up.

**`lib/domain/facts/*`:**
- `schema.ts` (`getFactSchema`, `SAFETY_LIST_ATTRIBUTES`, `validateTextFact`, `canonicalJson`) is used by research/extraction, state-core, view, `quality/navily-*`, `delivery/*`.
- `labels.ts` is used by research/view and `quality/comparison-values`.
- `schema-types.ts` (`SECTORS`) is used by `ai/tasks/extract-route`, `delivery/map-spot`, `quality/navily-sample`.
- `computations.ts` (`latestComputations`, `recordComputation`) is used by geometry, `images/place-input`, `quality/navily-sample`, `geometry-view`.
- `config/fact-schema/v4.ts` is the live schema, v1 to v3 can go.
- Section 3 says keep these.

**`lib/domain/documents/store.ts` `storeFetched`** (via `pipeline/fetch/store-page.ts` `convertAndStore`, called by `pipeline/research/fetch.ts`) still writes chunks and shingles (and carries embeddings). `markChecked`/`markGone` are also used directly.
- Strip chunk/shingle writing, keep the document + version + archive-key logic, and then drop `chunks`, `text_shingles`, `chunker.ts`, `carry.ts`, `shingles.ts`.
- `research/verbatim.ts` uses `shingleWords` from `documents/shingles.ts`. Keep that function (it is only a word-window helper).

**`lib/domain/sources/*`:**
- `urls.ts` (`registrableDomain`, `normalizeUrl`): research/{state-core,state-facts,hits,provisional-names,confirmation,view}, `pipeline/research/fetch`. Keep.
- `forbidden-domains.ts`: research/{hits,sources}, `pipeline/research/fetch`, `delivery/map-spot`. Keep.
- `crawl-rules.ts` and `store.ts` (`getSource`): research/sources.ts (`ensureResearchSource`). `sources` rows are created per research page, so `sources.status` is bypassed. Keep the table, simplify.
- `robots.ts` stays.

**`lib/pipeline/fetch/*`:**
- `store-page.ts` (`convertAndStore`) and `url.ts` (`fetchFollowing`, `urlJobKey`, `FetchUrlDeps`) are used by `pipeline/research/fetch.ts`. `url.ts` also holds crawl_frontier and outlinks writes (`followLinks`).
- Split the single-URL part out before deleting the crawl part.
- `research/fetch` imports from `@/lib/jobs/worker` and `@/lib/adapters/*`.

**`lib/pipeline/discovery.ts` `runQueries`** is imported by `research/search` and `research/landside-search`, plus `lib/domain/discovery/queries.ts` (`DiscoveryQuery`, `namesByLanguage`, `queryKey`, `dedupeQueries`) by `research/queries`, `research/landside-queries`, `places/website-find`; and `domain/discovery/serp.ts`.

**`lib/domain/places/auto-status.ts`:** research/confirmation imports `hasOpenPairTask`, `recordDecision`, `SYSTEM_ACTOR`. Move these three into `research/confirmation` or `lib/domain/review`.

**`lib/domain/timeline.ts`:** `latestProfiles`/`validAt`. `validAt` is generic and used everywhere (gate-report, places, geo_names). Keep that part. `latestProfiles` is used by `research/gate-report.ts` (Navily gate), `quality/navily-compare.ts`, `quality/comparison-values.ts`, `delivery/load.ts`. These read `profiles` for values compared against Navily and for delivery. After removing `profiles`, the gate has to compare against `berth_states` (core values).

**Other couplings:**
- `lib/domain/quality/navily-sample.ts` imports `DATASETS_STAGE`, `GEOMETRY_STAGE`/`geometryPlaceIds` from the pipeline and `latestComputations`.
- `lib/domain/quality/{comparison-values,navily-compare}.ts` read `evaluation_profiles`/`latestProfiles`.
- `lib/domain/delivery/{load,build,draft,map-spot,validate,vocab,types,snapshot,map-highlight,changes,versioning}.ts` read `profiles`, `consolidation/types` (`ProfileSnapshot`, `AttributeProvenance`), `consolidation/derived/popularity`, `consolidation/exclude`, `highlights/selections`, `facts/schema-types`. `delivery/build.ts` calls `consolidationConfigFor`. This is spec 7.3 (contract 4.0) territory.
- `lib/db/schema/derived.ts` `facts` FKs to `mentions`, `chunks`, `extraction_runs` (see top).
- `lib/ai/tasks/extract-route.ts` imports `mooringKindEnum` from `schema/text.ts`. `schema/text.ts` also holds `ai_batches`, `ai_batch_items` (kept, section 3). So `text.ts` must be pruned, not deleted.
- `lib/db/schema/research-extract.ts`, `research.ts` reference `documentVersions`, `serpQueries`, `serpResults`, `observedAtBasisEnum` from `schema/sources.ts`. Keep these.
- `lib/domain/research/{view,state-core,confirmation}.ts` import `DocType` and `ObservedAtBasis` types from `schema/sources`.
- `lib/domain/research/discovery.ts` and `assign.ts` read `geoNames`, `placeWebsites`, `researchHits`.
- `config/research.json` has `extraction.factSchema` pointing at `config/fact-schema/v4`.
- `lib/jobs/batch-handlers.ts` registers old handlers (`classification`, `disambiguation`, `extractFacts`, old routes). Remove the old, keep assess/berth/landside/route/bundle.

### 3. Look like removal targets but are still needed

- **Geometry computed facts:** `computations` + `facts` tables, `computation_kind` enum, `facts_append_only`/`computations_append_only` triggers (0011), `lib/domain/facts/computations.ts` (read by geometry, `images/place-input`, `quality/navily-sample`, `geometry-view`).
  - These feed `computedInputs` and `lib/domain/research/state-core.ts` (shelter/depth/seabed core values). The `facts` columns for mentions/quotes/extraction runs are the part to drop. Keep rows with a `computation_id` (and review decisions, `review_decision_id`).
- **AI batch infra:** `lib/pipeline/batches.ts`, `lib/jobs/handlers/ai-batch.ts`, `ai.batch.poll`, `ai_batches`, `ai_batch_items`, `batch_status`, `batch_item_status` enums (in `schema/text.ts`), `config/models.json` `batch`.
  - The research pipeline submits all its model calls through it (`submitStageJobBatch`).
- **Archive:** `documents`, `document_versions` (`document_versions_append_only` triggers), S3 archive, `lib/domain/documents/{store,normalize,metadata,language,structured,archive-copies,pdf-layout}.ts`, `document-view.ts`, `lib/adapters/{pdf,fetch,s3}`.
  - `documents.source_id` is NOT NULL referencing `sources` (`schema/sources.ts:103`). So the `sources` table (and `ensureResearchSource`) must stay even though approval goes.
  - `document_versions` doc_type/observed_at columns are read by research (`DocType`, `ObservedAtBasis`).
- **SERP tables:** `serp_queries`, `serp_results`, `lib/domain/discovery/serp.ts` (research hits link to `serp_query_id`/`serp_result_id`; `places/website-find` also reads `serp_results`).
- **Place websites:** `place_websites` table + `place_websites_append_only` trigger, `lib/domain/places/{websites,website-find,website-source}.ts`, `lib/pipeline/places/*`, `place-website-run.ts`, `check-place-website` task/prompt.
  - Used as `research_hit_origin = 'place_website'` (`lib/domain/research/hits.ts`, `assign.ts`).
  - `websites.ts` and `website-find.ts` import `isIgnoredDomain`/`suggestType` from `discovery/proposals`; `website-source.ts` creates sources + `source_approval` tasks and uses `mentions/bound`. These parts need rework, not just deletion.
  - `places.website` queues and stages also depend on `fetch.url` and `pipeline/text/versions`.
- **Images:** `lib/domain/images/*`, `lib/pipeline/images/*`, `imagery_tiles`, `place_images`, `place_renders` + triggers, `place_image` review kind, `images.place` queue.
  - Needs the profiles-based target selection changed (above).
- **Subdivisions/areas:** `lib/domain/{subdivisions,areas}/*`, `pipeline/{subdivisions*,areas-import,subdivision-build}.ts`, `area_members`, `area_evidence` (+ triggers 0062).
  - `subdivision-build.ts` imports `pipeline/discovery`, `pipeline/text/reread` and `active-rules`; those links must be cut.
- **Gazetteer, geometry, seed, datasets:** all kept per spec (`wikidata_sitelinks` is used by `research/landside-queries`; `config/datasets.json` key `sitelinks`).
- **Quality / Navily gate:** `lib/domain/quality/{navily-assistant,navily-sample,navily-compare,navily-run,comparison-values,comparison-results,trigram}.ts`, `lib/domain/research/gate*.ts`, `scripts/research-gate.ts`, `scripts/compare-navily.ts`, `comparison_set`, `comparison_results`, `quality_snapshots`, `config/quality.json` `navily*`, `test/fixtures/navily`.
  - Only the old-approach metrics (`quality/{metrics,dashboard,regression,reports,snapshot}.ts`) should go.
  - Note `comparison_results` has a `comparison_method` enum with `proposal_*` values.
- **Delivery build skeleton:** `lib/domain/delivery/{build,validate,archive,serialize,snapshot,types,...}.ts`, `deliveries`, `delivered_objects` (+ triggers 0039), `app/api/v2/*`, `contract/v2`. Only `changes`/`versioning` and old versions go.
- **Review base:** `review_tasks`, `review_decisions` (append-only trigger 0002), `lib/domain/review*.ts`, admin review page, kinds `place_candidate`, `failed_job`, `place_image`, `research_conflict`.
- **Fetch adapters:** `lib/adapters/{fetch,http,pdf,s3,dataforseo,nominatim,overpass,wikidata,geonames,marine-regions,emodnet,wms,copernicus-dem,openai-image}`. `voyage.ts` is deletable unless fact bundling uses embeddings (spec says only then).
- **Places/geo/runs foundation:** `places`, `geo_objects`, `geo_names`, `tiles`, `runs`, `run_stages`, `job_outcomes`, `external_calls` (cost tracking), `queue_controls`, `worker_heartbeats`.
- **Config still needed:** `config/{areas,subdivisions,gazetteer,geometry,datasets,images,restrictions,research,delivery,budgets,models,categories}.json`, `config/name-affixes.json` (while `stripAffix` stays), `config/area-imports/GR.json`.
- **Prompts still needed:** `assess-page`, `bundle-facts`, `extract-berth` (v2 is current), `extract-landside`, `extract-route`, `check-place-image`, `check-place-website`, `generate-place-image`, `pdf.to_markdown`, `system.echo`.
- **Library note:** `lib/jobs/registry.ts` imports `onRunEnded` and `afterBuildRunEnded` from `pipeline/run-ended` and `pipeline/subdivision-build`; `lib/pipeline/run-ended.ts` is not on the removal list but check that it does not reference the removed stage lists.

Suggested order for the removal plan (derived from the couplings): (1) move shared helpers out (`stage-batch`, `classify.titleOf`, `mentions/{classification,scope,affixes}` bits, `extraction/{quote,facts,routes}` bits, consolidation rules/`computedInputs`/`task-locks`/`active-rules`, `auto-status` helpers, `discovery/queries` subset, `fetch/url` single-URL part); (2) reshape `facts`, `documents/store` and `research-confirm`; (3) cut queues/stages/handlers; (4) delete files and admin pages; (5) schema + triggers and one base migration.
