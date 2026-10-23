# Periplus N7 – Raumgliederung stabil, Dinge an Land vom Kandidaten aus – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Einrichtung (Meere, Länder, Landesteile) läuft auf leerer Datenbank ohne Handgriffe durch, jeder Landesteil-Lauf bleibt im Speicher klein, und Dinge an Land werden nur noch in zwei Ringen um Kandidaten geladen statt landesweit.

**Architecture:** Der Lauf „Landesteile neu bilden“ bekommt eine echte Reihenfolge (`gazetteer.seas` → `gazetteer.coarse` → `subdivisions.build` → `subdivisions.assign`), die Mittelmeer-Box kommt aus der Konfiguration. Overpass-Abfragen werden in Teilabfragen mit eigener Wiederholung zerlegt. POIs verschwinden aus dem Landesteil-Gerüst (`gazetteer.osm`, `gazetteer.wikidata`); eine neue Stufe `gazetteer.land` nach `seed.tile` lädt sie in Ringboxen um die Kandidaten und ordnet sie selbst zu. Kleinere Gazetteer-Befunde (B2, B6, B9, B10, B11, B13) werden an Ort und Stelle behoben.

**Tech Stack:** TypeScript, Drizzle + PostgreSQL 17/PostGIS, pg-boss, zod 4, Vitest gegen echte Postgres, Next.js 16 (Admin-Seite).

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-n7-raumgliederung-design.md` (fachlich eingebettet in `2026-10-23-periplus-neuausrichtung-design.md`, Abschnitte 5.1, 5.7, 8, 9).

## Global Constraints

- Branch `feat/n7-raumgliederung` (Worktree `.claude/worktrees/n7-raumgliederung`), Basis `4a75918` wie N1. Kein Rebase auf `main` während der Arbeit.
- **Nie** gegen die geteilten Datenbanken 5433 (Dev) und 5434 (Test) arbeiten. N7 nutzt eigene Container: Dev 5435, Test 5436 (Task 1). Jeder Testlauf mit `TEST_DATABASE_URL=postgres://periplus:periplus@localhost:5436/periplus_test`.
- Migration nur in Task 5 (`drizzle/0069_poi_categories_land.sql`, additiv). Wer später nach `main` kommt, rebased und nummeriert neu (N1: `0069_research`, Umkreis-Lieferung: `0069_radius_packages`).
- Schwellen, Radien, Kategorien, Klassen nur in `config/` (`gazetteer.json`, `categories.json`, `subdivisions.json`, `queues.json`), Schemas in `lib/config/schemas.ts`.
- Fachlogik in `lib/domain/gazetteer`, `lib/domain/subdivisions`, `lib/pipeline/gazetteer`; Job-Handler (`lib/jobs/handlers`) und Seiten dünn.
- Externe Dienste nur über `lib/adapters`; Tests rufen nie das Netz (Fake-`Transport` wie in `lib/pipeline/__tests__/gazetteer-osm.test.ts`).
- Übersprungenes (Relation über Obergrenze, Element außerhalb der Ringe, falscher Typ in `gazetteer.land`) wird geloggt **und** im Ergebnis gezählt; nichts verschwindet still.
- Code, Bezeichner, Logs englisch; Oberfläche deutsch.
- Vor Änderungen an `app/` die Next-16-Doku in `node_modules/next/dist/docs/` zu Server Components/Actions lesen.
- Nach jeder Aufgabe grün: `npx vitest run <betroffene Testdateien>`, `npx tsc --noEmit`, `npm run lint`.
- Commits enden mit `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

- Ein Kandidat nahe der Grenze zweier Landesteile: Die Ringbox reicht in den Nachbarn; läuft `gazetteer.land` für beide, entsteht jedes Ding an Land genau einmal (Test in Task 6).
- `gazetteer.land` zweimal hintereinander für denselben Landesteil: keine Dubletten, zweiter Lauf `created: 0` (Test in Task 6).
- Ein Landesteil ohne Kandidaten (nur `no_anchoring`/`rejected`): `gazetteer.land` endet mit `boxes: 0` ohne Overpass- oder Wikidata-Aufruf (Test in Task 6).
- Eine Overpass-Teilabfrage scheitert auch nach allen Wiederholungen: der Job scheitert mit der Teilabfrage im Fehlertext, die anderen Länder laufen weiter, `subdivisions.build` meldet das fehlende Land (Tests in Task 2 und 3).
- Eine unbenannte Bushaltestelle wird gespeichert, eine unbenannte Taverne nicht; ein Steg mit `harbour=yes` wird von `gazetteer.land` nicht als Hafen angelegt (Tests in Task 5 und 6).

---

### Task 1: Eigene Datenbanken für N7

**Files:**
- Create: `docker/compose.isolated.yml`
- Modify: `vitest.config.mts:101-102`, `package.json` (Skripte), `docs/runbook.md` (kurzer Abschnitt „Parallele Entwicklung mit eigener Datenbank“)

**Interfaces:**
- Produces: Dev-DB `postgres://periplus:periplus@localhost:5435/periplus`, Test-DB `…:5436/periplus_test`; npm-Skripte `services:isolated:up` / `services:isolated:down`.

- [ ] **Step 1:** `docker/compose.isolated.yml` mit `name: periplus-isolated`, Diensten `db` und `db-test` aus `./postgres` wie in `compose.dev.yml`. Ports aus `${PERIPLUS_DB_PORT:-5435}` und `${PERIPLUS_DB_TEST_PORT:-5436}`. `mem_limit: 2g` (db) und `1g` (db-test), damit ein Speicherabsturz den cgroup-OOM des eigenen Containers auslöst und nicht den OOM-Killer der Docker-VM, der den Postgres von N1 treffen könnte. `db-test` mit `tmpfs` und `max_connections=400` wie im Original. Kein S3-Dienst; der geteilte SeaweedFS auf 8333 wird mit Bucket `periplus-n7` genutzt (`S3_BUCKET` in `.env.local` des Worktrees, nicht eingecheckt).
- [ ] **Step 2:** In `vitest.config.mts` `TEST_DATABASE_URL` und `DATABASE_URL` nur als Rückfall setzen: `process.env.TEST_DATABASE_URL ?? "postgres://…:5434/periplus_test"`; `DATABASE_URL` folgt `TEST_DATABASE_URL`.
- [ ] **Step 3:** `package.json`: `"services:isolated:up": "docker compose -f docker/compose.isolated.yml up -d --build"`, `"services:isolated:down": "docker compose -f docker/compose.isolated.yml down"`.
- [ ] **Step 4: Verify**

Run: `npm run services:isolated:up && TEST_DATABASE_URL=postgres://periplus:periplus@localhost:5436/periplus_test npx vitest run lib/pipeline/__tests__/gazetteer-osm.test.ts lib/domain/gazetteer/__tests__`
Expected: PASS. `docker ps` zeigt `periplus-isolated-db-1` auf 5435 und `…-db-test-1` auf 5436; `docker inspect -f '{{.HostConfig.Memory}}' periplus-isolated-db-1` = `2147483648`. Die Dev-DB für die Prüfung in Task 9 wird mit `DATABASE_URL=postgres://periplus:periplus@localhost:5435/periplus npm run db:migrate` aufgesetzt.

- [ ] **Step 5: Commit** — `chore(dev): isolated database pair for parallel work (N7)`

---

### Task 2: Einrichtung ohne Kreis (B3, B14, B2)

**Files:**
- Modify: `config/subdivisions.json`, `lib/config/schemas.ts` (`subdivisionsConfigSchema`), `lib/domain/gazetteer/land.ts:109-126`, `scripts/import-land-polygons.ts`, `lib/pipeline/gazetteer/coarse.ts`, `lib/pipeline/subdivisions.ts`, `lib/pipeline/subdivisions-run.ts`, `lib/jobs/handlers/subdivisions.ts`, `lib/jobs/stages.ts`, `lib/jobs/registry.ts`, `lib/jobs/queues.ts`, `config/queues.json`, `app/(admin)/subdivisions/actions.ts`, `docs/runbook.md` (Abschnitt „Landpolygone“ und neu „Erstinstallation Raumgliederung“)
- Test: `lib/domain/gazetteer/__tests__/land.test.ts`, `lib/pipeline/__tests__/gazetteer-coarse.test.ts`, `lib/pipeline/__tests__/subdivisions-build.test.ts`

**Interfaces:**
- Produces:
  - Konfiguration `subdivisions.mediterranean.bbox: [west, south, east, north]` (Startwert so, dass er die heutige Box aus den Meeren plus `landBufferKm` abdeckt; der Builder rechnet sie einmal aus der Dev-DB nach und trägt sie ein).
  - `mediterraneanBbox(bufferKm: number): Bbox` in `land.ts`: synchron, ohne `db`, aus der Konfiguration, auf das Kachelraster gerundet wie heute.
  - Stufe `gazetteer.seas` (`SEAS_STAGE`, Queue `gazetteer.coarse`, ein Job) mit `importSeas`.
  - `gazetteer.coarse` plant je Land einen Job; mit `run.params.countries: string[]` nur diese.
  - `importCoarseFeatures` ruft **kein** `assignSubdivisions`/`assignSeas`/`assignParents` mehr.
  - Stufe `subdivisions.assign` (`SUBDIVISIONS_ASSIGN_STAGE`, Queue `subdivisions.build`, ein Job je Land) mit `assignCoarse(db: Db, country: string): Promise<{ subdivisions: number; seas: number; parents: number }>` in `lib/pipeline/subdivisions.ts`: `assignSubdivisions`, `assignSeas`, `assignParents` über die Box des Landes.
  - `SUBDIVISIONS_STAGES = [SEAS_STAGE, COARSE_STAGE, SUBDIVISIONS_STAGE, SUBDIVISIONS_ASSIGN_STAGE]`.
  - `startSubdivisionsBuildRun(db, boss, triggeredBy, opts?: { countries?: string[] })` wirft `RunScopeNotReady("land_missing", …)`, wenn `land_polygons` leer ist, bevor ein Lauf entsteht.
  - `buildSubdivisions` wirft `MissingCountries` (Fehlertext nennt alle Codes), wenn für ein konfiguriertes Land kein gültiges Objekt `type = 'country'` mit `tags->>'country' = <code>` existiert.
  - Konfiguration je Land optional `countryRelation: number`; `importCoarse` holt dann diese Relation über `buildRelationQuery` und speichert sie als `country` des Landes, unabhängig von `boundary`/`admin_level` (B2, Palästina `1703814`).

- [ ] **Step 1: Write the failing tests**
  - `land.test.ts`: `mediterraneanBbox(55)` liefert ohne Meere in der DB die Box aus `config.subdivisions.mediterranean.bbox` plus 55 km, auf `TILE_SIZE` gerundet (konkrete Zahlen aus der eingetragenen Box).
  - `gazetteer-coarse.test.ts`:
    - `importCoarseFeatures` setzt bei einer Insel im Land weder `subdivision_id` noch `sea_id`.
    - `importCoarse(db, "PS", …)` mit Fake-Antwort einer Relation `boundary=disputed`, ohne `admin_level`, mit `countryRelation: 1703814` in der Test-Konfiguration, speichert genau ein `country` mit `tags.country = "PS"`.
    - Plan der Stufe `gazetteer.coarse` mit `params.countries = ["GR"]` ist `[{ key: "GR", country: "GR" }]`; ohne Parameter je konfiguriertem Land ein Job und **kein** `seas`-Job mehr.
  - `subdivisions-build.test.ts`:
    - Fehlt für `PS` das Land-Objekt, wirft `buildSubdivisions` einen Fehler, der `PS` nennt, und schreibt keine Zeile in `subdivisions`.
    - `startSubdivisionsBuildRun` auf leerem `land_polygons` wirft `RunScopeNotReady` mit `reason = "land_missing"`, und `runs` bleibt leer.
    - Nach `assignCoarse(db, "GR")` hat die Insel aus dem Fixture `subdivision_id` und `sea_id`.
- [ ] **Step 2: Run tests, verify they fail** — `TEST_DATABASE_URL=…5436… npx vitest run lib/domain/gazetteer/__tests__/land.test.ts lib/pipeline/__tests__/gazetteer-coarse.test.ts lib/pipeline/__tests__/subdivisions-build.test.ts` → FAIL.
- [ ] **Step 3: Implement** die Schnittstellen oben. `scripts/import-land-polygons.ts` ruft `mediterraneanBbox(getConfig().gazetteer.landBufferKm)` ohne `db`. Bestehende Tests, die `mediterraneanBbox(db, …)` oder den `seas`-Job erwarten, werden angepasst. Die Admin-Aktion für „Landesteile neu bilden“ (`app/(admin)/subdivisions/actions.ts`) zeigt `land_missing` mit deutschem Text aus `app/(admin)/_components/labels.ts`. Runbook „Erstinstallation Raumgliederung“ in zwei Schritten: Landpolygone importieren, dann Lauf „Landesteile neu bilden“. Bei fehlenden Ländern denselben Lauf mit `countries` erneut starten (in der Oberfläche ein optionales Feld „nur Länder“).
- [ ] **Step 4: Run tests, verify they pass** — dieselben Dateien plus `lib/pipeline/__tests__/subdivision-build.test.ts` und `lib/jobs/__tests__` → PASS.
- [ ] **Step 5: Commit** — `fix(subdivisions): setup without circular order; seas first, assignment after build (B3, B14, B2)`

---

### Task 3: Overpass in Teilabfragen mit Wiederholung (B15)

**Files:**
- Modify: `lib/adapters/overpass.ts`, `lib/pipeline/gazetteer/coarse.ts`, `lib/pipeline/gazetteer/osm.ts`, `config/gazetteer.json`, `lib/config/schemas.ts` (`gazetteerSchema.overpass`)
- Test: `lib/adapters/__tests__/overpass.test.ts`, `overpass-boundaries.test.ts`, `overpass-coarse.test.ts`, `lib/pipeline/__tests__/gazetteer-coarse.test.ts`

**Interfaces:**
- Produces:
  - Konfiguration `overpass.retries` (Startwert 4) und `overpass.retryDelaySeconds` (Startwert 60, verdoppelt je Versuch), `overpass.blockDeg` (Startwert 2).
  - `overpassQueryRetrying(transport, ql, ctx, cfg, opts?: { sleep?: (ms: number) => Promise<void>; part?: string }): Promise<{ raw: string; elements: OverpassElement[] }>`. Wiederholt bei `RetryableHttpError` (also auch bei 429, 502, 504 und bei `remark` mit Laufzeitfehler) bis `cfg.retries`. Danach wirft sie einen Fehler mit `part` im Text.
  - `buildBoundaryQueries(country, levels, timeoutSeconds): { part: string; ql: string }[]`: die Länder-Relation und je Ebene eine Abfrage.
  - `buildCoarseFeatureQueries(country, cfg, timeoutSeconds, blocks: Bbox[]): { part: string; ql: string }[]`: je Art (`islands`, `bays`, `towns`) und je Block die Abfrage `(area.c)` mit Box.
  - `countryBlocks(bbox: Bbox, blockDeg: number): Bbox[]` (rein, in `lib/domain/gazetteer/land.ts`).
  - Archivschlüssel je Teil: `datasets/overpass/boundaries/<cc>/<date>-<part>.json`, `datasets/overpass/features/<cc>/<date>-<part>.json`.

- [ ] **Step 1: Write the failing tests**
  - `overpass.test.ts`:
    - Fake-Transport antwortet zweimal 502, dann gültig: Ergebnis kommt, drei Aufrufe, `sleep` mit 60.000 und 120.000 ms.
    - Bei fünfmal 502 und `retries: 4` lautet der Fehler `/overpass part islands#3 failed after 5 attempts/`.
    - Für `countryBlocks([19, 34, 29, 42], 2)` gibt es 5 × 4 = 20 Blöcke, die zusammen die Box genau abdecken.
  - `gazetteer-coarse.test.ts`: `importCoarseFeatures` stellt je Art und Block eine Anfrage (Zahl der Transport-Aufrufe = Arten × Blöcke); ein Element, das in zwei Blöcken vorkommt, wird einmal gezählt.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.**
  - `importCoarse` und `importCoarseFeatures` nutzen die Teilabfragen und `overpassQueryRetrying`.
  - `importOsm` nutzt `overpassQueryRetrying` mit der bisherigen Einzelabfrage. Deren Inhalt wird in Task 4 kleiner.
  - `overpassQuery` bleibt für bestehende Aufrufer.
  - `config/queues.json`: `gazetteer.coarse` bekommt `expireInSeconds` ≥ (retries × größter Abstand + Abfragen × Timeout); den Wert rechnet der Builder aus und schreibt ihn in die Commit-Nachricht.
- [ ] **Step 4: Run, verify pass** (plus `lib/pipeline/__tests__/gazetteer-osm.test.ts`).
- [ ] **Step 5: Commit** — `fix(gazetteer): split coarse Overpass queries by kind and block, retry each part (B15)`

---

### Task 4: Große Relationen raus, POIs raus aus dem Gerüst (B5, B6, B16, B8)

**Files:**
- Modify: `lib/adapters/overpass.ts` (`buildGazetteerQuery`), `lib/domain/gazetteer/osm-classify.ts`, `lib/pipeline/gazetteer/osm.ts`, `lib/pipeline/gazetteer/wikidata.ts`, `config/gazetteer.json` (`wikidata.classes` ohne POI-Klassen), `lib/domain/gazetteer/hierarchy.ts` (Regel für OSM-Halbinseln entfällt)
- Test: `lib/domain/gazetteer/__tests__/osm-classify.test.ts`, `lib/pipeline/__tests__/gazetteer-osm.test.ts`, `lib/pipeline/__tests__/gazetteer-wikidata.test.ts`, `lib/domain/gazetteer/__tests__/hierarchy.test.ts`

**Interfaces:**
- Produces:
  - `buildGazetteerQuery(bbox, timeoutSeconds)`: ohne Parameter `categories`, ohne `place=sea`, ohne `natural=peninsula`, ohne Kategorie-Regeln. Golfe (`place=gulf`, `natural=bay`-Relationen) bleiben.
  - `classifyOsm`: `place=sea` → `null`, `natural=peninsula` → `null`. Die Halbinsel-Regel stellt die Spec ins Ermessen des Builders, „im Zweifel verwerfen“; Küstenabschnitte entstehen nur noch aus der Konfiguration (`coast-sections.ts`).
  - `importOsm` speichert keine POIs mehr. Erhält es trotzdem welche, werden sie als `skipped` gezählt.
  - `importWikidata` kennt keine POI-Klassen mehr. Die Logik je Item (Schritte 1–3) wird als `importWikidataItems(tx: Db, items: WikidataItem[], opts: { classes: Record<string, GeoObjectType>; categories: Record<string, PoiCategory>; allowCreate: Set<GeoObjectType> }): Promise<{ linked; created; uncertain; names; skipped }>` exportiert. Task 6 nutzt sie wieder.
  - `maxRelationPoints` bleibt in `importOsm` und `importCoarseFeatures`. Ein Überschreiten wird im Ergebnis gezählt (`skippedLarge`).

- [ ] **Step 1: Write the failing tests**
  - `osm-classify.test.ts`: `{ place: "sea", name: "Aegean Sea" }` → `null`; `{ natural: "peninsula", name: "Peloponnese" }` → `null`.
  - `gazetteer-osm.test.ts`:
    - Die erzeugte Abfrage enthält weder `peninsula` noch `place"~"sea` noch `amenity`.
    - Eine Fake-Antwort mit einem `amenity=restaurant` (benannt) liefert `created` ohne den POI und `skipped ≥ 1`.
    - Eine Relation über `maxRelationPoints` erhöht `skippedLarge`.
  - `gazetteer-wikidata.test.ts`: Ein Item der Klasse `Q839954` (archäologische Stätte) wird nicht angelegt.
  - `hierarchy.test.ts`: Der bestehende Test zur OSM-Halbinsel als Eltern wird entfernt bzw. umgeschrieben. Eine Bucht in einem konfigurierten Küstenabschnitt hängt weiter an ihm.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Die Konfigurationswerte `poiCoastDistanceKm` und `assertSeasPresent` in `osm.ts` und `wikidata.ts` entfallen, sofern sie nur für POIs gelten. Der Builder prüft andere Nutzer (`grep -rn poiCoastDistanceKm lib`) und lässt den Schlüssel stehen, solange einer bleibt.
- [ ] **Step 4: Run, verify pass**, dazu `npx vitest run lib/pipeline/__tests__/gazetteer-run.test.ts lib/pipeline/__tests__/seed.test.ts` (der Seed darf nichts verlieren).
- [ ] **Step 5: Commit** — `refactor(gazetteer): no seas, peninsulas or POIs in the subdivision skeleton (B5, B6, B8, B16)`

---

### Task 5: Kategorien für Dinge an Land, ohne Namen wo sinnvoll

**Files:**
- Create: `drizzle/0069_poi_categories_land.sql` (über `npx drizzle-kit generate`; Inhalt `ALTER TYPE poi_category ADD VALUE 'transport'; … 'landing';`)
- Modify: `lib/db/schema/geo.ts:59`, `config/categories.json`, `lib/config/schemas.ts` (`categoriesSchema`), `lib/domain/gazetteer/osm-classify.ts`, `app/(admin)/_components/labels.ts` (deutsche Namen der neuen Kategorien), alle `Record<PoiCategory, …>`-Stellen, die `tsc` meldet
- Test: `lib/domain/gazetteer/__tests__/osm-classify.test.ts`

**Interfaces:**
- Produces:
  - `PoiCategory` um `transport` und `landing` erweitert.
  - Regel in `categories.osm` mit zwei optionalen Feldern: `ring: "near" | "far"` (Standard `near`) und `unnamed: boolean` (Standard `false`).
  - Neue Regeln:
    - `shop=bakery` → `supply`.
    - `highway=bus_stop`, `amenity=bus_station`, `amenity=taxi`, `amenity=ferry_terminal` → `transport`, `unnamed: true`.
    - `man_made=pier`, `leisure=slipway`, `man_made=jetty` → `landing`, `unnamed: true`.
    - `highway=footway|path` mit `access` nicht `no` und mit `beach`-Bezug: Der Builder prüft, ob es dafür ein belastbares OSM-Tag gibt. Gibt es keins, entfällt „Strandzugang“ in N7 und wird als offen notiert.
  - Bestehende Regeln für `historic=*`, `tourism=museum`, `man_made=lighthouse`, `natural` (außer `beach`) und `tourism=viewpoint` bekommen `ring: "far"`.
  - `classifyOsm(tags, categories, elementType)` prüft den Namen erst nach der Kategorie-Regel. Ein unbenanntes Objekt kommt nur durch, wenn die passende Regel `unnamed: true` trägt. Alle Gerüst-Typen bleiben namenspflichtig.

- [ ] **Step 1: Write the failing tests** (`osm-classify.test.ts`):
  - `{ highway: "bus_stop" }` → `{ type: "poi", category: "transport" }`.
  - `{ amenity: "restaurant" }` ohne Namen → `null`.
  - `{ man_made: "pier" }` → `{ type: "poi", category: "landing" }`.
  - `{ natural: "bay" }` ohne Namen → `null` (Gerüst bleibt namenspflichtig).
  - `{ man_made: "pier", harbour: "yes", name: "X" }` → `harbour` (unverändert; Task 6 filtert).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement**, Migration erzeugen und gegen 5436 anwenden (der Test-Setup migriert).
- [ ] **Step 4: Run, verify pass**; `npx tsc --noEmit` ohne Fehler.
- [ ] **Step 5: Commit** — `feat(gazetteer): transport and landing categories, unnamed only where crews need it`

---

### Task 6: Stufe `gazetteer.land` – Dinge an Land in zwei Ringen

**Files:**
- Create: `lib/domain/gazetteer/rings.ts`, `lib/pipeline/gazetteer/land.ts`, `lib/pipeline/__tests__/gazetteer-land.test.ts`, `lib/domain/gazetteer/__tests__/rings.test.ts`
- Modify: `lib/adapters/overpass.ts` (`buildLandQuery`), `lib/adapters/wikidata.ts` (`buildWikidataQuery` mit optionalem `minSitelinks`), `config/gazetteer.json` + Schema (`land`), `lib/jobs/handlers/gazetteer.ts`, `lib/jobs/stages.ts`, `lib/jobs/registry.ts`, `lib/pipeline/subdivision-build.ts` (`SUBDIVISION_BUILD_STAGES`), `lib/pipeline/gazetteer/stages.ts` (`startLandRun`), `app/(admin)/subdivisions/[key]/` (Schaltfläche „Dinge an Land laden“), `lib/pipeline/tile-scope.ts` (Grund `subdivision_without_candidates`)

**Interfaces:**
- Consumes: `importWikidataItems` (Task 4), `classifyOsm` mit `ring`/`unnamed` (Task 5), `overpassQueryRetrying` (Task 3), `sitelinkCounts` und Tabelle `wikidata_sitelinks` (bestehend), `buildHierarchy(db, scope)` (bestehend).
- Produces:
  - Konfiguration `gazetteer.land`:
    - `nearRadiusM`: 2100
    - `farRadiusM`: 15000
    - `maxBoxKm`: 40
    - `minSitelinks`: 5
    - `farPlaceTypes`: `["town", "village"]`
    - `wikidataClasses`: die bisherigen POI-Klassen aus `wikidata.classes`, mit Kategorie
  - `LAND_STAGE = "gazetteer.land"` (Queue `gazetteer.build`).
  - `type RingCenter = { placeId: string; lon: number; lat: number }`.
  - `ringBoxes(centers: RingCenter[], radiusM: number, maxBoxKm: number): Bbox[]` (rein): Zentren werden gierig zu Boxen höchstens `maxBoxKm` Kantenlänge gruppiert, jede Box um `radiusM` erweitert. Jedes Zentrum liegt in genau einer Box.
  - `withinRing(point: { lon: number; lat: number }, centers: RingCenter[], radiusM: number): boolean` (rein, Haversine).
  - `ringCenters(db: Db, scope: { subdivisionId: string } | { placeIds: string[] }): Promise<RingCenter[]>`: Orte gültig, nicht zusammengeführt, Status `candidate` oder `confirmed` (wie N1), in den Kacheln des Landesteils. Position = Ankerposition, falls berechnet, sonst Schwerpunkt des Geo-Objekts.
  - `importLandThings(db: Db, input: { scope: GazetteerScope; runId: string; placeIds?: string[]; now?: Date }, deps: { transport: Transport; archive: Archive; sleep?: (ms: number) => Promise<void> }): Promise<{ boxes: number; near: number; far: number; created: number; outsideRing: number; belowSitelinks: number; wrongType: number }>`.
    - Nahbereich: Overpass je Box mit den `near`-Regeln, Elemente nur innerhalb `nearRadiusM` eines Zentrums.
    - Fernbereich: Overpass je Box mit `farPlaceTypes` und den `far`-Regeln, nur Elemente mit `wikidata`-Tag. Dazu Wikidata je Box mit `wikidataClasses` und `minSitelinks` im SPARQL (`wikibase:sitelinks`). Für OSM-Objekte mit `wikidata`-Tag holt `sitelinkCounts` die Zahl (Cache `wikidata_sitelinks` wie `lib/pipeline/datasets.ts`); unter `minSitelinks` → `belowSitelinks`.
    - Gespeichert werden nur `poi` und `settlement`; jeder andere Typ zählt als `wrongType`.
    - Wikidata-Items laufen über `importWikidataItems` mit `allowCreate = {poi}`.
    - Rohantworten werden archiviert unter `datasets/overpass/land/<key>/<date>-<ring>-<i>.json`.
    - Danach in derselben Job-Ausführung `buildHierarchy(db, scope)`.
  - `SUBDIVISION_BUILD_STAGES`: `LAND_STAGE` direkt nach `SEED_STAGE`.
  - `startLandRun(db, boss, scope: { subdivisionKey: string } | { subdivisionKey: string; placeIds: string[] }, triggeredBy): Promise<{ id: string }>`: wirft `RunScopeNotReady("subdivision_without_candidates")`, wenn `ringCenters` leer ist.

- [ ] **Step 1: Write the failing tests**
  - `rings.test.ts`:
    - Drei Zentren 1 km auseinander ergeben bei `maxBoxKm` 40 genau eine Box, die alle drei plus 2.100 m umfasst.
    - Zwei Zentren 100 km auseinander ergeben zwei Boxen.
    - `withinRing` liefert für einen Punkt 2.000 m neben dem Zentrum `true`, 2.200 m daneben `false`.
  - `gazetteer-land.test.ts` (`withRollback`, Land und Meer wie in `gazetteer-osm.test.ts`, ein Landesteil mit Kacheln, zwei Kandidaten-Orte und ein `no_anchoring`-Ort, Fake-Transport für Overpass und WDQS):
    - **Nahbereich:** Taverne (benannt) 1 km vom Kandidaten wird angelegt. Eine Taverne 5 km entfernt zählt als `outsideRing`. Eine unbenannte Bushaltestelle 500 m entfernt wird angelegt.
    - **Fernbereich:** Ein OSM-`historic=castle` 10 km entfernt mit `wikidata=Q1` und 12 Sitelinks wird angelegt. Mit 2 Sitelinks zählt es als `belowSitelinks`, ohne `wikidata`-Tag wird es gar nicht angelegt.
    - **Falscher Typ:** Ein `man_made=pier` mit `harbour=yes` und Namen wird nicht als `harbour` angelegt (`wrongType` = 1).
    - **Nicht recherchierte Orte:** Der `no_anchoring`-Ort erzeugt kein Zentrum.
    - **Wiederholung:** Ein zweiter Aufruf liefert `created: 0`, die Zahl der POIs bleibt gleich.
    - **Nachbar-Landesteil:** Ein zweiter Landesteil, dessen Kandidat dieselbe Taverne im Ring hat, legt sie nicht noch einmal an.
    - **Ohne Kandidaten:** Ein Landesteil ohne Kandidaten liefert `boxes: 0`, und der Transport wird nicht aufgerufen.
    - **Zuordnung:** Neue Objekte haben nach dem Aufruf `subdivision_id` und Kachel-Links.
  - Stufen-Test (in `gazetteer-run.test.ts` oder `subdivision-build.test.ts`): `SUBDIVISION_BUILD_STAGES` enthält `gazetteer.land` direkt nach `seed.tile`. `startLandRun` für einen Landesteil ohne Kandidaten wirft `RunScopeNotReady`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** die Schnittstellen oben. Die Schaltfläche auf der Landesteil-Seite ruft `startLandRun`; der deutsche Text für `subdivision_without_candidates` steht in `labels.ts`.
- [ ] **Step 4: Run, verify pass**, dazu `lib/jobs/__tests__` und `lib/pipeline/__tests__/subdivision-build.test.ts`.
- [ ] **Step 5: Commit** — `feat(gazetteer): land things in two rings around candidates (stage gazetteer.land)`

---

### Task 7: Dubletten von Buchten, Wikidata-Häfen, Eltern vor Inseln (B9, B10)

**Files:**
- Modify: `config/gazetteer.json` (`merge.similarNameDistanceM`, `wikidata.classes`-Reihenfolge, `islandParentNearestM`), `lib/config/schemas.ts`, `lib/domain/gazetteer/merge.ts` (`findMatch`), `lib/pipeline/gazetteer/wikidata.ts` (`classify`), `lib/domain/gazetteer/hierarchy.ts` (`smallestIslandOrSection` bzw. neue Regel)
- Test: `lib/domain/gazetteer/__tests__/merge.test.ts`, `lib/pipeline/__tests__/gazetteer-wikidata.test.ts`, `lib/domain/gazetteer/__tests__/hierarchy.test.ts`

**Interfaces:**
- Produces:
  - `merge.similarNameDistanceM: Partial<Record<GeoObjectType, number>>`, Startwert `{ "bay": 1500 }`. In `findMatch` gilt bei Ähnlichkeit ≥ `trigramMin` als Abstand für `same` `max(d, similarNameDistanceM[type])`; `uncertain` bleibt wie heute.
  - `classify` in `wikidata.ts` wählt bei mehreren Klassen eines Items nach fester Vorrangliste: `harbour` vor `bay` vor allen anderen, danach Konfigurationsreihenfolge. Die Liste steht im Code als Konstante, weil sie Typlogik ist und kein Schwellwert.
  - `islandParentNearestM` (Startwert 1000): Eine Bucht, ein Eiland oder ein Kap ohne Insel innerhalb `islandParentBufferM` bekommt die nächste Insel innerhalb `islandParentNearestM`. Das gilt nur, wenn kein Landpolygon außerhalb aller Inselflächen näher liegt; sonst bleibt der Landesteil Eltern.

- [ ] **Step 1: Write the failing tests**
  - `merge.test.ts`:
    - OSM-Bucht „Ligea Bay“ und Eingabe „Liyea Bay“ 900 m entfernt ergeben `same`.
    - Dieselbe Eingabe 1.700 m entfernt ergibt `uncertain`.
    - Eine Siedlung mit 900 m Abstand bleibt bei den heutigen Regeln.
  - `gazetteer-wikidata.test.ts`: Ein Item mit Klassen `[Q39594, Q44782]` ohne OSM-Gegenstück wird nicht angelegt, denn `harbour` steht nicht in `CREATE_WITHOUT_MATCH`; es entsteht keine Bucht.
  - `hierarchy.test.ts` (synthetische Insel und Festland):
    - Ein Buchtpunkt 600 m vor der Insel und 3 km vom Festland bekommt die Insel als Eltern.
    - Ein Buchtpunkt 600 m vor der Insel und 300 m vom Festland bekommt den Landesteil.
    - Ein Buchtpunkt 1.500 m vor der Insel bekommt den Landesteil.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, verify pass** (alle Gazetteer-Tests).
- [ ] **Step 5: Commit** — `fix(gazetteer): merge near bay duplicates, Wikidata harbours stay harbours, bays take the nearest island (B9, B10)`

---

### Task 8: Status je Landesteil ehrlich, Sprache „ohne Sprache“ (B11, B13)

**Files:**
- Modify: `lib/domain/subdivisions/view.ts`, `app/(admin)/subdivisions/page.tsx`, `app/(admin)/subdivisions/status.ts`, `app/(admin)/subdivisions/[key]/page.tsx`, `app/(admin)/_components/labels.ts:57-58`, Stellen, die eine Namenssprache roh ausgeben (`grep -rn "\.language" app` – mindestens `app/(admin)/geo/[id]/page.tsx`)
- Test: `lib/domain/subdivisions/__tests__/view.test.ts`, `app/__tests__/labels-language.test.ts`

**Interfaces:**
- Produces:
  - `SUBDIVISION_STATUSES` um `"teilweise"` erweitert.
  - `subdivisionStatus` liefert `teilweise`, wenn kein Lauf vom Typ `full` fertig ist, aber mindestens eine Stufe aus `SUBDIVISION_BUILD_STAGES` in einem Lauf mit Bereich dieses Landesteils beendet ist. `läuft` gilt für jeden laufenden oder wartenden Lauf mit Bereich dieses Landesteils, nicht nur für `full`.
  - `subdivisionStageHistory(db: Db, key: string): Promise<{ stage: string; finishedAt: string | null; runId: string; runStatus: string }[]>`: je Stufe der jüngste beendete Lauf, aus `run_stages` und `runs`.
  - `CountryNode.expanded: boolean`: wahr, sobald ein Landesteil des Landes `läuft`, `teilweise`, `aufgebaut` oder `fehlgeschlagen` ist.
  - `languageLabel("und")` liefert `"ohne Sprache"`.

- [ ] **Step 1: Write the failing tests**
  - `view.test.ts`:
    - Ein Landesteil mit einem beendeten Lauf vom Typ `stage` über `gazetteer.osm` hat den Status `teilweise`.
    - `subdivisionStageHistory` nennt `gazetteer.osm` mit dem Endzeitpunkt.
    - Ein Land mit diesem Landesteil hat `expanded: true`, ein Land ohne Läufe `false`.
    - Ein laufender Lauf vom Typ `stage` ergibt `läuft`.
  - `labels-language.test.ts`: `languageLabel("und") === "ohne Sprache"`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Die Landesteil-Seite zeigt die Stufenliste als Tabelle („Stufe“, „zuletzt beendet“, „Lauf“). Die Übersicht zeigt `teilweise` mit eigener Farbe. Länder mit `expanded` werden über `open` am `details`-Element aufgeklappt (oder wie die Seite heute auf- und zuklappt).
- [ ] **Step 4: Run, verify pass**; Seite im Browser gegen die Dev-DB 5435 ansehen (`DATABASE_URL=…5435… npm run dev`).
- [ ] **Step 5: Commit** — `fix(subdivisions): show partial builds and stage history; "ohne Sprache" for und (B11, B13)`

---

### Task 9: Prüfung mit echten Daten und Speicher-Nachbesserung

**Files:**
- Modify: `docs/pilot/pruefung/befunde.md` (Spalte „Nachprüfung“ von B2–B16 sowie neue Befunde, falls welche auftauchen), `docs/runbook.md`
- Modify nach Befund: Stellen in `lib/domain/gazetteer`, `lib/domain/subdivisions`, die noch ganze Flächen auf einmal puffern, vereinigen oder vermessen

**Interfaces:**
- Consumes: alles aus Task 1–8; Dev-DB 5435 (Speicherlimit 2 GB), Worker und App gegen 5435 (`DATABASE_URL` in `.env.local` des Worktrees), S3-Bucket `periplus-n7`.

- [ ] **Step 1:** Leere Dev-DB 5435 migrieren. Landpolygone importieren (Shapefile wie im Runbook). Lauf „Landesteile neu bilden“ starten. Messen und festhalten: Dauer je Stufe, Overpass-Wiederholungen (`external_calls`), gescheiterte Länder, Spitzenspeicher (`docker stats --no-stream periplus-isolated-db-1`, minütlich mitschreiben). Erwartet: alle konfigurierten Länder fertig, `subdivisions.build` und `subdivisions.assign` grün.
- [ ] **Step 2:** „Aufbauen“ nacheinander (nie parallel) für `GR-CYC`, `GR-I` und einen großen Landesteil außerhalb Griechenlands. Gewählt wird der mit den meisten Inseln oder der längsten Küste, Vorschlag Dalmatien oder Sizilien. Die Wahl kommt ins Befunde-Dokument. Die Läufe dürfen nach `gazetteer.land` beendet werden (Datensätze vor dem Seed bleiben nötig; Geometrie und Quellenfindung zählen nicht). Messen: Spitzenspeicher, Dauer je Stufe, Zahl der POIs und Orte vorher (B8: 20.252 OSM- und 2.071 Wikidata-POIs in GR-I) und nachher, sowie `outsideRing`, `belowSitelinks`, `wrongType` und `skippedLarge`. Erwartet:
  - Kein Container-OOM.
  - Gazetteer-Stufen und `gazetteer.land` je Landesteil in Minuten.
  - Keine POIs in der Athener Innenstadt ohne Kandidat im Umkreis.
- [ ] **Step 3:** Vollständigkeit des Gerüsts in GR-I. Buchten, Häfen, Marinas und Bojenfelder werden mit Namen und Ort gegen die Dev-DB 5433 verglichen, **nur lesend** (`psql … -c "select …"`, keine Schreibzugriffe). Jedes fehlende Objekt wird erklärt oder als Befund aufgenommen.
- [ ] **Step 4:** Tritt ein OOM oder eine Stufe über 15 Minuten auf, gilt superpowers:systematic-debugging: Ursache mit `EXPLAIN (ANALYZE, BUFFERS)` finden, stückweise umbauen wie bei B1, B4 und B7, Regressionstest, Commit, Messung wiederholen.
- [ ] **Step 5:** `befunde.md` nachtragen (B2, B3, B5, B6, B8–B11, B13–B16 mit Ergebnis der Nachprüfung). Im Runbook „Erstinstallation Raumgliederung“ prüfen, ob die Schritte so stimmen, wie sie gelaufen sind. Commit `docs(pruefung): N7 real-data check of subdivisions and land things`.
- [ ] **Step 6: Verify whole branch** — `TEST_DATABASE_URL=…5436… npx vitest run` (volle Suite), `npx tsc --noEmit`, `npm run lint`, `npm run build` → alles grün; Ergebnis mit Zahlen im Abschlussbericht.
