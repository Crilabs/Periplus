# Periplus M1 – Gazetteer und Kacheln Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stufen 1 (Gazetteer) und 2 (Seed) für das Pilotgebiet als Jobs, mit Karte, Detailseiten, Review „Ortskandidat“ und „Küstenkachel ohne Revier“ und einem pflegbaren Vergleichssatz – vorher die M0-Folgearbeiten, die „vor M1“ fällig sind.

**Architecture:** Jede Gazetteer-Teilstufe ist eine Run-Stufe auf der bestehenden Run-Mechanik (`lib/pipeline/runs.ts`): ein Lauf „Gazetteer aufbauen“ für ein Revier hat die Stufen `tiles.ensure → gazetteer.osm → gazetteer.wikidata → gazetteer.geonames → gazetteer.hierarchy`, je ein Job. Seed ist ein eigener Lauf mit Stufe `seed.tile`, ein Job je Küstenkachel. Fachregeln (Kacheln, Namen, Zusammenführung, Hierarchie, Seed, Review-Entscheidungen) liegen in `lib/domain`, die Import-Abläufe in `lib/pipeline`, externe Dienste hinter `lib/adapters` mit einer gemeinsamen HTTP-Transportschicht, die in Tests aus Fixtures antwortet. Geometrie-Arbeit (Polygonbau, Abstände, Enthaltensein) läuft in PostGIS.

**Tech Stack:** wie M0 (Next.js 16.4.2, React 19.3, Drizzle 0.45, pg-boss 12, zod 4, Vitest 5, Playwright 1.64, maplibre-gl 6) plus `@types/geojson` (dev), `shapefile` (Land-Polygone lesen), `fflate` (GeoNames-Zip entpacken).

**Spec:** `docs/superpowers/specs/2026-10-18-periplus-03-gazetteer-design.md` (primär), `…-02-datenmodell-design.md` (Tabellen, Zeitachse), `…-09-admin-ui-design.md` (Karte, Review, Detailseiten), `…-10-qualitaet-pilot-design.md` (Vergleichssatz), `…-04-geometrie-design.md` (nur Landpolygone), Gesamtdesign `…-periplus-design.md`, M0-Folgearbeiten `docs/m0-folgearbeiten.md`. Fachlich maßgebend: `.idea/datendienst-spec.md` (Stufen 1 und 2, Pilot).

## Global Constraints

- Alle Global Constraints aus dem M0-Plan gelten weiter (Node ≥ 22, Next 16.4.2, Next-Doku vor Routen/`proxy.ts`, `cacheComponents: true`, kein `console.*`, Englisch im Code, Deutsch in der UI, Tests gegen `db-test` und lokales S3, kein Netz in Tests, Route-Policy für jede Route).
- Koordinaten WGS84; Geometrien als `geometry(…, 4326)`; Distanzen intern in Metern über `::geography`.
- Kachel-ID `q025:<col>:<row>` mit `col = floor((lon + 180) / 0.25)`, `row = floor((lat + 90) / 0.25)`; eine Koordinate exakt auf der Kante gehört zur Kachel östlich bzw. nördlich.
- Pilotkacheln: 23,0–23,75° O × 37,0–38,0° N (12 Kacheln), Label-Revier `saronic`.
- Stabile Tabellen (`geo_objects`, `geo_names`, `places`, `tiles`, `restricted_areas`) werden nie gelöscht (Trigger), Ende über `valid_to`; Kernfeld-Änderungen schreiben `<tabelle>_history`.
- Externe IDs: `osm_id` als `node/…`, `way/…`, `relation/…`; `wikidata_id` als `Q…`; `geonames_id` als Ziffernfolge.
- Jeder Aufruf eines externen Dienstes schreibt eine Zeile `external_calls` (kostenlose Dienste mit `cost_eur = 0`, `unit = "request"`), mit `runId`, `tileId` (wenn vorhanden) und `stage`.
- User-Agent aller HTTP-Aufrufe: `Periplus/0.1 (+mailto:<CONTACT_EMAIL>)`.
- Overpass: höchstens 1 Anfrage gleichzeitig, Timeout 180 s, Endpunkt aus Konfiguration. GeoNames-Dump höchstens einmal je 30 Tage laden, in S3 unter `datasets/geonames/<COUNTRY>/<YYYY-MM>.zip`. Overpass-Rohantworten in S3 unter `datasets/overpass/<area>/<YYYY-MM-DD>.json`.
- Schwellen, Abstände, Klassen- und Tag-Zuordnungen stehen in `config/gazetteer.json`, `config/categories.json`, `config/areas/*.json`, nicht im Code.
- Öffentliche Ort-ID `sp_<ulid>` wird beim ersten Bestätigen vergeben und nie geändert; `ar_` für Reviere bei Anlage, `rg_` für Inseln/Archipele/Küstenabschnitte/Golfe/Kanäle bei Anlage, `hl_` für POIs bei Anlage.
- Fehlender deutscher Name = englischer Name als `language = 'de'` mit `origin = 'fallback'`.
- Review-Entscheidungen schreiben genau eine Zeile `review_decisions` und wirken in derselben Transaktion.
- Navily-Werte werden nirgends gespeichert; der Vergleichssatz speichert nur Ort-IDs.

## Review Focus

1. **Zweiter Gazetteer- oder Seed-Lauf für dasselbe Revier** darf keine doppelten Geo-Objekte, Namen, Orte oder Review-Aufgaben erzeugen – auch nicht neu öffnen, was ein Admin schon mit „Kein Revier nötig“ oder „Verschiedene Objekte“ entschieden hat. → Task 11, Task 16, Task 17 Tests `second run …`.
2. **Bucht über zwei Kacheln oder Position genau auf der Kachelkante** ergibt genau einen Ort, in der Kachel seiner Position. → Task 17 Test `bay spanning two tiles yields one place`.
3. **Griechische Namen mit Tonos, Diärese, Schluss-Sigma und gemischter Schrift** („Άγιος Γεώργιος“, „Porto Cheli / Πόρτο Χέλι“) werden gleich normalisiert, korrekt transliteriert und vom Trigram-Vergleich gefunden. → Task 7 Tests.
4. **Dieselbe Review-Aufgabe zweimal entscheiden** (Doppelklick, zwei Tabs) scheitert beim zweiten Mal sauber mit `TaskNotOpen`, es bleibt genau eine Entscheidung. → Task 18 Test `deciding twice`.
5. **Overpass antwortet mit 429, Timeout oder kaputtem JSON**: der Job scheitert und wird wiederholt, es entstehen keine halben Objekte. Ein Lauf ohne importierte Landpolygone scheitert mit klarer Meldung statt Küstenorte stillschweigend zu verwerfen. → Task 9 Test `retryable errors`, Task 12 Tests `no partial import`, `missing land polygons`.

---

## File Structure

```
# Teil A – M0-Folgearbeiten
lib/db/schema/ops.ts                      + job_outcomes
lib/domain/runs.ts                        recordJobOutcome mit key, failRun
lib/jobs/{worker,queues,registry}.ts      run.advance, JobContext.boss, priorAttempts
lib/jobs/handlers/run-advance.ts
lib/db/client.ts, lib/ai/anthropic.ts, lib/security/password.ts   Härtung
lib/domain/users.ts, lib/security/require-admin.ts, scripts/{user,apikey}.ts
lib/domain/jobs-view.ts                   fehlgeschlagene Jobs je Lauf, Retry
lib/domain/costs.ts                       spendBreakdown
lib/domain/queues-view.ts                 ohne pgboss-Schema
app/(admin)/_components/auto-refresh.tsx
app/(admin)/runs/[id]/{page.tsx,actions.ts}, app/(admin)/costs/page.tsx

# Teil B – M1
lib/db/geometry.ts                        geometry-Spaltentyp, GeoJSON-Helfer
lib/db/schema/geo.ts                      geo_objects, geo_names, tiles, tile_geo_objects, places,
                                          restricted_areas, land_polygons, comparison_set
drizzle/00NN_*.sql                        generiert + handgeschriebene Trigger/Funktionen
lib/domain/timeline.ts                    validAt()
lib/domain/tiles.ts                       Kachel-Mathematik
lib/config/{schemas,index}.ts             + areas, categories, gazetteer
config/areas/{saronic,argolic}.json, config/categories.json, config/gazetteer.json
lib/domain/gazetteer/
  areas.ts                                syncAreas()
  names.ts                                normalizeName, transliterateElot743, addNames, ensureFallbackNames
  land.ts                                 importLandPolygons, landInBbox-Prüfung
  osm-classify.ts                         Tags → Typ/Kategorie
  store.ts                                upsertGeoObject
  merge.ts                                findMatch, openPairTask, mergeGeoObjects
  hierarchy.ts                            assignParents, assignTiles
  tiles-ensure.ts                         ensureTiles
lib/domain/seed.ts                        placeKindFromTags, seedTile
lib/domain/review-decisions.ts            Entscheidungen je Aufgabenart
lib/domain/map-data.ts                    GeoJSON je Ebene
lib/domain/geo-view.ts                    Detaildaten Kachel/Geo-Objekt/Ort
lib/domain/comparison.ts                  Vergleichssatz
lib/adapters/http.ts                      Transport, Fixtures, Aufzeichnung
lib/adapters/{overpass,wikidata,geonames}.ts
lib/pipeline/gazetteer/{osm,wikidata,geonames,stages}.ts
lib/pipeline/seed.ts
lib/jobs/handlers/{tiles,gazetteer,seed}.ts
app/(admin)/map-data/[layer]/route.ts
app/(admin)/review/{page.tsx,[id]/page.tsx,[id]/actions.ts}
app/(admin)/tiles/[id]/page.tsx, app/(admin)/geo/[id]/page.tsx, app/(admin)/places/[id]/page.tsx
app/(admin)/quality/{page.tsx,actions.ts}
app/(admin)/_components/{map-view.tsx,decision-keys.tsx}
scripts/import-land-polygons.ts, scripts/fixtures-record.ts, scripts/check-gazetteer.ts
test/fixtures/http/**, test/fixtures/land/aegina-west.geojson, test/fixtures/geonames/**
docs/runbook.md                           Abschnitte Landpolygone, Gazetteer-Lauf, Zugänge sperren
```

---

## Teil A – M0-Folgearbeiten (vor M1)

### Task 1: Lauf-Fortschaltung entkoppeln, Job-Ergebnis idempotent

Folgearbeiten 1, 2 und „Budget-Aufschub setzt retryCount zurück“.

**Files:**
- Modify: `lib/db/schema/ops.ts`, `lib/domain/runs.ts`, `lib/jobs/worker.ts`, `lib/jobs/queues.ts`, `lib/jobs/registry.ts`, `config/queues.json`
- Create: `lib/jobs/handlers/run-advance.ts`, Migration (generiert)
- Test: `lib/domain/__tests__/runs.test.ts`, `lib/jobs/__tests__/worker.test.ts`

**Interfaces:**
- Produces:
  - Tabelle `job_outcomes(run_id uuid, stage text, key text, outcome text check in ('done','failed'), created_at, updated_at)`, Primärschlüssel `(run_id, stage, key)` (Arbeitszustand).
  - `recordJobOutcome(db, runId: string, stage: string, key: string, outcome: "done" | "failed"): Promise<{ recorded: boolean; stageFinished: boolean; nextStage: string | null; runFinished: boolean }>` – neue Zeile: Zähler wie bisher; vorhandene Zeile mit gleichem Ergebnis: `recorded: false`, nichts ändert sich; vorhandene `failed` und neu `done`: Ergebnis umschreiben, `failed - 1`, `done + 1`, kein Stufenwechsel (Grundlage für „Erneut“ in Task 3). Gilt auch für eine bereits beendete Stufe.
  - `failRun(db, runId: string, reason: string): Promise<void>` – setzt `status = failed`, `finished_at` und die neue Spalte `runs.failure_reason text`; die Lauf-Detailseite zeigt den Grund.
  - Queue `run.advance` (in `QUEUES`, `config/queues.json`: concurrency 1, retryLimit 2, retryDelaySeconds 60, backoff true). Job-Daten `{ runId, nextStage, key: "<runId>:<nextStage>" }` – bewusst ohne Feld `stage`, damit `settle()` ihn nicht zählt.
  - `JobContext` erhält `boss: PgBoss`.
  - Budget-Aufschub sendet mit `data.priorAttempts = (data.priorAttempts ?? 0) + job.retryCount` und `retryLimit = max(0, queueRetryLimit - priorAttempts)`.

- [ ] **Step 1: Failing tests schreiben**

```ts
// runs.test.ts
it("recordJobOutcome counts each (stage, key) once", async () => {
  // stage with total 2; record key "a" done twice
  expect((await recordJobOutcome(db, runId, "ping", "a", "done")).recorded).toBe(true);
  expect((await recordJobOutcome(db, runId, "ping", "a", "done")).recorded).toBe(false);
  expect(stageRow.done).toBe(1);
});
it("a failed outcome flips to done on a later success without finishing anything twice", async () => {
  // total 1: key "a" failed -> stage finished, run failed
  // then "a" done -> done 1, failed 0, stageFinished false, run status unchanged
});
it("failRun marks the run failed with a reason", …);

// worker.test.ts
it("a failing next-stage plan does not fail the last job of the previous stage", async () => {
  // run with stages ["ping", "explode"]; "explode" plan() throws
  // expect: all ping jobs completed (pgboss state 'completed'), one run.advance job dead-lettered,
  // one failed_job review task with context.queue === "run.advance", run.status === "failed"
});
it("a job re-sent after a budget pause keeps its used attempts", async () => {
  // job fails once, then BudgetExceeded → deferred job has priorAttempts 1 and retryLimit 1
});
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag prüfen**

Run: `npx vitest run lib/domain/__tests__/runs.test.ts lib/jobs/__tests__/worker.test.ts`
Expected: FAIL (`recordJobOutcome` erwartet 4 Argumente, `failRun` fehlt, kein `run.advance`).

- [ ] **Step 3: Implementieren**

`settle()` ruft `recordJobOutcome(tx, runId, stage, data.key, outcome)`; gibt es `nextStage`, fügt es in derselben Transaktion einen `run.advance`-Job ein (deterministische ID wie `enqueueStageJobs`, singletonKey `<runId>:<nextStage>`), statt `enqueueStage` direkt zu rufen. `advanceHandler` ruft `enqueueStage(ctx.db, ctx.boss, runId, nextStage)`. `handleDeadLetter` ruft für `queue === "run.advance"` zusätzlich `failRun(tx, runId, "stage transition failed: <error>")`. Der Test-Stage `explode` wird im Test über eine lokale `STAGES`-Ergänzung registriert und danach entfernt (wie bisherige Worker-Tests).

- [ ] **Step 4: Tests laufen lassen**

Run: `npx vitest run lib/domain lib/jobs`
Expected: PASS, auch die bestehenden Worker-Tests.

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema/ops.ts drizzle lib/domain/runs.ts lib/jobs config/queues.json
git commit -m "fix(runs): idempotent job outcomes, stage transition as run.advance job"
```

### Task 2: Zugänge sperren und kleine Härtungen

Folgearbeit 4 und die „vor M1“-Kleinpunkte Pool-Listener, Passwort-Höchstlänge, Logger in `anthropic.ts`.

**Files:**
- Modify: `lib/domain/users.ts`, `lib/domain/api-clients.ts`, `lib/security/require-admin.ts`, `lib/security/password.ts`, `lib/db/client.ts`, `lib/ai/anthropic.ts`, `scripts/user.ts`, `scripts/apikey.ts`, `package.json`, `docs/runbook.md`
- Test: `lib/domain/__tests__/users.test.ts`, `lib/domain/__tests__/api-clients.test.ts`, `lib/security/__tests__/password.test.ts`, `lib/security/__tests__/require-admin.test.ts` (neu)

**Interfaces:**
- Produces:
  - `disableUser(db, email: string): Promise<void>` (setzt `disabled_at`; unbekannte E-Mail wirft), `isUserActive(db, userId: string): Promise<boolean>`
  - `revokeApiClientByName(db, name: string): Promise<void>`
  - `MAX_PASSWORD_LENGTH = 1024`; `hashPassword` und `verifyPassword` lehnen längere Eingaben ab (`verifyPassword` gibt `false` zurück, ohne Argon2 zu rechnen)
  - `requireAdmin()` prüft nach dem Token zusätzlich `isUserActive(getDb(), claims.sub)` und leitet sonst nach `/login`
  - npm-Skripte `user:disable` (`scripts/user.ts disable <email>`, ohne Passwortabfrage) und `apikey:revoke` (`scripts/apikey.ts revoke <name>`)

- [ ] **Step 1: Failing tests** – `disabled user is rejected by requireAdmin` (gemocktes `cookies()` mit gültigem Token eines deaktivierten Nutzers → `redirect("/login")`), `authenticate rejects a disabled user`, `revoked key no longer authenticates`, `password longer than 1024 chars is rejected without hashing`, `pool error is logged, not thrown` (Pool-`error`-Event emittieren, Prozess läuft weiter).
- [ ] **Step 2: Run** `npx vitest run lib/domain lib/security` → FAIL.
- [ ] **Step 3: Implementieren.** `createDb` registriert `pool.on("error", …)` mit `createLogger("db")`; `anthropic.ts` erzeugt den Logger beim ersten Aufruf. Runbook: Abschnitt „Zugang sperren“ (beide CLI-Befehle) und „SESSION_SECRET rotieren“ (meldet alle Sitzungen ab).
- [ ] **Step 4: Run** `npx vitest run && npm run lint` → PASS.
- [ ] **Step 5: Commit** `fix(security): disable users, revoke api keys, password max length`

### Task 3: Admin-Lücken aus Spec 09

Folgearbeit 5 (ohne `failed_job`-Liste, die kommt mit der Review-Seite in Task 19) und „Übersicht ohne pgboss-Schema“.

**Files:**
- Create: `app/(admin)/_components/auto-refresh.tsx`, `app/(admin)/runs/[id]/actions.ts`, `lib/domain/jobs-view.ts`
- Modify: `app/(admin)/page.tsx`, `app/(admin)/runs/page.tsx`, `app/(admin)/runs/[id]/page.tsx`, `app/(admin)/jobs/page.tsx`, `app/(admin)/costs/page.tsx`, `lib/domain/costs.ts`, `lib/domain/queues-view.ts`
- Test: `lib/domain/__tests__/jobs-view.test.ts`, `lib/domain/__tests__/costs.test.ts`, `lib/domain/__tests__/overview.test.ts`, `app/(admin)/__tests__/actions.test.ts`

**Interfaces:**
- Produces:
  - `<AutoRefresh intervalMs={5000} />` – Client-Komponente, ruft `router.refresh()` im Intervall, pausiert bei `document.hidden`.
  - `type FailedJob = { id: string; queue: string; key: string; stage: string | null; error: string; failedAt: Date }`
  - `failedJobsOfRun(db, runId: string): Promise<FailedJob[]>` – aus `pgboss.job`, `state = 'failed'`, `data->>'runId' = runId`, ohne `system.dead`.
  - `retryFailedJob(boss, queue: QueueName, jobId: string): Promise<void>` – `boss.retry(queue, jobId)`. Eine offene `failed_job`-Aufgabe bleibt hier offen; Task 18 entscheidet sie, wenn „Erneut“ über die Review-Seite kommt, und Task 19 lässt die Lauf-Seite die offene Aufgabe mitentscheiden.
  - Server Action `retryJobAction(input: FormData | { queue: string; jobId: string })` mit zod (`queue` ∈ `QUEUES`, `jobId` uuid).
  - `spendBreakdown(db, by: "stage" | "run" | "month", opts?: { days?: number; now?: Date }): Promise<Array<{ key: string; costEur: number; calls: number }>>`
  - `jobsFromDb` liefert Nullen, wenn `to_regclass('pgboss.job') is null`.

- [ ] **Step 1: Failing tests** – `failedJobsOfRun lists only failed jobs of that run`, `retry moves the job back and the later success flips the outcome` (mit echtem pg-boss wie in `worker.test.ts`), `spendBreakdown groups by stage, run and month`, `jobsFromDb returns zeros without pgboss schema` (in eigener Transaktion `alter schema pgboss rename to pgboss_x`, prüfen, Rollback), `retryJobAction rejects an unknown queue`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implementieren.** `AutoRefresh` auf Übersicht, Läufe, Lauf-Detail und Jobs. Lauf-Detail zeigt eine Tabelle „Fehlgeschlagene Jobs“ (Queue, Schlüssel, Fehler, Zeit, Knopf „Erneut“). Kostenseite bekommt drei Tabellen „nach Stufe“, „nach Lauf“ (mit Link), „nach Monat“.
- [ ] **Step 4: Run** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): auto refresh, retry failed jobs, cost breakdown`

---

## Teil B – Gazetteer und Kacheln

### Task 4: Geo-Schema, Zeitachse und Trigger

**Files:**
- Create: `lib/db/geometry.ts`, `lib/db/schema/geo.ts`, `lib/domain/timeline.ts`, Migration (generiert) + handgeschriebene Migration `drizzle/00NN_geo_triggers.sql`
- Modify: `lib/db/schema/index.ts`, `package.json` (`@types/geojson` dev)
- Test: `lib/db/__tests__/geo-schema.test.ts`, `lib/domain/__tests__/timeline.test.ts`

**Interfaces:**
- Produces:
  - `geometry(name: string, type: "Geometry" | "Point" | "Polygon" | "MultiPolygon")` – Drizzle-`customType`, SQL-Typ `geometry(<type>,4326)`, Treiberwert ist der rohe String (nie direkt verwendet).
  - `geomFromGeoJson(g: GeoJSON.Geometry): SQL` → `ST_SetSRID(ST_GeomFromGeoJSON(<json>), 4326)`; `asGeoJson(col: AnyColumn | SQL): SQL<GeoJSON.Geometry>` → `ST_AsGeoJSON(col)::json`.
  - Enums: `geo_object_type` (`sea, area, gulf, island, islet, archipelago, coast_section, cape, strait, channel, bay, harbour, settlement, poi`), `geo_origin` (`osm, geonames, wikidata, text, review, computed, manual`), `poi_category` (`food, supply, beach, nature, active, culture, town`), `name_origin` (`osm, geonames, wikidata, text, review, manual, transliteration, fallback`), `name_script` (`latin, greek`), `place_kind` (`anchorage, port, marina, mooring_field`), `place_status` (`candidate, confirmed, rejected, abandoned, no_anchoring`), `restricted_kind` (`military, cable, protected_area, aquaculture, ferry_lane, firing_area`). Typen `GeoObjectType`, `PlaceKind`, `PlaceStatus`, … wie in `review.ts` exportiert.
  - `geo_objects`: Felder aus Spec 02 plus `config_key text` (nur `area`/`coast_section` aus Konfiguration), `tags jsonb not null default '{}'` (OSM-Tags `place, natural, seamark:*, leisure, harbour, mooring, historic, tourism, amenity, shop`), `merged_into_id uuid`, `updated_at`. `centroid` als generierte Spalte `ST_PointOnSurface(geom)` (liegt bei konkaven Buchten auf der Fläche). Partielle Unique-Indizes `where valid_to is null` auf `osm_id`, `wikidata_id`, `geonames_id`, `config_key`; Unique auf `public_id`; GIST auf `geom` und `centroid`.
  - `geo_names`: Spec 02; Unique `(geo_object_id, name, language, origin) where valid_to is null`; GIN `gin_trgm_ops` auf `name_normalized`.
  - `tiles`: `id text` PK, `bbox geometry(Polygon)`, `area_id uuid` → `geo_objects`, `has_coast bool default false`, `priority int default 0`, `cycle_days int default 30`, `last_run_at`, `next_run_at`, `valid_from date default current_date`, `valid_to date`, `created_at`.
  - `tile_geo_objects(tile_id, geo_object_id)` PK beide.
  - `places`: Spec 02 (`geo_object_id` unique), `updated_at`.
  - `restricted_areas`: Spec 02 (`source_id uuid` ohne FK bis M3).
  - `land_polygons(id, geom geometry(Polygon), dataset_version text, created_at)`, GIST.
  - `comparison_set(place_id uuid PK → places, area_id uuid → geo_objects, added_by text, added_at)`.
  - SQL-Funktion `tile_id_for(g geometry) returns text` (immutable, gleiche Formel wie Global Constraints, auf `ST_X/ST_Y` des Punkts).
  - Trigger `places_set_tile` (BEFORE INSERT OR UPDATE OF position): `NEW.tile_id := tile_id_for(NEW.position)`.
  - Funktion `forbid_delete()` und Trigger auf allen fünf stabilen Tabellen.
  - Funktion `record_history(core text)` (Spaltenliste kommasepariert) und Tabellen `geo_objects_history`, `geo_names_history`, `places_history`, `tiles_history` mit `(history_id bigserial, row_id uuid|text, old_row jsonb, changed_at timestamptz default now())`; BEFORE UPDATE, schreibt `to_jsonb(OLD)`, wenn sich eine Kernspalte ändert. Kernspalten: `geo_objects`: `type, geom, parent_id, valid_to`; `geo_names`: `name, language, valid_to`; `places`: `kind, status, position, anchor_position, merged_into_id, valid_to`; `tiles`: `area_id, has_coast, valid_to`.
  - `validAt(table: { validFrom: AnyColumn; validTo: AnyColumn }, date?: string): SQL` in `lib/domain/timeline.ts` – `valid_from <= d and (valid_to is null or valid_to > d)`, `d` default `current_date`. Einzige Stelle dieser Regel.

- [ ] **Step 1: Failing tests**

```ts
it.each(["geo_objects", "geo_names", "places", "tiles", "restricted_areas"])("%s rejects DELETE", …);
it("changing geo_objects.geom writes one history row; changing tags writes none", …);
it("places.tile_id follows position, including a point exactly on a tile edge", async () => {
  // position (23.25, 37.75) → "q025:813:511"
});
it("osm_id is unique only among valid rows", …); // second row after valid_to set is allowed
it("validAt excludes rows that ended on the date and includes rows starting on it", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/db lib/domain/__tests__/timeline.test.ts` → FAIL.
- [ ] **Step 3: Implementieren.** `npm run db:generate`, dann handgeschriebene Migration für Funktionen, Trigger, generierte Spalte (falls drizzle-kit sie nicht erzeugt) und History-Tabellen, mit `--> statement-breakpoint` wie `0002_forbid_mutation.sql`; Journal-Eintrag anlegen.
- [ ] **Step 4: Run** `npx vitest run` → PASS (alle bisherigen Tests bleiben grün).
- [ ] **Step 5: Commit** `feat(db): gazetteer, tiles, places schema with history and delete guards`

### Task 5: Kachel-Mathematik

**Files:**
- Create: `lib/domain/tiles.ts`
- Test: `lib/domain/__tests__/tiles.test.ts`

**Interfaces:**
- Produces:
  - `type Bbox = [west: number, south: number, east: number, north: number]`
  - `TILE_SIZE = 0.25`, `TILE_PREFIX = "q025"`
  - `tileIdFor(lon: number, lat: number): string` – wirft `RangeError` für `lon ∉ [-180, 180)` oder `lat ∉ [-90, 90)`
  - `parseTileId(id: string): { col: number; row: number }` – wirft bei falschem Format
  - `tileBbox(id: string): Bbox`
  - `tileNeighbours(id: string): string[]` – 8 Nachbarn, Reihenfolge N, NO, O, SO, S, SW, W, NW; am Pol werden fehlende ausgelassen
  - `tilesInBbox(bbox: Bbox): string[]` – alle Kacheln, die die Box schneiden; eine Ostkante exakt auf einer Kachelgrenze schließt die östliche Kachel aus

- [ ] **Step 1: Failing tests**

```ts
expect(tileIdFor(23.25, 37.75)).toBe("q025:813:511");
expect(tileIdFor(23.2499, 37.7499)).toBe("q025:812:510");
expect(tileIdFor(-0.0001, 0)).toBe("q025:719:360");
expect(() => tileIdFor(180, 0)).toThrow(RangeError);
expect(tileBbox("q025:813:510")).toEqual([23.25, 37.5, 23.5, 37.75]);
expect(tilesInBbox([23.0, 37.0, 23.75, 38.0])).toHaveLength(12);
expect(tileNeighbours("q025:813:510")).toHaveLength(8);
it("tile_id_for in SQL agrees with tileIdFor on 200 points incl. edges", …); // DB-Test
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(domain): tile math`

### Task 6: Revier-, Kategorie- und Gazetteer-Konfiguration

**Files:**
- Create: `config/areas/saronic.json`, `config/areas/argolic.json`, `config/categories.json`, `config/gazetteer.json`, `lib/domain/gazetteer/areas.ts`
- Modify: `lib/config/schemas.ts`, `lib/config/index.ts`, `app/(admin)/settings/page.tsx`
- Test: `lib/config/__tests__/config.test.ts`, `lib/domain/gazetteer/__tests__/areas.test.ts`

**Interfaces:**
- Produces:
  - `areaConfigSchema`: `{ key: string (/^[a-z][a-z0-9-]*$/, = Dateiname), names: Record<lang, string> (muss de, en, el enthalten), polygon: GeoJSON Polygon | MultiPolygon, tileBbox: Bbox | null, sourceLanguages: string[], season: { fromMonth: 1–12; toMonth: 1–12 }, cycleDays: int ≥ 1, coastSections: Array<{ key; names; polygon }> }`
  - `categoriesSchema`: `{ osm: Array<{ key: string; values: string[] | "*"; category: PoiCategory }>, wikidata: Record<"Q…", PoiCategory> }`
  - `gazetteerSchema`: `{ overpass: { endpoint: url; timeoutSeconds: int; ratePerMinute: number }, wikidata: { endpoint: url; languages: string[]; classes: Record<"Q…", GeoObjectType>; ratePerMinute: number }, geonames: { baseUrl: url; countries: string[]; featureCodes: Record<string, GeoObjectType>; refreshDays: int }, bboxBufferKm: number, landBufferKm: number, coastDistanceM: number, islandParentBufferM: number, merge: { trigramMin: number; uncertainTrigramMin: number; distanceM: Partial<Record<GeoObjectType, number>> & { default: number }; uncertainDistanceFactor: number; wikidataLinkDistanceM: number; geonamesNewObjectRadiusM: number }, noAnchoringKinds: RestrictedKind[] }`
  - Exportierte Typen `AreaConfig`, `CategoriesConfig`, `GazetteerConfig` (je `z.infer`). `AppConfig` erhält `areas: AreaConfig[]`, `categories: CategoriesConfig`, `gazetteer: GazetteerConfig`; `loadConfig` liest alle `config/areas/*.json` und prüft `key === Dateiname` und eindeutige Keys.
  - `areaByKey(key: string): AreaConfig` (wirft bei unbekanntem Key)
  - `syncAreas(db, areas: AreaConfig[]): Promise<Map<string, string>>` – legt je Revier ein `geo_objects` (`type area`, `origin manual`, `config_key`, `public_id ar_…`) und je Küstenabschnitt eines (`type coast_section`, `public_id rg_…`, `config_key "<area>/<section>"`) an oder aktualisiert Geometrie und Namen; liefert `config_key → id`.

Werte:
- `gazetteer.json`: `overpass.endpoint "https://overpass-api.de/api/interpreter"`, `timeoutSeconds 180`, `ratePerMinute 2`; `wikidata.endpoint "https://query.wikidata.org/sparql"`, `languages ["de","en","el","it","hr"]`, `ratePerMinute 10`, `classes { Q23442: island, Q207524: islet, Q33837: archipelago, Q39594: bay, Q185113: cape, Q37901: strait, Q44782: harbour, Q486972: settlement, Q839954: poi, Q44613: poi, Q39715: poi, Q33506: poi, Q40080: poi }`; `geonames.baseUrl "https://download.geonames.org/export/dump"`, `countries ["GR"]`, `refreshDays 30`, `featureCodes { BAY: bay, BAYS: bay, COVE: bay, INLT: bay, CAPE: cape, PT: cape, ISL: island, ISLET: islet, ISLS: archipelago, STRT: strait, CHN: channel, PRT: harbour, MAR: harbour, PPL: settlement, PPLA: settlement, PPLA2: settlement, PPLA3: settlement, PPLX: settlement, PPLL: settlement }`; `bboxBufferKm 5`, `landBufferKm 10`, `coastDistanceM 2000`, `islandParentBufferM 200`; `merge { trigramMin 0.8, uncertainTrigramMin 0.5, distanceM { bay: 300, settlement: 500, harbour: 300, default: 500 }, uncertainDistanceFactor 2, wikidataLinkDistanceM 1000, geonamesNewObjectRadiusM 500 }`; `noAnchoringKinds ["military", "cable", "firing_area"]`.
- `categories.json` nach der Highlight-Tabelle der Quell-Spec: `food`: `amenity=restaurant,cafe,bar,pub,fast_food`; `supply`: `shop=supermarket,convenience,bakery,butcher`, `amenity=fuel,pharmacy,atm,drinking_water`; `beach`: `natural=beach`, `leisure=beach_resort`; `nature`: `natural=cave_entrance,cliff,reef,spring,peak`; `active`: `tourism=viewpoint`, `shop=scuba_diving`; `culture`: `historic=*`, `tourism=museum`, `man_made=lighthouse`; `town`: `amenity=marketplace`. Wikidata: `Q839954, Q44613, Q39715, Q33506 → culture`, `Q40080 → beach`. Wanderwege (`highway=path` mit `sac_scale`) sind Linien und bleiben bis M7 außen vor.
- `saronic.json`: Namen `de "Saronischer Golf"`, `en "Saronic Gulf"`, `el "Σαρωνικός Κόλπος"`; `tileBbox [23.0, 37.0, 23.75, 38.0]`; `sourceLanguages ["de","en","el"]`; `season { fromMonth 4, toMonth 10 }`; `cycleDays 30`; Polygon als Entwurf `[[23.00,37.95],[23.35,38.05],[23.75,38.00],[24.05,37.65],[23.55,37.33],[23.30,37.30],[23.10,37.45],[23.00,37.62],[23.00,37.95]]`; `coastSections`: Methana, Ermioni, Porto Cheli, Epidavros als grobe Rechtecke um die jeweilige Küste (Entwurf). `argolic.json`: `de "Argolischer Golf"`, `en "Argolic Gulf"`, `el "Αργολικός Κόλπος"`, `tileBbox null`, Polygon als Entwurf `[[22.68,37.62],[22.95,37.62],[23.30,37.30],[23.20,37.10],[22.75,36.95],[22.68,37.62]]`. **Beide Polygone und Küstenabschnitte sind Entwürfe; Christian zeichnet sie vor der Abnahme in geojson.io nach (Task 23).**

- [ ] **Step 1: Failing tests** – `loadConfig reads both areas`, `area without an el name is rejected`, `area key must equal file name`, `syncAreas creates area and coast sections once and updates the polygon on change` (zweiter Aufruf ändert Polygon → eine History-Zeile, keine zweite Zeile in `geo_objects`).
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; `/settings` listet Reviere (Key, Namen, Kachelbox, Zyklus) und die aktiven Gazetteer-Schwellen. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(config): areas, categories and gazetteer settings`

### Task 7: Namen – Normalisierung, ELOT 743, Ersatznamen

**Files:**
- Create: `lib/domain/gazetteer/names.ts`
- Test: `lib/domain/gazetteer/__tests__/names.test.ts`

**Interfaces:**
- Produces:
  - `type NameDraft = { name: string; language: string; origin: NameOrigin; isPreferred?: boolean }` (`language` ISO 639-1 oder `"und"`)
  - `isGreek(s: string): boolean` – mehr griechische als lateinische Buchstaben
  - `normalizeName(s: string): string` – NFD, Diakritika entfernen (inkl. Tonos/Diärese), Kleinbuchstaben, `ς → σ`, Satzzeichen zu Leerzeichen, Leerraum zusammenziehen, trimmen
  - `transliterateElot743(s: string): string` – ELOT 743 (Typ 1), Großschreibung je Wort übernommen
  - `addNames(db, geoObjectId: string, names: NameDraft[]): Promise<number>` – schreibt je Name eine Zeile mit `name_normalized` und `script`; für griechische Namen zusätzlich die Transliteration (`language "el"`, `script latin`, `origin transliteration`, `name_normalized` der Transliteration); idempotent über den Unique-Index; gibt die Zahl neuer Zeilen zurück. `isPreferred` je Sprache: erster Name je Sprache mit Herkunft `osm`, sonst erster überhaupt.
  - `ensureFallbackNames(db, geoObjectIds?: string[]): Promise<number>` – für Objekte ohne gültigen `de`-Namen mit `en`-Namen: `de` = bevorzugter `en`-Name, `origin fallback`.

ELOT-743-Regeln (Digraphen vor Einzelbuchstaben prüfen): `αι→ai, ει→ei, οι→oi, ου→ou, υι→yi, γγ→ng, γξ→nx, γχ→nch, γκ→gk, μπ→mp, ντ→nt, τσ→ts, τζ→tz`; `αυ/ευ/ηυ → av/ev/iv` vor Vokal oder `β γ δ ζ λ μ ν ρ`, sonst `af/ef/if` (auch am Wortende); Einzelbuchstaben `α a, β v, γ g, δ d, ε e, ζ z, η i, θ th, ι i, κ k, λ l, μ m, ν n, ξ x, ο o, π p, ρ r, σ/ς s, τ t, υ y, φ f, χ ch, ψ ps, ω o`; Tonos und Diärese werden vorher entfernt (Diärese trennt den Digraphen: `αϊ → ai` als zwei Einzelbuchstaben, `ευ` mit `ϋ` bleibt `ey`).

- [ ] **Step 1: Failing tests**

```ts
it.each([
  ["Αίγινα", "Aigina"], ["Πόρος", "Poros"], ["Ύδρα", "Ydra"], ["Σπέτσες", "Spetses"],
  ["Ερμιόνη", "Ermioni"], ["Μέθανα", "Methana"], ["Αγκίστρι", "Agkistri"],
  ["Πόρτο Χέλι", "Porto Cheli"], ["Επίδαυρος", "Epidavros"], ["Ναύπλιο", "Nafplio"],
  ["Άγιος Γεώργιος", "Agios Georgios"], ["Ντόκος", "Ntokos"], ["Μπούρτζι", "Mpourtzi"],
])("transliterates %s to %s", (el, latin) => expect(transliterateElot743(el)).toBe(latin));
it("normalizes accents, case and final sigma", () => {
  expect(normalizeName("Άγιος  Γεώργιος")).toBe("αγιοσ γεωργιοσ");
  expect(normalizeName("Pórto-Chéli")).toBe("porto cheli");
});
it("addNames writes the Greek name plus its transliteration once", …); // 2 rows, rerun → 0
it("a transliterated name is found by trigram similarity ≥ 0.8 from its common Latin spelling", async () => {
  // name_normalized of "Πόρτο Χέλι" transliteration vs normalizeName("Porto Heli") → similarity ≥ 0.8
});
it("ensureFallbackNames copies en to de with origin fallback, but not where de exists", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(gazetteer): name normalization, ELOT 743, fallback names`

### Task 8: Landpolygone importieren

**Files:**
- Create: `lib/domain/gazetteer/land.ts`, `scripts/import-land-polygons.ts`
- Modify: `package.json` (`shapefile`, `@types/shapefile` dev; Skript `import:land-polygons`), `docs/runbook.md`
- Test: `lib/domain/gazetteer/__tests__/land.test.ts`, Fixture `test/fixtures/land/aegina-west.geojson` (in Task 16 aus echten Daten ersetzt; bis dahin zwei handgeschriebene Inselpolygone)

**Interfaces:**
- Produces:
  - `importLandPolygons(db, features: AsyncIterable<GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>>, bbox: Bbox, datasetVersion: string): Promise<{ inserted: number; replaced: number }>` – in einer Transaktion: vorhandene Polygone, die `bbox` schneiden und eine andere `dataset_version` haben, löschen (Arbeitszustand), Features mit `ST_Intersects` filtern, auf `bbox` zuschneiden (`ST_Intersection`), MultiPolygone in Polygone zerlegen (`ST_Dump`), einfügen. Gleiche Version erneut: keine Dubletten (vorher löschen, was die Box schneidet und dieselbe Version hat).
  - `landCoverage(db, bbox: Bbox): Promise<number>` – Zahl der Landpolygone in der Box (für die Vorbedingung in Task 12).
  - CLI: `npm run import:land-polygons -- --shp <pfad/land_polygons.shp> --area <key> [--version <YYYY-MM-DD>]` – Box = Revier-Polygon-Box ∪ `tileBbox`, erweitert um `landBufferKm`; liest mit `shapefile.open` als Stream.

- [ ] **Step 1: Failing tests** – `imports only polygons intersecting the bbox, clipped to it`, `re-import of the same version yields the same row count`, `a new version replaces the old one inside the bbox but keeps polygons outside`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; Runbook: Abschnitt „Landpolygone“ (Download `https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip`, entpacken, Befehl je Revier, auf dem Server über `docker compose run --rm web npm run import:land-polygons …` mit gemountetem Verzeichnis). **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(gazetteer): land polygon import`

### Task 9: HTTP-Transport mit Fixtures, Overpass- und Wikidata-Client

**Files:**
- Create: `lib/adapters/http.ts`, `lib/adapters/overpass.ts`, `lib/adapters/wikidata.ts`
- Test: `lib/adapters/__tests__/http.test.ts`, `lib/adapters/__tests__/overpass.test.ts`, `lib/adapters/__tests__/wikidata.test.ts`

**Interfaces:**
- Produces:
  - `type HttpRequest = { service: string; operation: string; url: string; method?: "GET" | "POST"; body?: string; headers?: Record<string, string>; timeoutMs: number; ratePerMinute?: number }`
  - `type HttpResponse = { status: number; body: Uint8Array; text(): string }`
  - `type Transport = (req: HttpRequest) => Promise<HttpResponse>`
  - `type CallContext = { db: Db; runId?: string; tileId?: string; stage?: string }`
  - `class RetryableHttpError extends Error` (Status 429, 5xx, Timeout, Netzfehler), `class HttpError extends Error { status }` (übrige 4xx)
  - `httpCall(transport: Transport, req: HttpRequest, ctx: CallContext): Promise<HttpResponse>` – setzt User-Agent, nimmt ein Token aus `takeToken(db, "http:<service>", ratePerMinute)` (wartet `retryAfterMs`, höchstens 60 s, sonst `RetryableHttpError`), ruft den Transport, schreibt `recordExternalCall` (`costEur 0`, `units 1`, `unit "request"`, `meta { status, bytes }`), wirft je nach Status.
  - `fetchTransport: Transport` (echtes `fetch` mit `AbortSignal.timeout`)
  - `fixtureTransport(dir = "test/fixtures/http"): Transport` – Schlüssel `sha256(method + " " + url + "\n" + (body ?? ""))`, Datei `<dir>/<service>/<key>.json` mit `{ request: { method, url, body }, status, bodyBase64 }`; fehlt sie: Fehler `no fixture for <service> <method> <url>`.
  - `recordingTransport(inner: Transport, dir?: string): Transport` – schreibt jede Antwort als Fixture.
  - `getTransport(): Transport` – `fetchTransport` außer `NODE_ENV === "test"`, dann `fixtureTransport()`.
  - `buildGazetteerQuery(bbox: Bbox, categories: CategoriesConfig, timeoutSeconds: number): string` – Overpass QL mit `[out:json][timeout:<t>]`, Box als `(south,west,north,east)`, Abfragen nach Spec 03 Schritt 1 (`relation["place"~"sea|gulf"]`, `relation/way["natural"="bay"]`, `nwr["place"~"^(island|islet|archipelago)$"]`, `node["place"~"^(town|village|hamlet)$"]`, `nwr["natural"~"^(bay|cape|strait|peninsula)$"]`, `nwr["seamark:type"~"^(harbour|anchorage|mooring|small_craft_facility)$"]`, `nwr["leisure"="marina"]`, `nwr["harbour"]`, je Kategorie-Regel ein `nwr[key~values]` mit `["name"]`), Ausgabe `out tags geom;`.
  - `overpassQuery(transport, ql: string, ctx: CallContext, cfg: GazetteerConfig["overpass"]): Promise<{ raw: string; elements: OverpassElement[] }>` – POST `data=<ql>`; ungültiges JSON oder `remark` mit „runtime error“/„timed out“ → `RetryableHttpError`.
  - `type OverpassElement = { type: "node" | "way" | "relation"; id: number; tags?: Record<string, string>; lat?: number; lon?: number; geometry?: Array<{ lat: number; lon: number }>; members?: Array<{ type: string; ref: number; role: string; geometry?: Array<{ lat: number; lon: number }> }> }`
  - `buildWikidataQuery(bbox: Bbox, classes: string[], languages: string[]): string` – SPARQL mit `wikibase:box`, `?item wdt:P31/wdt:P279* ?class` für `VALUES ?class`, Labels und Aliase in den Sprachen, `OPTIONAL ?osmRel (P402)`.
  - `wikidataQuery(transport, sparql: string, ctx, cfg): Promise<WikidataItem[]>` – GET `?format=json&query=…`; Zeilen je Item zusammengefasst.
  - `type WikidataItem = { id: string; classes: string[]; lon: number; lat: number; labels: Array<{ language: string; value: string; alias: boolean }>; osmRelationId?: string }`

- [ ] **Step 1: Failing tests** – `sets the contact user agent and records an external call with cost 0`, `429 and 503 throw RetryableHttpError, 404 throws HttpError` (Status-Fixtures), `waits for the rate limit token`, `fixtureTransport fails loudly for an unknown request`, `recordingTransport output is replayed by fixtureTransport`, `overpass runtime-error remark is retryable`, `buildGazetteerQuery puts the bbox in south,west,north,east order and includes every category rule`, `wikidataQuery groups labels and aliases per item`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(adapters): http transport with fixtures, overpass and wikidata clients`

### Task 10: GeoNames-Quelle

**Files:**
- Create: `lib/adapters/geonames.ts`
- Modify: `package.json` (`fflate`)
- Test: `lib/adapters/__tests__/geonames.test.ts`, Fixtures `test/fixtures/geonames/GR.txt`, `test/fixtures/geonames/GR-alternate.txt` (je ~20 Zeilen im Aegina-West-Ausschnitt)

**Interfaces:**
- Produces:
  - `type GeonamesRow = { id: string; name: string; asciiName: string; lat: number; lon: number; featureClass: string; featureCode: string; country: string }`
  - `type GeonamesAltName = { geonameId: string; language: string; name: string; isPreferred: boolean; isHistoric: boolean }` (Sprachcodes `link`, `post`, `iata`, … werden verworfen)
  - `type GeonamesSource = { rows(country: string, bbox: Bbox): Promise<GeonamesRow[]>; alternateNames(country: string, ids: Set<string>): Promise<GeonamesAltName[]> }`
  - `createGeonamesSource(deps: { transport: Transport; archive: Archive; ctx: CallContext; cfg: GazetteerConfig["geonames"]; now?: Date }): GeonamesSource` – lädt `<baseUrl>/<C>.zip` bzw. `<baseUrl>/alternatenames/<C>.zip` nur, wenn unter `datasets/geonames/<C>/<YYYY-MM>.zip` bzw. `…/<C>-alternate/<YYYY-MM>.zip` nichts jünger als `refreshDays` liegt (Schlüssel des laufenden und des Vormonats prüfen); entpackt mit `fflate.unzipSync`; parst TSV (Spalten nach GeoNames-Readme), filtert Box und Feature-Codes.
  - `fixtureGeonamesSource(dir = "test/fixtures/geonames"): GeonamesSource`
  - `getGeonamesSource(ctx: CallContext): GeonamesSource` – unter `NODE_ENV === "test"` die Fixture-Quelle, sonst `createGeonamesSource` mit `getTransport()`, `getArchive()` und `getConfig().gazetteer.geonames`. Die Handler holen Transport und Quellen nur über `getTransport()`/`getGeonamesSource()`.

- [ ] **Step 1: Failing tests** – `parses rows and filters by bbox and feature code`, `drops link/post alternate names and historic names`, `downloads once per month and reuses the archived zip` (Transport-Spy zählt 1 Aufruf bei zwei Läufen im selben Monat, Archiv = lokales S3).
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(adapters): geonames dump source`

### Task 11: Stufe `tiles.ensure`

**Files:**
- Create: `lib/domain/gazetteer/tiles-ensure.ts`, `lib/jobs/handlers/tiles.ts`
- Modify: `lib/jobs/queues.ts`, `lib/jobs/registry.ts`, `config/queues.json`, `lib/domain/review.ts`
- Test: `lib/domain/gazetteer/__tests__/tiles-ensure.test.ts`

**Interfaces:**
- Consumes: `tilesInBbox`, `tileBbox` (Task 5), `syncAreas`, `areaByKey` (Task 6), `createReviewTask`.
- Produces:
  - `hasDecidedTask(db, kind: ReviewKind, subjectId: string): Promise<boolean>` in `lib/domain/review.ts`
  - `ensureTiles(db, area: AreaConfig, areaIds: Map<string, string>): Promise<{ tiles: number; coast: number; withoutArea: number }>` – Kachelmenge = `tilesInBbox(tileBbox)` ∪ `tilesInBbox(bbox(polygon))`; je Kachel Upsert (`bbox`, `has_coast` = schneidet ein Landpolygon); `area_id`: liegt die Kachel in `tileBbox` → dieses Revier; sonst das Revier mit der größten Schnittfläche seines Polygons, sonst `null` (ein schon gesetztes `area_id` aus einer Review-Entscheidung bleibt). Küstenkachel mit `area_id null` → `createReviewTask(coast_tile_without_area, subjectType "tile", subjectId <tileId>, context { areaKey, candidates: [area ids, die die Box der Kachel schneiden] })`, außer `hasDecidedTask` ist wahr.
  - Stage `tiles.ensure` (Queue `tiles.ensure`, concurrency 1): plant einen Job `{ key: areaKey, areaKey }` aus `run.params.areaKey`; Handler ruft `syncAreas(getConfig().areas)` und `ensureTiles`.

- [ ] **Step 1: Failing tests** – `creates the 12 pilot tiles labelled saronic`, `has_coast follows land polygons`, `a coast tile outside every area polygon opens one review task`, `second run creates no tiles or tasks`, `a tile decided as no_area does not reopen` (Aufgabe entschieden → `ensureTiles` erneut → keine offene Aufgabe), `area_id set by review survives a rerun`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(gazetteer): tiles.ensure stage`

### Task 12: Stufe `gazetteer.osm`

**Files:**
- Create: `lib/domain/gazetteer/osm-classify.ts`, `lib/domain/gazetteer/store.ts`, `lib/pipeline/gazetteer/osm.ts`, `lib/jobs/handlers/gazetteer.ts`
- Modify: `lib/jobs/queues.ts`, `lib/jobs/registry.ts`, `config/queues.json`
- Test: `lib/domain/gazetteer/__tests__/osm-classify.test.ts`, `lib/domain/gazetteer/__tests__/store.test.ts`, `lib/pipeline/__tests__/gazetteer-osm.test.ts`

**Interfaces:**
- Consumes: `overpassQuery`, `buildGazetteerQuery`, `getTransport` (Task 9), `addNames` (Task 7), `landCoverage` (Task 8), `getArchive()`.
- Produces:
  - `classifyOsm(tags: Record<string, string>, categories: CategoriesConfig): { type: GeoObjectType; category?: PoiCategory } | null` – Vorrang: `place=sea → sea`, `place=gulf` oder Relation `natural=bay` mit „Gulf/Κόλπος“ im Namen `→ gulf`, `place=island|islet|archipelago`, `natural=cape → cape`, `natural=strait → strait`, `natural=peninsula → coast_section`, `natural=bay → bay`, `leisure=marina` oder `seamark:type=harbour|small_craft_facility` oder `harbour=* → harbour`, `seamark:type=anchorage|mooring → bay`, `place=town|village|hamlet → settlement`, Kategorie-Regel → `poi` mit `category`; ohne `name`/`name:*` → `null`.
  - `osmNames(tags): NameDraft[]` – `name:<lang>` → Sprache; `name` → `el`, wenn griechisch, sonst `und`; `int_name`, `alt_name`, `old_name` (nicht bevorzugt); alle `origin osm`.
  - `type GeoObjectDraft = { type: GeoObjectType; category?: PoiCategory; origin: GeoOrigin; osmId?: string; wikidataId?: string; geonamesId?: string; tags?: Record<string, string>; geometry: GeoJSON.Geometry | { lines: GeoJSON.LineString[] }; names: NameDraft[] }`
  - `upsertGeoObject(db, draft: GeoObjectDraft): Promise<{ id: string; created: boolean }>` – Abgleich über die erste vorhandene externe ID (`osm_id`, `wikidata_id`, `geonames_id`); `{ lines }` wird per `ST_BuildArea(ST_Collect(…))` zum Polygon (leeres Ergebnis → Centroid der Linien als Punkt); bei Änderung von Geometrie/Typ/Tags `update` (History-Trigger greift); vergibt `public_id` nach Typ (Global Constraints); ruft `addNames`.
  - `importOsm(db, input: { area: AreaConfig; runId: string; now?: Date }, deps: { transport: Transport; archive: Archive }): Promise<{ created: number; updated: number; skipped: number; names: number }>` – Vorbedingung `landCoverage > 0`, sonst `Error("land polygons missing for <area> – run npm run import:land-polygons")`; Box = Revier-Box + `bboxBufferKm`; Rohantwort nach S3; alle Upserts in **einer** Transaktion; Siedlungen nur, wenn ≤ `coastDistanceM` von der Landpolygon-Grenze (`ST_DWithin(…::geography, ST_Boundary(…)::geography, d)`); Relationen: `outer`-Member als Linien.
  - Queue `gazetteer.build` (concurrency 1, retryLimit 2, retryDelaySeconds 120, backoff). Stages `gazetteer.osm`, `gazetteer.wikidata`, `gazetteer.geonames`, `gazetteer.hierarchy` liegen alle auf dieser Queue und planen je einen Job `{ key: areaKey, areaKey }`; `gazetteerHandler` verteilt nach `data.stage`.

- [ ] **Step 1: Failing tests** – `classifyOsm` tabellarisch (Marina, Ankerplatz-Seamark, Insel, namenlose Bucht → null, Taverne → poi food, `historic=ruins` → poi culture); `osmNames` mit `name`, `name:de`, `name:en`; `upsertGeoObject builds a polygon from relation outer lines`; `upsert twice → one row, created false`; Pipeline-Test mit Fixture-Overpass-Antwort (handgeschrieben, ~10 Elemente: Insel als Relation, Bucht, Marina, Dorf an der Küste, Dorf 5 km landeinwärts, Taverne):

```ts
it("imports the fixture: island, bay, marina, coastal village and taverna, not the inland village", …);
it("archives the raw overpass response under datasets/overpass/<area>/<date>.json", …);
it("no partial import: a failing upsert rolls back every object of the run", …); // ungültige Geometrie im Fixture
it("missing land polygons fails with a clear message", …);
it("a 429 from overpass leaves the database untouched and throws RetryableHttpError", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(gazetteer): osm import stage`

### Task 13: Zusammenführungsregeln

**Files:**
- Create: `lib/domain/gazetteer/merge.ts`
- Test: `lib/domain/gazetteer/__tests__/merge.test.ts`

**Interfaces:**
- Produces:
  - `type MatchInput = { type: GeoObjectType; point: { lon: number; lat: number }; names: string[] }` (Namen roh; normalisiert wird intern)
  - `type Match = { kind: "same"; id: string; similarity: number; distanceM: number } | { kind: "uncertain"; id: string; similarity: number; distanceM: number } | { kind: "none" }`
  - `findMatch(db, input: MatchInput, rules: GazetteerConfig["merge"], opts?: { distanceM?: number }): Promise<Match>` – Kandidaten: gültige Objekte derselben Typgruppe (`island/islet` gemeinsam, sonst gleicher Typ). Abstand `d` = `opts.distanceM ?? distanceM[type] ?? default`; Inseln/Islets: „im Abstand“ heißt Punkt in Polygon (Polygon-Kandidat) oder ≤ `d` (Punkt-Kandidat). Ähnlichkeit = max `similarity(name_normalized, normalizeName(n))` über alle Namen beider Seiten (pg_trgm, inkl. Transliterationen). `same`: Ähnlichkeit ≥ `trigramMin` und im Abstand; `uncertain`: (≥ `trigramMin` und ≤ `d × uncertainDistanceFactor`) oder (≥ `uncertainTrigramMin` und im Abstand). Mehrere: höchste Ähnlichkeit, dann kleinster Abstand.
  - `openPairTask(db, a: string, b: string, context: { similarity: number; distanceM: number; source: GeoOrigin }): Promise<void>` – `place_candidate`, `subjectType "geo_object_pair"`, `subjectId "<kleinere id>:<größere id>"`; nicht, wenn `hasDecidedTask` wahr.
  - `mergeGeoObjects(db, keepId: string, dropId: string): Promise<void>` – Namen von `drop` als neue Zeilen an `keep` (`addNames`), alte mit `valid_to = today`; fehlende externe IDs übernehmen; Kinder umhängen; `drop.merged_into_id = keep`, `valid_to = today`; hat `drop` einen Ort und `keep` auch: Ort von `drop` `status rejected`, `merged_into_id` = Ort von `keep`; hat nur `drop` einen Ort: Ort auf `keep` umhängen.

- [ ] **Step 1: Failing tests** mit konstruierten Paaren:

```ts
it("same bay: 'Ormos Klima' vs 'Όρμος Κλήμα' 150 m apart → same", …);
it("same name 450 m apart for a bay → uncertain (threshold 300, factor 2)", …);
it("similar name 0.6 within 300 m → uncertain", …);
it("different type (harbour vs bay) never matches", …);
it("island: point inside the island polygon with matching name → same", …);
it("islet point matches an island polygon of the same name", …);
it("mergeGeoObjects moves names and children and ends the dropped object", …);
it("openPairTask is idempotent and respects a decided 'distinct'", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(gazetteer): merge rules`

### Task 14: Stufe `gazetteer.wikidata`

**Files:**
- Create: `lib/pipeline/gazetteer/wikidata.ts`
- Modify: `lib/jobs/handlers/gazetteer.ts`
- Test: `lib/pipeline/__tests__/gazetteer-wikidata.test.ts`

**Interfaces:**
- Consumes: `wikidataQuery`, `buildWikidataQuery` (Task 9), `upsertGeoObject` (Task 12), `findMatch`, `openPairTask` (Task 13), `addNames`.
- Produces: `importWikidata(db, input: { area: AreaConfig; runId: string }, deps: { transport: Transport }): Promise<{ linked: number; created: number; uncertain: number; names: number }>` – Typ aus `wikidata.classes` (erste passende Klasse; POI-Kategorie aus `categories.wikidata`). Reihenfolge je Item: (1) Objekt mit `wikidata_id` = Item → Namen ergänzen; (2) Objekt, dessen OSM-Tag `wikidata` = Item (`tags->>'wikidata'`) → `wikidata_id` setzen, Namen ergänzen; (3) `findMatch(…, { distanceM: wikidataLinkDistanceM })`: `same` → verknüpfen, `uncertain` → neues Objekt (`origin wikidata`) + `openPairTask`, `none` → neues Objekt nur für Typen `poi`, `island`, `islet`, `cape`, `bay`; Siedlungen und Häfen ohne OSM-Gegenstück werden übersprungen (OSM ist für diese vollständiger). Labels → `origin wikidata`, Aliase nicht bevorzugt. Eine Transaktion.

- [ ] **Step 1: Failing tests** (Fixture-SPARQL-Antwort, handgeschrieben): `links via osm wikidata tag`, `links by name within 1 km`, `creates a monastery poi with category culture`, `uncertain match opens a pair task`, `second run changes nothing`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(gazetteer): wikidata stage`

### Task 15: Stufe `gazetteer.geonames`

**Files:**
- Create: `lib/pipeline/gazetteer/geonames.ts`
- Modify: `lib/jobs/handlers/gazetteer.ts`
- Test: `lib/pipeline/__tests__/gazetteer-geonames.test.ts`

**Interfaces:**
- Consumes: `GeonamesSource` (Task 10), `findMatch` (Task 13), `upsertGeoObject`, `addNames`.
- Produces: `importGeonames(db, input: { area: AreaConfig; runId: string }, deps: { source: GeonamesSource }): Promise<{ linked: number; created: number; skipped: number; names: number }>` – Typ aus `featureCodes`. Je Zeile: (1) Objekt mit `geonames_id` → Namen; (2) `findMatch(…, { distanceM: geonamesNewObjectRadiusM })` `same` → `geonames_id` setzen, Namen; (3) sonst: gibt es irgendein gültiges Objekt desselben Typs im Umkreis `geonamesNewObjectRadiusM` → `skipped` (Spec 03: nur ergänzen); sonst neues Objekt `origin geonames`. Namen: `name` (Sprache per `isGreek`), `asciiName` als `en` nur, wenn kein `en`-Alternativname existiert, Alternativnamen mit Sprache. Eine Transaktion.

- [ ] **Step 1: Failing tests** – `adds Greek and German alternate names to the matching OSM bay`, `skips an unmatched bay within 500 m of another bay`, `creates a cape that OSM lacks`, `second run changes nothing`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(gazetteer): geonames stage`

### Task 16: Hierarchie, Kachel-Zuordnung, Gazetteer-Lauf und Integrationstest Ägina-West

**Files:**
- Create: `lib/domain/gazetteer/hierarchy.ts`, `lib/pipeline/gazetteer/stages.ts`, `scripts/fixtures-record.ts`
- Modify: `lib/jobs/handlers/gazetteer.ts`, `lib/jobs/registry.ts`, `package.json` (Skript `fixtures:record`)
- Test: `lib/domain/gazetteer/__tests__/hierarchy.test.ts`, `lib/pipeline/__tests__/gazetteer-run.test.ts`, Fixtures unter `test/fixtures/http/{overpass,wikidata}/`, `test/fixtures/geonames/`, `test/fixtures/land/aegina-west.geojson`, `test/fixtures/areas/aegina-west.json` (Test-Revier = Kachel `q025:813:510`, `tileBbox` = diese Kachel)

**Interfaces:**
- Produces:
  - `assignParents(db, areaKey: string): Promise<{ updated: number }>` – für alle gültigen Objekte, deren Centroid in Revier-Box + Puffer liegt, in dieser Reihenfolge per SQL:
    1. `area` → kleinstes `sea`/`gulf`-Polygon, das den Centroid enthält, sonst `null`.
    2. `coast_section` → sein Revier (aus `config_key`).
    3. `archipelago`, `gulf` → kleinstes enthaltendes `area`.
    4. `island`, `islet` → kleinstes enthaltendes `archipelago`, sonst kleinstes `area`.
    5. `bay`, `harbour`, `settlement`, `poi`, `cape`, `strait`, `channel` → kleinste `island`/`islet` (Polygon, gepuffert um `islandParentBufferM` über `::geography`) oder `coast_section`, die den Centroid enthält; sonst kleinstes `area`; sonst kleinstes `sea`/`gulf`.
    Nur geänderte `parent_id` werden geschrieben (History-Trigger).
  - `assignTiles(db, areaKey: string): Promise<{ links: number }>` – `tile_geo_objects` für die Kacheln des Reviers löschen und per `ST_Intersects(tile.bbox, geom)` neu schreiben.
  - Stage `gazetteer.hierarchy`: `assignParents`, `assignTiles`, `ensureFallbackNames`.
  - `GAZETTEER_STAGES = ["tiles.ensure", "gazetteer.osm", "gazetteer.wikidata", "gazetteer.geonames", "gazetteer.hierarchy"] as const` in `lib/pipeline/gazetteer/stages.ts`, dazu `startGazetteerRun(db, boss, areaKey: string, triggeredBy: string): Promise<{ id: string }>` → `startRun({ kind: "stage", scope: { type: "area", id: areaKey }, stages: [...GAZETTEER_STAGES], params: { areaKey }, triggeredBy })`.
  - `scripts/fixtures-record.ts --area <key> [--land <shp>]` – führt die drei Importe mit `recordingTransport(fetchTransport)` gegen eine Wegwerf-DB aus (`DATABASE_URL` Pflicht, Name muss auf `_scratch` enden) und schreibt die Fixtures; mit `--land` zusätzlich `test/fixtures/land/<area>.geojson`. Echte GeoNames-Zeilen der Box werden nach `test/fixtures/geonames/` geschnitten.

- [ ] **Step 1: Failing unit tests (synthetische Polygone)** – `bay inside an island buffer gets the island`, `bay on the mainland without coast section gets the area`, `bay inside a coast section gets the section`, `island gets the smallest containing area`, `area gets the containing sea`, `assignTiles links a polygon to every tile it touches`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implementieren** (`assignParents`, `assignTiles`, Stage, `startGazetteerRun`).
- [ ] **Step 4: Run Unit-Tests** → PASS.
- [ ] **Step 5: Fixtures aufzeichnen** – `npm run fixtures:record -- --area aegina-west --land <land_polygons.shp>` (Netz nötig; ohne Netzzugang an Christian übergeben und Task hier anhalten).
Expected: Dateien unter `test/fixtures/http/overpass/`, `…/wikidata/`, `test/fixtures/geonames/`, `test/fixtures/land/aegina-west.geojson`.
- [ ] **Step 6: Integrationstest schreiben** – ganzer Lauf über den echten Worker (wie `worker.test.ts`); `NODE_ENV=test` wählt `fixtureTransport` und `fixtureGeonamesSource`; `@/lib/config` wird per `vi.mock` so ergänzt, dass `getConfig().areas` das Test-Revier `aegina-west` enthält:

```ts
it("builds the Aegina-West gazetteer", async () => {
  // run status finished, all 5 stages finished
  // islands Aegina and Agistri exist, each with names in de, en and el
  // Perdika (settlement) → parent Aegina; Aegina → parent area "aegina-west"
  // object count per type equals the counts printed by fixtures:record (fixed in the test)
});
it("second run creates no new geo objects, names, tile links or review tasks", …);
```

- [ ] **Step 7: Run** `npx vitest run lib/pipeline` → PASS.
- [ ] **Step 8: Commit** `feat(gazetteer): hierarchy, tile links, gazetteer run with Aegina-West integration test`

### Task 17: Stufe `seed.tile`

**Files:**
- Create: `lib/domain/seed.ts`, `lib/pipeline/seed.ts`, `lib/jobs/handlers/seed.ts`
- Modify: `lib/jobs/queues.ts`, `lib/jobs/registry.ts`, `config/queues.json`
- Test: `lib/domain/__tests__/seed.test.ts`, `lib/pipeline/__tests__/seed.test.ts`

**Interfaces:**
- Produces:
  - `placeKindFromTags(type: GeoObjectType, tags: Record<string, string>): PlaceKind` – `leisure=marina` oder `seamark:type=small_craft_facility` → `marina`; `seamark:type=mooring` oder `mooring=*` → `mooring_field`; `type harbour` oder `seamark:type=harbour` → `port`; sonst `anchorage`.
  - `seedTile(db, tileId: string, cfg: GazetteerConfig): Promise<{ created: number; existing: number; skippedOtherTile: number; noAnchoring: number }>` – Kandidaten: gültige Objekte der Kachel (`tile_geo_objects`) vom Typ `bay`/`harbour` oder mit `tags->>'seamark:type'` ∈ (`harbour`, `anchorage`, `mooring`, `small_craft_facility`) oder `tags->>'leisure' = 'marina'`, ohne `merged_into_id`. Position: Punkt → Punkt; Polygon → `ST_Centroid(ST_Difference(geom, Land der Box))`, liegt sie nicht in der Wasserfläche → `ST_PointOnSurface` der Wasserfläche; leere Wasserfläche → `ST_PointOnSurface(geom)`. Nur Kandidaten mit `tile_id_for(position) = tileId` (sonst `skippedOtherTile`). Insert `places` (`on conflict (geo_object_id) do nothing`); neue Orte: Prüfung gegen gültige `restricted_areas` mit `kind ∈ noAnchoringKinds` → `status no_anchoring`, `status_reason "restricted:<kind>:<id>"`; sonst `createReviewTask(place_candidate, subjectType "place", subjectId <placeId>, context { geoObjectId, kind, tileId })`. Vorhandene Orte bleiben unberührt.
  - Stage `seed.tile` (Queue `seed.tile`, concurrency 2): `params.tileIds` (Liste) oder `params.areaKey` (alle Küstenkacheln mit `area_id` des Reviers); ein Job je Kachel `{ key: tileId, tileId }`.
  - `startSeedRun(db, boss, scope: { tileId: string } | { areaKey: string }, triggeredBy: string): Promise<{ id: string }>` – Umfang `tile` bzw. `area`, Stufe `["seed.tile"]`.

- [ ] **Step 1: Failing tests**

```ts
it.each([...])("placeKindFromTags %o → %s", …);
it("creates one candidate per bay/harbour with a review task", …);
it("bay spanning two tiles yields one place, in the tile of its position", async () => {
  // seedTile for both tiles → exactly 1 place; the other tile reports skippedOtherTile 1
});
it("position of a concave bay polygon lies in water", …); // ST_Within(position, water)
it("a candidate inside a military restricted area becomes no_anchoring without a review task", …);
it("second run creates no places or tasks and keeps a confirmed status", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(seed): seed.tile stage`

### Task 18: Review-Entscheidungen

**Files:**
- Create: `lib/domain/review-decisions.ts`
- Modify: `app/(admin)/runs/[id]/actions.ts` (`retryJobAction` entscheidet eine offene `failed_job`-Aufgabe des Jobs über `decideReviewTask` mit `{ action: "retry" }`, sonst nur `retryFailedJob`)
- Test: `lib/domain/__tests__/review-decisions.test.ts`

**Interfaces:**
- Consumes: `mergeGeoObjects` (Task 13), `newPublicId`.
- Produces:
  - `reviewDecisionSchema` (zod, diskriminiert über `action`):
    - Ort (`place_candidate`/`place`): `{ action: "confirm"; kind: PlaceKind; position?: { lon: number; lat: number } }`, `{ action: "merge"; intoPlaceId: string }`, `{ action: "reject" }`, `{ action: "no_anchoring" }`
    - Paar (`place_candidate`/`geo_object_pair`): `{ action: "same" }`, `{ action: "distinct" }`
    - `coast_tile_without_area`: `{ action: "assign_area"; areaId: string }`, `{ action: "no_area" }`
    - `failed_job`: `{ action: "retry" }`, `{ action: "ignore" }`
  - `type ReviewDecision = z.infer<typeof reviewDecisionSchema>`
  - `class TaskNotOpen extends Error`, `class DecisionNotAllowed extends Error` (Aktion passt nicht zu Art/Subjekt)
  - `decideReviewTask(db, input: { taskId: string; decision: ReviewDecision; decidedBy: string; openedAt?: Date; now?: Date }, deps?: { retryJob?: (queue: string, jobId: string) => Promise<void> }): Promise<void>` – eine Transaktion: Aufgabe `for update` laden, nicht `open` → `TaskNotOpen`; `review_decisions` mit `duration_ms = now - openedAt` (wenn gegeben); Wirkung; Aufgabe `decided` (jede Entscheidung, auch `ignore`/`distinct`/`no_area`; `dismissed` bleibt automatisch erledigten Aufgaben vorbehalten).
    Wirkungen: `confirm` → `status confirmed`, `kind`, optional `position`, `public_id = newPublicId("sp")` wenn leer. `merge` → Ziel muss gültiger Ort ≠ selbst mit Status `candidate`/`confirmed` sein; Ort `status rejected`, `status_reason "merged"`, `merged_into_id`; offene `place_candidate`-Aufgabe des Ziels bleibt. `reject` → `rejected`. `no_anchoring` → `no_anchoring`, `status_reason "review"`. `same` → `mergeGeoObjects(keep, drop)`, `keep` = Objekt mit `osm_id`, sonst das ältere. `assign_area` → `tiles.area_id` (Ziel muss `type area` sein). `retry` → `deps.retryJob(context.queue, subjectId)` (fehlt `deps.retryJob` → Fehler). `distinct`, `no_area`, `ignore` → keine Datenänderung außer Entscheidung und Status.
  - `nextOpenTask(db, kind?: ReviewKind, afterId?: string): Promise<{ id: string } | null>` – älteste offene Aufgabe (höchste `priority` zuerst).

- [ ] **Step 1: Failing tests** – je Aktion ein Test der Wirkung; außerdem:

```ts
it("deciding twice: the second call throws TaskNotOpen and only one decision row exists", async () => {
  await Promise.allSettled([decide(confirm), decide(reject)]); // parallel
  // exactly one fulfilled, one TaskNotOpen; place status matches the fulfilled one
});
it("confirm assigns sp_ once and keeps it on a second confirmation via a new task", …);
it("merge into itself or into a rejected place is DecisionNotAllowed", …);
it("assign_area to a non-area geo object is DecisionNotAllowed", …);
it("records duration_ms from openedAt", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(review): decisions for place candidates, pairs, coast tiles, failed jobs`

### Task 19: Review-Oberfläche

**Files:**
- Create: `app/(admin)/review/page.tsx`, `app/(admin)/review/[id]/page.tsx`, `app/(admin)/review/[id]/actions.ts`, `app/(admin)/_components/decision-keys.tsx`, `app/(admin)/_components/mini-map.tsx`, `lib/domain/review-view.ts`, `e2e/review.spec.ts`
- Modify: `lib/security/route-policy.ts`, `app/(admin)/_components/nav.tsx`, `e2e/global-setup.ts`
- Test: `app/(admin)/__tests__/review-actions.test.ts`, `lib/domain/__tests__/review-view.test.ts`

**Interfaces:**
- Consumes: `decideReviewTask`, `reviewDecisionSchema`, `nextOpenTask` (Task 18), `retryFailedJob` (Task 3).
- Produces:
  - `reviewCounts(db): Promise<Record<ReviewKind, number>>`, `listOpenTasks(db, opts: { kind?: ReviewKind; limit: number; before?: string }): Promise<ReviewTaskRow[]>`
  - `reviewTaskDetail(db, id: string): Promise<ReviewTaskDetail | null>` – Aufgabe plus Kontext je Subjekt: Ort (Name(n), Art, Position, Geo-Objekt, Kachel, nächste 5 Orte mit Abstand für „Einem Ort zuordnen“), Paar (beide Objekte mit Namen, Typ, Herkunft, externen IDs, Abstand, Ähnlichkeit), Kachel (Box, Reviere zur Auswahl), Job (Queue, Schlüssel, Fehler, Lauf-Link).
  - Server Action `decideAction(formData)` – Felder `taskId`, `openedAt` (ISO, versteckt beim Rendern gesetzt), `decision` (JSON) → `reviewDecisionSchema`; danach `redirect` zur nächsten offenen Aufgabe derselben Art oder nach `/review`. `TaskNotOpen` → Redirect auf `/review/<id>?stale=1` mit Hinweis „Bereits entschieden“.
  - Route-Policy: `/review`, `/review/[id]` → admin.
  - `<DecisionKeys />` – Client-Komponente: Tasten `1`–`4` senden das n-te Entscheidungsformular, `n` springt zur nächsten Aufgabe; nicht aktiv, solange ein Eingabefeld Fokus hat.
  - `<MiniMap features={GeoJSON.FeatureCollection} onPick?={(lon, lat) => void} />` – MapLibre-Ausschnitt; im Ortskandidaten setzt ein Klick die Position für „Bestätigen“.

UI-Texte (Deutsch): Seite „Prüfen“ mit Zählern je Art (Labels aus `REVIEW_KIND_LABELS`). Ortskandidat: Knöpfe „Bestätigen“ (Art-Auswahl Ankerplatz/Hafen/Marina/Bojenfeld, vorbelegt), „Einem Ort zuordnen“ (Liste), „Verwerfen“, „Kein Ankerplatz“. Paar: „Gleiches Objekt“, „Verschiedene Objekte“. Küstenkachel: „Revier zuordnen“ (Liste), „Kein Revier nötig“. Fehlgeschlagener Job: „Erneut starten“, „Ignorieren“.

- [ ] **Step 1: Failing tests** – Action-Tests mit Test-DB (Muster wie `app/(admin)/__tests__/actions.test.ts`): `decideAction confirms and redirects to the next candidate`, `invalid decision JSON is rejected without a decision row`, `a stale task redirects with stale=1`, `requires an admin session`; `review-view`: `reviewTaskDetail lists the 5 nearest places for a candidate`; Route-Policy-Test bleibt grün.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren; Nav-Eintrag „Prüfen“ mit Zähler offener Aufgaben.
- [ ] **Step 4: E2E** – `e2e/global-setup.ts` legt einen Ort-Kandidaten mit Aufgabe an; `e2e/review.spec.ts`: Login, `/review`, Ortskandidat öffnen, Taste `1` (Bestätigen), Ort hat Status „Bestätigt“.
Run: `npx vitest run && npm run test:e2e && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): review queue with place candidates, pairs, coast tiles, failed jobs`

### Task 20: Kartendaten und Kartenebenen

**Files:**
- Create: `lib/domain/map-data.ts`, `app/(admin)/map-data/[layer]/route.ts`
- Modify: `app/(admin)/_components/map-view.tsx`, `app/(admin)/map/page.tsx`, `lib/security/route-policy.ts`
- Test: `lib/domain/__tests__/map-data.test.ts`, `app/__tests__/map-data-route.test.ts`

**Interfaces:**
- Produces:
  - `MAP_LAYERS = ["areas", "tiles", "geo-objects", "places"] as const`, `type MapLayer`
  - `mapLayer(db, layer: MapLayer, bbox: Bbox, opts?: { limit?: number }): Promise<GeoJSON.FeatureCollection>` – nur gültige Zeilen, die `bbox` schneiden, höchstens `limit` (Default 5000) Features. Properties: `areas` `{ id, key, name }`; `tiles` `{ id, hasCoast, areaKey, placeCount, candidateCount }`; `geo-objects` `{ id, type, category, name, parentName }` (Name: bevorzugter `de`, sonst `en`, sonst irgendeiner); `places` `{ id, kind, status, name, publicId }`.
  - `GET /map-data/[layer]?bbox=w,s,e,n` – Sitzung nötig (Policy `admin`), zod-Prüfung von Layer und Box (Box höchstens 5° × 5°), Antwort `application/geo+json`, `Cache-Control: no-store`; ungültig → 400.
  - `MapView` – Ebenen-Schalter (Reviere, Kacheln, Geo-Objekte nach Typ, Orte nach Status), lädt je Ebene bei `moveend` (entprellt 300 ms); Farben: Orte `candidate` gelb, `confirmed` grün, `rejected` grau, `no_anchoring` rot; Klick öffnet Seitenleiste mit Name, Typ/Status und Link `/geo/<id>`, `/places/<id>` bzw. `/tiles/<id>`. OSM-Attribution („© OpenStreetMap-Mitwirkende, ODbL“) sichtbar.

- [ ] **Step 1: Failing tests** – `mapLayer returns only features intersecting the bbox`, `places carry status and kind`, `limit caps the feature count`, Route: `400 for an unknown layer or a bbox larger than 5°`, `200 geo+json for a valid request`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren (Next-Doku zu Route Handlers unter `node_modules/next/dist/docs/` vorher lesen). **Step 4:** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): map layers for areas, tiles, gazetteer and places`

### Task 21: Detailseiten und Lauf-Aktionen

**Files:**
- Create: `lib/domain/geo-view.ts`, `app/(admin)/tiles/[id]/page.tsx`, `app/(admin)/tiles/[id]/actions.ts`, `app/(admin)/geo/[id]/page.tsx`, `app/(admin)/places/[id]/page.tsx`
- Modify: `app/(admin)/runs/page.tsx`, `app/(admin)/runs/actions.ts`, `lib/security/route-policy.ts`, `app/(admin)/_components/labels.ts`
- Test: `lib/domain/__tests__/geo-view.test.ts`, `app/(admin)/__tests__/actions.test.ts`

**Interfaces:**
- Consumes: `startGazetteerRun` (Task 16), `startSeedRun` (Task 17).
- Produces:
  - `tileDetail(db, id: string): Promise<TileDetail | null>` – Kachel, Revier, Geo-Objekte (Typ, Name), Orte (Status), letzte 10 Läufe mit `scope = tile` oder Lauf-Parameter mit dieser Kachel, Kosten aus `external_calls.tile_id`.
  - `geoObjectDetail(db, id: string): Promise<GeoObjectDetail | null>` – Namen (alle, mit Sprache, Schrift, Herkunft, bevorzugt, gültig), Eltern-Kette bis zur Wurzel, Kinder (Typ, Name), externe IDs, Ort (falls vorhanden), Kacheln.
  - `placeDetail(db, id: string): Promise<PlaceDetail | null>` – Kopf (Name, Art, Status, Grund, Position, `public_id`, Kachel), offene Review-Aufgabe (Link), Statusverlauf aus `places_history`.
  - Server Actions `startGazetteerAction({ areaKey })` (areaKey ∈ Konfiguration), `startSeedAction({ areaKey } | { tileId })` (tileId per Regex `^q025:\d+:\d+$` und existierend).
  - Route-Policy: `/tiles/[id]`, `/geo/[id]`, `/places/[id]` → admin. Pfadparameter der Kachel kommt URL-kodiert (`q025%3A813%3A510`); `normalizePath` dekodiert einmal – Test ergänzen, dass `/tiles/q025:813:510` passt.
  - Labels: `GEO_OBJECT_TYPE_LABELS`, `PLACE_KIND_LABELS`, `PLACE_STATUS_LABELS`, `NAME_ORIGIN_LABELS` als vollständige `Record`s.

Läufe-Seite: Formular „Gazetteer aufbauen“ (Auswahl Revier) und „Seed für Revier“; Kachelseite: Knopf „Seed“. Die übrigen Kachel-Aktionen aus Spec 09 („Geometrie“, „Quellenfindung“ …) kommen mit ihren Stufen.

- [ ] **Step 1: Failing tests** – Detailfunktionen mit Testdaten (Eltern-Kette Bucht → Insel → Revier → Meer), Actions (`unknown areaKey rejected`, `seed for a tile starts a tile-scoped run`), Route-Policy für `:` im Pfad.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): tile, geo object and place pages; gazetteer and seed actions`

### Task 22: Vergleichssatz auf `/quality`

**Files:**
- Create: `lib/domain/comparison.ts`, `app/(admin)/quality/page.tsx`, `app/(admin)/quality/actions.ts`
- Modify: `lib/security/route-policy.ts`, `app/(admin)/_components/nav.tsx`
- Test: `lib/domain/__tests__/comparison.test.ts`, `app/(admin)/__tests__/actions.test.ts`

**Interfaces:**
- Produces:
  - `COMPARISON_TARGET = 50` (Pilot; Spec 10)
  - `listComparisonCandidates(db, areaKey: string): Promise<Array<{ placeId; name; kind; tileId; inSet: boolean }>>` – bestätigte, gültige Orte in Kacheln mit `area_id` des Reviers.
  - `addToComparisonSet(db, placeId: string, areaKey: string, by: string): Promise<void>` – nur `confirmed`; zweites Hinzufügen ist ein No-op.
  - `removeFromComparisonSet(db, placeId: string): Promise<void>`
  - `comparisonSetSize(db, areaKey: string): Promise<number>`
  - Server Actions `toggleComparisonAction({ placeId, areaKey, include: boolean })`.
  - Route `/quality` → admin. Seite „Qualität“: Abschnitt „Vergleichssatz“ mit Zähler „n von 50“, Liste mit Kontrollkästchen, Filter nach Kachel; Hinweis „Nur Ortsliste, keine Navily-Daten übernehmen“.

- [ ] **Step 1: Failing tests** – `only confirmed places can be added`, `adding twice keeps one row`, `size counts per area`, `comparison_set has no column for foreign values` (Schema-Test: Spalten genau `place_id, area_id, added_by, added_at`).
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(quality): comparison set selection`

### Task 23: Abnahme-Prüfung, Runbook, Übergabe

**Files:**
- Create: `scripts/check-gazetteer.ts`, `docs/pilot/m1-abnahme.md`
- Modify: `package.json` (Skript `check:gazetteer`), `docs/runbook.md`, `docs/m0-folgearbeiten.md` (erledigte Punkte markieren)
- Test: `scripts/__tests__/check-gazetteer.test.ts`

**Interfaces:**
- Produces:
  - `checkGazetteer(db, tileBbox: Bbox): Promise<{ tilesWithCoast: number; missing: Array<{ id: string; type: GeoObjectType; name: string; languages: string[] }>; openCandidateTasks: number }>` – prüft alle gültigen `island`, `islet`, `settlement`, benannten `bay` mit Centroid in der Box auf je einen gültigen Namen in `de`, `en`, `el`.
  - CLI `npm run check:gazetteer -- --area saronic` – gibt die drei Werte aus und endet mit Code 1, wenn `missing` nicht leer ist.

- [ ] **Step 1: Failing test** – `reports an island without an el name and counts coast tiles`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4:** Run → PASS.
- [ ] **Step 5: Runbook** – Abschnitt „Gazetteer und Seed“: Reihenfolge Landpolygone importieren → „Gazetteer aufbauen“ je Revier (`tiles.ensure` synchronisiert jedes Mal alle Reviere aus `config/areas`, die Reihenfolge ist also egal) → „Seed für Revier“ → Review → `check:gazetteer`. `docs/pilot/m1-abnahme.md` als Checkliste der Abnahme aus Roadmap und Spec 03 (Karte zeigt Kacheln, Hierarchie, Kandidaten; Namen de/en/el vollständig; Kachelzahl mit Küste dokumentiert; Kandidaten-Queue abgearbeitet; Vergleichssatz 50 Orte).
- [ ] **Step 6: Gesamtprüfung** – `npm run lint && npm run typecheck && npx vitest run && npm run test:e2e && npm run build` → alles grün.
- [ ] **Step 7: Commit** `docs: M1 acceptance check and runbook`
- [ ] **Step 8: Übergabe an Christian (nicht vom Ausführenden zu erledigen)** – Revier-Polygone und Küstenabschnitte in geojson.io nachzeichnen und einchecken; Landpolygone auf dem Server importieren; Läufe starten; Kandidaten prüfen; Vergleichssatz wählen; `check:gazetteer` grün; Kachelzahl mit Küste in `docs/pilot/m1-abnahme.md` eintragen.

---

## Bewusste Abweichungen und Entscheidungen dieses Plans

- **Wikivoyage (Spec 03, Stufe 1 Schritt 4) rückt nach M3.** Wikivoyage-Artikel als Dokumente brauchen `sources`, `documents` und die Archiv-Regeln aus Teil-Spec 05; sie hier halb anzulegen, hieße das Dokumentmodell vor seinem Design zu bauen. Gelesen werden sie ohnehin erst in Stufe 5 (M3).
- **Revier-Kachel-Label:** `tileBbox` im Revier legt die Kacheln fest, die das Revier als Label tragen (Pilot: alle 12 Kacheln → `saronic`); andere Kacheln bekommen das Revier mit der größten Polygon-Schnittfläche. So bleibt das Pilot-Label der Quell-Spec erhalten und „Küstenkachel ohne Revier“ entsteht dort, wo eine Küstenkachel in keinem Polygon liegt.
- **Unsichere Zusammenführungen** sind `place_candidate`-Aufgaben mit `subjectType "geo_object_pair"` (Spec 03 Schritt 5), mit eigenen Knöpfen „Gleiches Objekt“ / „Verschiedene Objekte“.
- **Landpolygone** kommen per CLI aus der lokal geladenen Datei, nicht per Job: die Datei ist ~900 MB und wird selten erneuert.
- **Review-Facts** (Spec 02: Entscheidungen, die einen Wert setzen, erzeugen einen Fact) entstehen erst mit der `facts`-Tabelle in M4; in M1 setzt „Bestätigen“ Status, Art und Position direkt am Ort, der History-Trigger hält den alten Stand.
