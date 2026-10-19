# Periplus M6 – Lieferung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Periplus Data Contract v1: je Revier ein Paket (`manifest.json`, `spots.json`, `highlights.json`, `regions.json`, `coast.geojson`, `weather-points.json`, ab der zweiten Lieferung `changes.json`) aus den aktuellen Profilen bauen, gegen alle Validierungsregeln prüfen, gültige und abgelehnte Pakete in S3 archivieren, gültige über `/api/v1` mit API-Schlüssel ausliefern (Paket, Dateien je `dataVersion`, zusammengeführte Änderungen, Spot zum Datum, JSON-Schema), dazu Seite `/deliveries`, Ort-Reiter „Lieferung“ und API-Clients sperren.

**Architecture:** Der Vertrag lebt als zod-Schemas in `contract/v1/`; daraus erzeugt `z.toJSONSchema` die eingecheckten JSON-Schemas unter `contract/schema/1.0/` (Drift-Test). Der Paketbau ist eine Run-Stufe `delivery.build` (ein Job je Revier): `load.ts` liest Revier, Kacheln, Orte, POIs, Regionen mit ihrem jüngsten Profil (M5) aus der DB, reine Abbilder `map-spot.ts`, `map-highlight.ts`, `map-region.ts` bilden Vertragsobjekte, `coast.ts`/`weather-points.ts` rechnen in PostGIS, `versioning.ts` vergibt Vertrags-`profileVersion` über Inhalts-Hashes gegen `delivered_objects`, `changes.ts` bildet `changes.json`, `validate.ts` prüft jede Regel benannt mit Fundstellen, `build.ts` schreibt unter einem Advisory-Lock je Revier Dateien nach S3 und genau eine `deliveries`-Zeile – diese Zeile ist der Commit-Punkt, die API liest nur Zeilen mit Status `valid`. API-Routen sind dünn über `withApiClient` (Scope `delivery:read`) und einen Antwort-Helfer mit ETag/304.

**Tech Stack:** wie M5 (Next.js 16.4.2, React 19.3, Drizzle 0.45, pg-boss 12, zod 4 mit `z.toJSONSchema`, Vitest 5, Playwright 1.64, `@aws-sdk/client-s3`), neu: `ajv@^8` und `ajv-formats@^3` (JSON-Schema-Prüfung beim Bau und im Abnehmer-Skript; das vorhandene `ajv` 6 ist nur transitiv von ESLint).

**Spec:** `docs/superpowers/specs/2026-10-18-periplus-08-liefervertrag-api-design.md` (primär), `…-01-fundament-design.md` (API-Schlüssel, Scopes, Rate-Limit, Route-Policy `api`, Queue `delivery.build`), `…-02-datenmodell-design.md` (`deliveries` nur anfügend, `text_shingles`, `profile_as_of`), `…-09-admin-ui-design.md` (`/deliveries`, Ort-Reiter „Lieferung“, Übersicht „letzte Lieferungen“, `/settings` API-Clients sperren, Playwright „Paket bauen“), `…-10-qualitaet-pilot-design.md` (Abnehmer-Kriterium, Revisit `asOf`), Gesamtdesign `…-periplus-design.md` (Roadmap M6, IDs, Seemeilen, Anti-Ziele). Fachlich maßgebend: `.idea/datendienst-spec.md` Teil B (Lieferprinzip, Lieferpaket, Spot, Highlight, Region, Küste/Wetterpunkte, Versionierung und Change-Feed, Validierungsregeln, Beispiel) ohne die DSTAP-Teile (Gesamtdesign Abschnitt 4). Baut auf M2 (`canonicalJson`, `restricted_areas`, `land_polygons`, Fact-Schema-Typen), M3 (`sources`, `documents`, `document_versions.doc_type`, `text_shingles`, `shingleHashes`), M4 (Fact-Schema v2, `mentions`, `facts`), M5 (`profiles`, `latestProfile`, `profileAsOf`, `profile_summaries`, `change_events.seq`, `popularityForArea`, `findArchiveCopies`, `getConsolidationConfig().importance.radiusNm`) auf.

## Global Constraints

- Alle Global Constraints aus M0–M5 gelten weiter (Next 16.4.2; vor Code an Routen, `proxy.ts`, `next.config.ts` die Next-Doku lesen, hier mindestens `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` und `16-proxy.md`; `cacheComponents` – authentifizierte Routen rufen `await connection()`; kein `console.*`; Englisch im Code, Deutsch in der UI; Tests gegen `db-test` und Test-Bucket, kein Netz, KI nur `MockModel`; Route-Policy für jede Route; Tests zählen nie DB-weit; Geo-Testdaten in `withRollback` oder um 21,0° O / 35,2° N außerhalb der Pilotbox 23,0–23,75° O × 37,0–38,0° N).
- Vertragsname „Periplus Data Contract“, `schemaVersion` „beginnt bei `1.0`“; „Feldnamen camelCase wie in Teil B; Enum-Werte wie in Teil B (`anchorage`, `mooringField` …)“. Entfällt: `legacyIdMap`, Zuordnung zum App-Modell, Alias-Kategorien.
- JSON-Schemas „unter `contract/schema/<version>/` … aus den zod-Schemas erzeugt; Abnehmer beziehen sie über `GET /api/v1/schema/<version>/<file>`“.
- Paket je Revier: `manifest.json`, `spots.json`, `highlights.json`, `regions.json`, `coast.geojson`, `weather-points.json`, „ab der zweiten Lieferung `changes.json`“. S3: `deliveries/<area>/<dataVersion>/<file>`. Zeile `deliveries` (area_id, data_version, schema_version, generated_at, file_hashes, object_counts, validation_report, status `valid`/`rejected`). „Ein abgelehntes Paket wird gespeichert (zur Diagnose), aber nie ausgeliefert.“
- „`dataVersion`: ganze Zahl, je Revier um 1 steigend, nur bei gültigem Paket mit mindestens einer Änderung.“
- „`profileVersion` im Vertrag = Version des Vertragsobjekts … steigt nur, wenn sich das gelieferte Objekt ändert (Hash des serialisierten Objekts ohne Versionsfelder). Tabelle `delivered_objects` (public_id, profile_version, content_hash, first_delivery_id)“.
- `changes.json`: „aus `change_events` zwischen den beiden Paketen, abgebildet auf `created`, `updated`, `excluded`, `merged`, `removed` … mit `severity` aus Teil-Spec 07; enthält genau die Objekte, deren `profileVersion` gestiegen ist.“ Felder `objectType` (`spot`, `highlight`, `region`), `objectId`, `event`, `fields`, `severity` (`info`, `notable`, `safety`), `summary {de}`, `profileVersion`. „`safety` ist gesetzt, wenn sich `exclude`, `shelter` um mehr als 0,2 in einem Sektor, `limits` oder `hazards` geändert haben.“
- „Ausgeschlossene Spots werden mit `exclude.excluded = true` und Grund geliefert … Verworfene oder zusammengelegte Orte: `mergedInto` gesetzt bzw. Ereignis `removed`.“
- `coast.geojson`: „Landpolygone und Küstenlinie aus `land_polygons`, vereinfacht (10 m Toleranz), Revier-Box plus 2 sm; dazu `restrictedArea`-Features aus `restricted_areas`“, Features `kind: land | coastline | restrictedArea`, `source: OpenStreetMap, ODbL`, `extractedAt`, `reason`.
- `weather-points.json`: „Region: Punkt maximaler Wasserdistanz zum Land im Regionspolygon; Enge/Kanal: Mittelpunkt; Kap: 1 sm seewärts entlang der Winkelhalbierenden“; Felder `id`, `name` (de), `position`, `kind` (`region`, `channel`, `cape`), `regionId`.
- Feldzuordnung Profil → Spot „eine Tabelle in `lib/domain/delivery/map-spot.ts` mit einem Test je Feld; `provenance` aus `profiles.provenance`; `sources` = URLs der beteiligten Dokumente (ohne Zitate), `kind` aus `doc_type` (camelCase)“.
- Teil B: „Alle Koordinaten sind WGS84, `lat`/`lon` als Dezimalgrad mit 5 Nachkommastellen. Distanzen in Seemeilen, Tiefen in Metern, Zeiten in ISO 8601 UTC. Texte für die Anzeige sind Deutsch (`de`)“. IDs `sp_`/`hl_`/`rg_`/`ar_` + ULID, „einmal vergeben, nie wiederverwendet“.
- Validierungsregeln (Teil B, jede als benannte Prüfung mit Fundstellen, ein Verstoß blockiert): IDs eindeutig mit richtigem Präfix, jede referenzierte ID (`spotIds`, `highlightIds`, `regionId`, `mergedInto`) in derselben Lieferung; Spot in der Bounding Box und „höchstens 1,5 sm von Wasser entfernt (gegen `coast.geojson` geprüft)“; `shelter.sectors` genau acht Schlüssel 0–1, `swell` 0–1, „`port` und `marina` haben mindestens 0,8 je Sektor, sonst muss `provenance.shelter.source` `text` oder `observed` sein“; `maxDraft` `null` oder 0,5–10, `maxLength` `null` oder 5–100; `exclude.excluded = true` verlangt `reason`; `berth.status = seasonFull` verlangt ≥ 1 Monat; `score.confidence` < 0,3 → `summary.de` mit „wenig belegt“; Highlight mit Kategorie aus der Liste und ≥ 1 `spotId` im Bedeutungsradius (5/10/20/35/50 sm), „sonst wird es nicht geliefert“; keine zwei Spots derselben Art näher als 150 m, keine zwei Highlights gleichen Namens näher als 500 m; kein Textfeld mit mehr als 15 Wörtern wörtlich aus einer Quelle; „`dataVersion` ist größer als die vorherige; `changes.json` enthält jedes Objekt, dessen `profileVersion` sich erhöht hat, und kein anderes“. Dazu Schema-Prüfung jeder Datei (ajv) und „Keine fremden Inhalte: … `externalRefs` nur IDs … keine Felder aus Google/Navily-Quellen“.
- 15-Wörter-Regel: Textfelder `summary`, `character`, `seasonNote.text`, `hazards.text`, Highlight-`summary` „in 15-Wort-Schindeln zerlegt (normalisiert); jede Schindel wird gegen `text_shingles` … geprüft. Ein Treffer = Verstoß.“
- API: „Basis `/api/v1`, JSON, `Authorization: Bearer pk_…`, Antworten mit `schemaVersion` und `dataVersion` im Body bzw. Header `Periplus-Schema-Version`. Fehler als `{ error: { code, message } }` mit 400/401/403/404/429/500, ohne interne Details. `ETag` je Antwort, `Cache-Control: private, max-age=60`. Rate-Limit je Client.“ Scope `delivery:read`. Endpunkte M6: `GET /areas`, `/areas/{area}/package`, `/areas/{area}/package/{file}?dataVersion=`, `/areas/{area}/changes?since={dataVersion}`, `/spots/{id}?asOf=YYYY-MM-DD`, `/schema/{version}/{file}`.
- ODbL: „das Manifest trägt `licenses` mit OSM-Attribution und ODbL-Hinweis für genau diese Dateien/Felder“; `spots.json` „keine OSM-Geometrien …, nur Punkte und eigene Werte“; „vor M6 rechtlich zu prüfen; bis dahin werden Pakete nur intern genutzt“.
- Anti-Ziel: „Fremde Inhalte (Navily-Daten, Google-Inhalte, Textpassagen Dritter) in Lieferungen.“ Kein Zitat verlässt Periplus.
- Tests (Spec 08): „Für jede Validierungsregel ein Test mit einem minimal kaputten Paket. Snapshot-Test: Paket aus Fixture-Profilen gegen eingecheckte erwartete Dateien. API-Tests für Anmeldung, Scopes, `asOf`, `dataVersion`-Archiv, ETag.“ Abnahme M6: „Paket des Pilotreviers besteht alle Validierungsregeln; per API mit Schlüssel abrufbar“; „ein Spot zum Stand vor dem Revisit (M7) abrufbar“.
- Schwellen, Abstände, Lizenztexte, verbotene Domains in `config/delivery.json`, nicht im Code; Vokabular-Abbildungen intern → Vertrag stehen als Tabellen in den `map-*.ts` (Spec 08).

## Review Focus

1. **Neubau ohne Änderung** (zweimal „Paket bauen“, anderer Tag, andere DB-Reihenfolge, Gleitkomma aus Profilen, neues `generatedAt`): keine neue `dataVersion`, keine gestiegene `profileVersion`, keine S3-Schreibvorgänge, Status `unchanged` – sonst erhält die App bei jedem Bau ein „neues“ Paket mit lauter `updated`. → Task 9 Tests `a second build without changes is unchanged and writes nothing`, `shuffled load order gives identical files`; Task 7 Test `generatedAt and validFrom do not enter the content hash`.
2. **Objekte verschwinden zwischen zwei Paketen** (Ort verworfen, aufgegeben, zusammengelegt; POI verliert alle Spots im Radius; Region ohne Spots): keine hängenden Referenzen, `removed`/`merged` in `changes.json`, Version steigt; ein später wieder auftauchendes Objekt bekommt die nächste Version, nie eine alte. → Task 7 Tests `a removed object gets event removed and the next version`, `a reappearing object continues the version`; Task 5 Test `a highlight losing its only spot is dropped and the spot loses the highlight id`; Task 9 Test `a merged place keeps its last content with mergedInto`.
3. **Fremder Text rutscht durch** (Summary übernimmt einen 16-Wort-Satz einer Quelle mit anderen Akzenten/Groß-/Kleinschreibung, Quellen-URL von navily.com oder Google, `externalRefs` mit Freitext): Paket `rejected`, nie über die API sichtbar, Fundstelle mit Objekt-ID im Bericht. → Task 8 Tests `a summary copying 16 words of a chunk with different accents is a violation`, `a navily source url is foreign content`; Task 11 Test `a rejected package is never served`.
4. **Doppelter Bau und Wiederholung** (Doppelklick, zwei Admins, Job-Retry nach Absturz zwischen S3-Upload und Commit): genau eine `dataVersion` je Revier und Inhalt, die API sieht nie ein halbes Paket. → Task 9 Tests `two parallel builds create one data version`, `a failed commit leaves no delivery row and a retry reuses the keys`.
5. **Grenzwerte der API** (unbekanntes Revier/Datei/`dataVersion`, `../` im Dateinamen, `asOf` vor der ersten Lieferung oder ungültig wie `2026-13-45`, `since` gleich/über der aktuellen Version oder 0, `If-None-Match`, widerrufener Schlüssel, falscher Scope): richtiger Status und `{ error: { code, message } }` ohne Interna, 304 ohne Body. → Task 11 Tests `unknown file and traversal are 404`, `If-None-Match returns 304`; Task 12 Tests `asOf before the first delivery is 404`, `an invalid date is 400`, `since equal to the current version is empty, since 0 is 400`.

---

## File Structure

```
contract/v1/{common,spot,highlight,region,weather-point,coast,changes,manifest,index}.ts   zod-Schemas v1
contract/index.ts                         SCHEMA_VERSION, CONTRACT_FILES, contractJsonSchema
contract/schema/1.0/*.schema.json         erzeugt (npm run contract:generate), eingecheckt
scripts/contract-generate.ts
lib/db/schema/deliveries.ts               deliveries, delivered_objects (+ Enums)
drizzle/00NN_*.sql                        generiert + Trigger (forbid_mutation)
config/delivery.json, lib/config/{schemas,index}.ts
lib/domain/delivery/
  types.ts                                DeliveryPackage, AreaScope, SpotSource, …, ValidationReport
  geo.ts                                  distanceNm, pointInPolygon, distanceToLinesNm, round5
  load.ts                                 loadAreaScope
  vocab.ts                                Abbildungstabellen intern → Vertrag, deutsche Textbausteine
  map-spot.ts, map-highlight.ts, map-region.ts
  coast.ts, weather-points.ts
  versioning.ts                           contentHash, assignVersions, latestDelivered
  changes.ts                              buildChanges, changedFields, mergeChanges, eventSeverities
  schema-check.ts                         checkJsonSchema (ajv 2020)
  validate.ts                             validatePackage, CHECK_NAMES
  build.ts                                buildDelivery, serializeFile
  read.ts                                 resolveArea, listAreas, validDelivery, readDeliveryFile, changesSince, spotAsOf
  view.ts                                 listDeliveries, deliveryDetail, placeDelivery
lib/pipeline/delivery.ts                  Stufe delivery.build, startDeliveryRun
lib/jobs/{queues,stages,registry}.ts, lib/jobs/handlers/delivery.ts, config/queues.json
lib/api/{handler,respond}.ts
app/api/v1/areas/route.ts
app/api/v1/areas/[area]/package/route.ts
app/api/v1/areas/[area]/package/[file]/route.ts
app/api/v1/areas/[area]/changes/route.ts
app/api/v1/spots/[id]/route.ts
app/api/v1/schema/[version]/[file]/route.ts
lib/security/route-policy.ts
app/(admin)/deliveries/{page.tsx,actions.ts}, app/(admin)/deliveries/[id]/page.tsx,
app/(admin)/deliveries/[id]/files/[file]/route.ts
app/(admin)/places/[id]/{page.tsx,delivery-tab.tsx}, app/(admin)/settings/{page.tsx,actions.ts},
app/(admin)/page.tsx, app/(admin)/_components/{nav.tsx,labels.ts}, lib/domain/{overview,api-clients}.ts
scripts/delivery-consume.ts, package.json (contract:generate, delivery:consume, ajv, ajv-formats)
test/fixtures/delivery/{area.ts,package.ts,expected/*}
docs/runbook.md, docs/pilot/m6-abnahme.md, e2e/delivery.spec.ts, e2e/global-setup.ts
```

---

### Task 1: Vertrag v1 als zod-Schemas, erzeugte JSON-Schemas, ajv-Prüfer

**Files:**
- Create: `contract/v1/{common,spot,highlight,region,weather-point,coast,changes,manifest,index}.ts`, `contract/index.ts`, `contract/schema/1.0/{manifest,spots,highlights,regions,coast,weather-points,changes}.schema.json` (erzeugt), `scripts/contract-generate.ts`, `lib/domain/delivery/schema-check.ts`
- Modify: `package.json` (`"contract:generate": "tsx scripts/contract-generate.ts"`, Abhängigkeiten `ajv`, `ajv-formats`)
- Test: `contract/__tests__/contract.test.ts`, `lib/domain/delivery/__tests__/schema-check.test.ts`

**Interfaces:**
- Consumes: zod 4 (`z.toJSONSchema`, `z.iso.date()`, `z.iso.datetime()`).
- Produces:
  - `contract/index.ts`: `SCHEMA_VERSION = "1.0"`, `CONTRACT_FILES = ["manifest.json", "spots.json", "highlights.json", "regions.json", "coast.geojson", "weather-points.json", "changes.json"] as const`, `type ContractFile`, `CONTRACT_SCHEMAS: Record<ContractFile, z.ZodType>`, `jsonSchemaFileName(file: ContractFile): string` (`spots.json` → `spots.schema.json`, `coast.geojson` → `coast.schema.json`), `contractJsonSchema(version: string, fileName: string): object | null` (nur `"1.0"`; berechnet über `z.toJSONSchema(schema, { target: "draft-2020-12" })` mit `$id` `periplus:contract/1.0/<fileName>` und `title`).
  - `common.ts`: `latLon = { lat: number −90–90, lon: −180–180 }` (Zahlen mit höchstens 5 Nachkommastellen per `.refine`), `unit = number 0–1`, `isoDate`, `publicId(prefix)` (`^<p>_[0-9A-HJKMNP-TV-Z]{26}$`), `weatherPointId` (`^wp_[0-9A-HJKMNP-TV-Z]{26}$`), `provenanceSource = enum(computed, text, observed, review)`, `sourceKind = enum(pilotGuide, tripReport, forum, marina, authority, dataset, travelGuide, other)`, `sourceRef = { url: url, kind, observedAt: isoDate }`, `textDe = { de: string ≥ 1 }`, `versionFields = { profileVersion: int ≥ 1, validFrom: isoDate }`.
  - Typen (je `z.infer`): `Spot`, `SpotBody = Omit<Spot, "profileVersion" | "validFrom">`, `Highlight`, `HighlightBody`, `Region`, `RegionBody`, `WeatherPoint`, `ChangeEntry`, `Manifest`, `CoastCollection`, Datei-Hüllen `SpotsFile = { schemaVersion: "1.0"; area: string /* ar_ */; dataVersion: int ≥ 1; generatedAt: datetime; spots: Spot[] }`, analog `HighlightsFile` (`highlights`), `RegionsFile` (`regions`), `WeatherPointsFile` (`points`), `ChangesFile` (`previousDataVersion: int ≥ 1`, `changes`).
  - Spot (Pflicht fett in Teil B = nicht optional): `id sp_`, `kind enum(anchorage, port, marina, mooringField)`, `name`, `names?: {lang, name, script: latin|greek}[]`, `position`, `anchorPosition?: {lat, lon, confidence, source: provenanceSource}`, `shelter {sectors: {N, NE, E, SE, S, SW, W, NW: unit} (strict, genau 8), swell: unit, source: string /* "computed", "computed+text" … */}`, `depth?: {min: number|null, max: number|null, anchoring: {min, max: number|null}, confidence: unit, source: string}`, `seabed?: {type: enum(sand, mud, weed, rock, gravel, mixed), share: unit}[]`, `holding?: enum(good, fair, poor, unknown)`, `limits {maxDraft, maxLength, capacity: number|null}`, `mooring?: {types: enum(anchor, buoy, sternTo, alongside, lineAshore)[], buoys: int ≥ 0 | null, lineAshoreRequired: boolean|null}`, `services?: {water, electricity, fuel, showers, shop, taverna, wifi, dinghyLanding: enum(yes, no, seasonal, unknown)}`, `berth?: {status: enum(oftenFull, seasonFull, usuallySpace, unknown), months: int 1–12[], sourcesCount: int, bookable: boolean|null}`, `occupancy?: {month: 1–12, level: enum(empty, moderate, full, unknown)}[]`, `exclude {excluded: boolean, reason: enum(anchoringProhibited, military, cable, protectedArea, ferryLane, unsafe, aquaculture) | null, detail: string|null}`, `hazards?: {kind: enum(rock, shoal, cable, wreck, ferryTraffic, gusts, swellEntry, current, fishFarm, other), text: string}[]`, `seasonNote?: {months: int 1–12[] ≥ 1, text}[]`, `score {confidence: unit, popularity: unit, quietness: unit|null, sourcesCount: int ≥ 0, lastObserved: isoDate|null}`, `highlightIds?: hl_[]`, `externalRefs?: {googlePlaceIds: Record<category, string[]>, osmId: string|null, wikidataId: string|null}`, `summary?: textDe`, `sources?: sourceRef[]`, `provenance: Record<string, {source, confidence: unit, observedAt: isoDate|null}>`, `regionId?: rg_|null`, `mergedInto: sp_|null`, Versionsfelder.
  - Highlight: `id hl_`, `name`, `category enum(food, supply, beach, nature, active, culture, town, quiet)`, `importance int 1–5`, `position`, `spotIds: sp_[]`, `regionId?: rg_|null`, `season: {months: int[] ≥ 1} | null`, `summary?`, `sources?`, `externalRefs?: {googlePlaceId: string|null, osmId, wikidataId}`, `score {confidence, sourcesCount, lastObserved}`, Versionsfelder.
  - Region: `id rg_`, `name`, `names?: {lang, name}[]`, `type enum(island, coast, gulf, channel, archipelago)`, `center`, `radiusNm: number > 0`, `polygon?: GeoJSON Polygon | MultiPolygon`, `parentId: string|null` (`rg_` oder `ar_`), `spotIds: sp_[]`, `character?: textDe`, `facts?: {meltemiExposure: unit|null, ferryTraffic: enum(none, light, heavy)|null, charterBase: boolean|null, supplyPort: boolean|null}`, Versionsfelder.
  - WeatherPoint: `id wp_`, `name`, `position`, `kind enum(region, channel, cape)`, `regionId: rg_|null`.
  - ChangeEntry: `objectType enum(spot, highlight, region)`, `objectId`, `event enum(created, updated, excluded, merged, removed)`, `fields: string[]`, `severity enum(info, notable, safety)`, `summary: textDe`, `profileVersion int ≥ 1`.
  - Manifest: `schemaVersion "1.0"`, `area {id ar_, key, name, names: {lang, name}[], polygon}`, `dataVersion`, `previousDataVersion: int|null`, `generatedAt`, `bbox: [w, s, e, n]`, `tiles: {id, lastRunAt: datetime|null, profilesAsOf: isoDate|null}[]`, `objectCounts {spots, highlights, regions, weatherPoints, coastFeatures, changes}`, `licenses: {name, attribution, url, files: string[], fields: string[]}[]`, `files: {name: ContractFile, sha256: hex64, bytes: int}[]`.
  - CoastCollection: FeatureCollection; Feature-`properties` als diskriminierte Union über `kind`: `land` / `coastline` mit `source`, `extractedAt`; `restrictedArea` mit `reason enum(military, cable, protectedArea, aquaculture, ferryLane, firingArea)`, `source`.
  - `schema-check.ts`: `checkJsonSchema(file: ContractFile, data: unknown): Array<{ path: string; message: string }>` – `Ajv2020` aus `ajv/dist/2020` mit `ajv-formats`, `allErrors: true`, `strict: true`; kompilierte Validatoren je Datei zwischengespeichert; Pfad = `instancePath`.

- [ ] **Step 1: Failing tests**

```ts
// contract.test.ts
it("parses the Teil B example spot adapted to v1", () => {
  // Beispiel aus .idea/datendienst-spec.md Teil B; Anpassungen: externalRefs.googlePlaceIds {}, regionId mit 26 Zeichen
  expect(spotSchema.parse(TEIL_B_EXAMPLE).shelter.sectors.NW).toBe(0.95);
});
it.each([
  ["kind mooring", { kind: "mooring" }], ["seven sectors", { shelter: { ...ex.shelter, sectors: omit(ex.shelter.sectors, "NW") } }],
  ["six decimals", { position: { lat: 37.608121, lon: 23.33945 } }], ["legacy id", { id: "navily_123" }],
])("rejects %s", (_n, patch) => expect(spotSchema.safeParse({ ...ex, ...patch }).success).toBe(false));
it("checked-in JSON schemas equal the generated ones", () => {
  for (const f of CONTRACT_FILES) expect(readJson(`contract/schema/1.0/${jsonSchemaFileName(f)}`)).toEqual(contractJsonSchema("1.0", jsonSchemaFileName(f)));
});
it("an unknown version or file yields null", () => expect(contractJsonSchema("2.0", "spots.schema.json")).toBeNull());
// schema-check.test.ts
it("ajv accepts a valid spots file and reports the path of a bad sector", () => {
  expect(checkJsonSchema("spots.json", spotsFile([ex]))).toEqual([]);
  expect(checkJsonSchema("spots.json", spotsFile([{ ...ex, shelter: { ...ex.shelter, sectors: { ...ex.shelter.sectors, N: 1.2 } } }]))[0].path).toBe("/spots/0/shelter/sectors/N");
});
```

- [ ] **Step 2: Run** `npx vitest run contract lib/domain/delivery/__tests__/schema-check.test.ts` → FAIL („Cannot find module“).
- [ ] **Step 3: Implementieren.** `npm i ajv@^8 ajv-formats@^3`; Schemas `.strict()` (keine fremden Felder); `npm run contract:generate` schreibt die sieben Dateien (2 Leerzeichen, Zeilenende). Prüfen, dass `z.toJSONSchema` für jedes Schema ohne `unrepresentable`-Fehler läuft (Refines bleiben nur in zod; die 5-Stellen-Regel ergänzt das JSON-Schema über `multipleOf` nicht – sie prüft zod beim Bau).
- [ ] **Step 4: Run** `npx vitest run contract lib/domain/delivery && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(contract): Periplus Data Contract v1 schemas and generated JSON schemas`

### Task 2: Tabellen `deliveries`, `delivered_objects` und `config/delivery.json`

**Files:**
- Create: `lib/db/schema/deliveries.ts`, Migration (generiert) + `drizzle/00NN_delivery_triggers.sql`, `config/delivery.json`
- Modify: `lib/db/schema/index.ts`, `lib/config/schemas.ts`, `lib/config/index.ts`, `app/(admin)/settings/page.tsx` (aktive Lieferkonfiguration nur lesend)
- Test: `lib/db/__tests__/delivery-schema.test.ts`, `lib/config/__tests__/config.test.ts`

**Interfaces:**
- Consumes: `forbid_mutation()`, `geo_objects`, `runs`.
- Produces:
  - Enums `delivery_status` (`valid, rejected, unchanged`), `delivered_object_type` (`spot, highlight, region`); TS `DeliveryStatus`, `DeliveredObjectType`.
  - `deliveries` (nur anfügend, `forbid_mutation('')`): `id`, `area_id → geo_objects not null`, `data_version int` (null bei `rejected`/`unchanged`), `schema_version text not null`, `generated_at timestamptz not null`, `status not null`, `storage_prefix text` (null bei `unchanged`), `file_hashes jsonb not null default '{}'` (`{ "<file>": { sha256, bytes } }`), `object_counts jsonb not null`, `validation_report jsonb not null`, `previous_delivery_id → deliveries`, `change_seq bigint not null` (höchstes `change_events.seq` beim Bau), `run_id → runs`, `triggered_by text`, `created_at`; eindeutig `(area_id, data_version) where data_version is not null`; Check `(status = 'valid') = (data_version is not null)`; Index `(area_id, created_at desc)`.
  - `delivered_objects` (nur anfügend): `id`, `area_id`, `object_type`, `public_id text not null`, `geo_object_id → geo_objects`, `profile_version int not null`, `content_hash text not null` (`"removed"` für entfernte), `valid_from date not null`, `removed bool not null default false`, `first_delivery_id → deliveries not null`, `created_at`; eindeutig `(area_id, public_id, profile_version)`; Index `(public_id, valid_from desc)`.
  - `DeliveryConfig` (zod) und `AppConfig.delivery`, Werte:
    `schemaVersion "1.0"`; `spots { statuses ["confirmed", "no_anchoring"], maxSources 20 }`; `coast { marginNm 2, simplifyToleranceM 10, source "OpenStreetMap, ODbL" }`; `regions { types ["island", "archipelago", "coast_section", "gulf", "channel"], pointRadiusNm 2, simplifyToleranceM 50, character { meltemiHigh 0.6, meltemiLow 0.3 } }`; `weather { regionBufferNm 3, capeOffsetNm 1, capeLandRadiusM 2000 }`; `highlights { maxSpotIds 50 }`; `validation { maxWaterDistanceNm 1.5, spotDuplicateM 150, highlightDuplicateM 500, maxDraftM [0.5, 10], maxLengthM [5, 100], harbourMinShelter 0.8, lowConfidence 0.3, lowConfidenceNote "wenig belegt" }`; `severity { shelterDelta 0.2 }`; `forbiddenDomains ["navily.com", "google.com", "google.de", "goo.gl", "googleusercontent.com", "googleapis.com"]`; `licenses [{ name "ODbL-1.0", attribution "© OpenStreetMap contributors", url "https://opendatacommons.org/licenses/odbl/1-0/", files ["coast.geojson"], fields ["spots.json#/spots/*/name", "spots.json#/spots/*/names", "spots.json#/spots/*/externalRefs/osmId", "highlights.json#/highlights/*/name", "regions.json#/regions/*/name", "regions.json#/regions/*/names", "regions.json#/regions/*/polygon"] }]`; `api { cacheMaxAgeSeconds 60 }`.

- [ ] **Step 1: Failing tests**

```ts
it.each(["deliveries", "delivered_objects"])("%s rejects UPDATE and DELETE", …);          // /append-only/
it("a second valid delivery with the same data version for an area fails", …);
it("a rejected delivery must not carry a data version", …);                                 // Check-Verletzung
it("the delivery config carries the spec values", () => {
  expect(getConfig().delivery).toMatchObject({ schemaVersion: "1.0", coast: { marginNm: 2, simplifyToleranceM: 10 },
    validation: { maxWaterDistanceNm: 1.5, spotDuplicateM: 150, highlightDuplicateM: 500, maxDraftM: [0.5, 10], maxLengthM: [5, 100], lowConfidence: 0.3 } });
});
```

- [ ] **Step 2: Run** `npx vitest run lib/db/__tests__/delivery-schema.test.ts lib/config` → FAIL.
- [ ] **Step 3: Implementieren.** `npm run db:generate`; Trigger und Check in der handgeschriebenen Migration (Muster `0006_geo_triggers.sql`, Journal-Eintrag).
- [ ] **Step 4: Run** `npx vitest run lib/db lib/config` → PASS.
- [ ] **Step 5: Commit** `feat(db): deliveries and delivered objects, delivery config`

### Task 3: Test-Revier und Lader `loadAreaScope`

**Files:**
- Create: `lib/domain/delivery/types.ts`, `lib/domain/delivery/load.ts`, `test/fixtures/delivery/area.ts`
- Test: `lib/domain/delivery/__tests__/load.test.ts`

**Interfaces:**
- Consumes: `latestProfile` (M5, `ProfileSnapshot`), `profile_summaries` (M5, Status `ok`, höchste `prompt_version`), `popularityForArea(db, areaId): Promise<Map<string, number>>` (M5; Schlüssel = Geo-Objekt-ID – beim Bau gegen den M5-Code prüfen und nur hier anpassen), `displayNameSql`, `geo_names`, `tiles`, `tile_geo_objects`, `places`, `facts`/`mentions`/`document_versions`/`documents`, `DocType`.
- Produces (`types.ts`):
  - `type LonLat = { lon: number; lat: number }`; `type SourceRefRow = { url: string; docType: DocType; observedAt: string }`.
  - `type SpotSource = { placeId: string; geoObjectId: string; publicId: string; kind: PlaceKind; status: PlaceStatus; statusReason: string | null; position: LonLat; name: string; names: Array<{ lang: string; name: string; script: "latin" | "greek" }>; osmId: string | null; wikidataId: string | null; profile: ProfileSnapshot | null; summary: string | null; popularity: number | null; sources: SourceRefRow[] }`.
  - `type MergedSpot = { publicId: string; mergedIntoPublicId: string }`.
  - `type PoiSource = { geoObjectId: string; publicId: string; category: PoiCategory; name: string; position: LonLat; osmId: string | null; wikidataId: string | null; profile: ProfileSnapshot | null; summary: string | null; sources: SourceRefRow[] }`.
  - `type RegionSource = { geoObjectId: string; publicId: string; type: GeoObjectType; name: string; names: Array<{ lang: string; name: string }>; polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null; center: LonLat; radiusNm: number; areaKm2: number | null; parentGeoObjectIds: string[] /* Vorfahren, nächster zuerst */; profile: ProfileSnapshot | null }`.
  - `type PassageSource = { geoObjectId: string; type: "cape" | "strait" | "channel"; name: string; point: LonLat }`.
  - `type AreaScope = { area: { geoObjectId: string; publicId: string; key: string; name: string; names: Array<{ lang: string; name: string }>; polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon; bbox: [number, number, number, number] }; tiles: Array<{ id: string; lastRunAt: string | null; profilesAsOf: string | null }>; spots: SpotSource[]; merged: MergedSpot[]; pois: PoiSource[]; regions: RegionSource[]; passages: PassageSource[] }`.
- Produces (`load.ts`): `loadAreaScope(db, areaGeoObjectId: string, cfg: DeliveryConfig): Promise<AreaScope>` –
  - Kacheln = gültige `tiles` mit `area_id` = Revier; `bbox` = Ausdehnung dieser Kacheln (5 Stellen); `profilesAsOf` = größtes `valid_from` der jüngsten Profile der Orte der Kachel.
  - Spots = gültige Orte mit Status in `spots.statuses`, `public_id` gesetzt, `merged_into_id is null`, Kachel des Reviers (Partition über `places.tile_id`); `merged` = Orte mit `public_id` und `merged_into_id` (Ziel mit `public_id`) in Kacheln des Reviers.
  - POIs = gültige `poi` mit `public_id`, Kachel ihres Zentroids (`tile_id_for`) gehört zum Revier. Regionen = gültige Objekte der Typen `regions.types` mit `public_id` in `tile_geo_objects` der Revierkacheln; `polygon` (Polygon/MultiPolygon, vereinfacht mit `regions.simplifyToleranceM` in der UTM-Zone, sonst `null`), `center` = `centroid`, `radiusNm` = größter Abstand Zentroid → Polygon über `::geography` / 1852 auf 1 Stelle, ohne Polygon `pointRadiusNm`. Passagen = gültige `cape`/`strait`/`channel` in den Revierkacheln.
  - Namen: gültige `geo_names` ohne Herkunft `transliteration`/`fallback`, sortiert nach Sprache, Name; `name` = `displayNameSql`.
  - `sources` je Objekt = Dokumente der Facts aus `profile.provenance[*].factIds` (über Erwähnung → Version → Dokument), je URL das jüngste `observed_at`, `docType` der Version; ohne Zitate.
  - Ergebnislisten sortiert nach `publicId` bzw. `id`.
- `test/fixtures/delivery/area.ts`: `seedDeliveryArea(tx, opts?: { key?: string; shift?: number }): Promise<DeliveryFixture>` – Synthetik um 21,0° O / 35,2° N: Revier (`ar_` fest), 2 Kacheln, ein Landpolygon (Insel) mit Bucht, Region `island` (`rg_` fest) mit Profil (`meltemi_exposure 0.7`, `ferry_traffic "high"`, `charter_bases ["X"]`), Kap, Orte: Ankerplatz A (`sp_` fest, vollständiges Profil inkl. Quelle mit Dokument und Summary), Marina M (Schutz 0,9), Ankerplatz B ohne `shelter.W` (unvollständig), Ort C `no_anchoring` (`military`), Kandidat K (nicht geliefert); POI Taverne (`hl_` fest, `derived.importance 2`) 1 sm von A; Ausschlussfläche `military`. Rückgabe aller IDs. Alle Profile über einen Helfer `insertProfile(tx, geoObjectId, attributes, provenance, opts)` (M5-Spalten, `content_hash` beliebig).

- [ ] **Step 1: Failing tests** (`withRollback`)

```ts
it("loads the delivered places of the area's tiles and leaves out candidates and other areas", …); // A, M, B, C; nicht K
it("bbox is the extent of the area's tiles", …);
it("a merged place is listed in merged with its target's public id", …);
it("spot sources are the documents of the provenance facts, newest observation per url, no quote", …);
it("regions carry centre, radius in nm and the ancestor chain", …);
it("names exclude transliterations and fallbacks", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/delivery/__tests__/load.test.ts` → FAIL. **Step 3:** implementieren (je Objektart ein SQL, Profile über `latestProfile`). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(delivery): load area scope with latest profiles, names and sources`

### Task 4: `map-spot.ts` – Feldtabelle Profil → Spot

**Files:**
- Create: `lib/domain/delivery/vocab.ts`, `lib/domain/delivery/geo.ts`, `lib/domain/delivery/map-spot.ts`
- Test: `lib/domain/delivery/__tests__/map-spot.test.ts`, `lib/domain/delivery/__tests__/geo.test.ts`

**Interfaces:**
- Consumes: `SpotSource` (Task 3), `SpotBody` (Task 1), `SECTORS` (M2), Fact-Schema-v2-Werte (M4), Identitäts- und Ableitungsattribute (M5: `place.kind`, `exclude`, `derived.quietness` Zahl|null, `derived.season` `Array<{ kind; months }>`), `AttributeProvenance.origin`.
- Produces:
  - `geo.ts`: `round5(n: number): number`; `distanceNm(a: LonLat, b: LonLat): number` (Haversine, R = 3440,065 sm); `pointInPolygon(p: LonLat, g: GeoJSON.Polygon | GeoJSON.MultiPolygon): boolean` (Strahlwurf, Löcher beachtet); `distanceToLinesNm(p: LonLat, lines: Array<GeoJSON.LineString | GeoJSON.MultiLineString>): number` (Punkt–Segment in lokaler äquirektangulärer Projektion, Ergebnis sm).
  - `vocab.ts` (Tabellen, je als vollständiger `Record`): `SPOT_KIND` (`mooring_field` → `mooringField`, übrige gleich), `SOURCE_KIND` (`pilot_guide` → `pilotGuide`, `trip_report` → `tripReport`, `travel_guide` → `travelGuide`, übrige gleich), `EXCLUDE_REASON` (`military`, `firing_area` → `military`; `cable`; `protected_area` → `protectedArea`; `ferry_lane` → `ferryLane`; `aquaculture`; sonst → `anchoringProhibited`), `MOORING_TYPE` (`anchor`, `buoy`, `lines_ashore` → `lineAshore`, `stern_to` → `sternTo`, `alongside`, `pontoon` → `sternTo`), `HAZARD_KIND` (`rock`, `shoal`, `wreck`, `cable`, `current`, `swell` → `swellEntry`, `fish_farm` → `fishFarm`, `other`), `HOLDING` (`good`, `moderate` → `fair`, `poor`), `ORIGIN` (`computed`, `gazetteer`, `derived` → `computed`; `text`; `observed`; `review`); deutsche Textbausteine `EXCLUDE_REASON_DE` (z. B. `military` „Militärisches Sperrgebiet“, `anchoringProhibited` „Ankerverbot“), `HAZARD_DE` (`rock` „Fels“, `shoal` „Untiefe“, `wreck` „Wrack“, `cable` „Kabel“, `current` „Strömung“, `swellEntry` „Schwell läuft ein“, `fishFarm` „Fischfarm“, `ferryTraffic` „Fährkorridor in der Nähe“, `other` „Gefahr“), `SEASON_DE` (`open` „Geöffnet“, `closed` „Geschlossen“, `crowded` „Stark besucht“, `meltemi` „Meltemi“, `other` „Saisonhinweis“); `combineSource(origins: ProvenanceOrigin[]): string` (verschiedene Vertragsherkünfte in der Reihenfolge computed, text, observed, review mit `+`); `aggregateProvenance(entries: AttributeProvenance[]): { source; confidence; observedAt }` – `source` = review vor observed vor text vor computed, `confidence` = Minimum, `observedAt` = Maximum.
  - `map-spot.ts`: `SPOT_FIELDS` – die Feldtabelle als Konstante `Record<keyof SpotBody, { attributes: string[]; note: string }>` (Dokumentation und Testgrundlage); `mapSpot(src: SpotSource, ctx: { regionId: string | null; highlightIds: string[]; cfg: DeliveryConfig }): { spot: SpotBody } | { omitted: "no_profile" | "shelter_incomplete" }`.

  | Vertragsfeld | Quelle | Regel |
  | --- | --- | --- |
  | `id`, `name`, `names`, `position` | `publicId`, `name`, `names`, `position` | `round5` |
  | `kind` | `place.kind` / `src.kind` | `SPOT_KIND` |
  | `anchorPosition` | `anchor_position` + Provenienz | fehlt bei `port`/`marina`; `source` über `ORIGIN` |
  | `shelter` | `shelter.<8 Sektoren>`, `swell_protection` | ein Sektor fehlt → `omitted shelter_incomplete`; `swell` fehlt → Minimum der Sektoren; `source` = `combineSource` |
  | `depth` | `depth.min/max/anchoring_min/anchoring_max` | fehlt, wenn keiner da; `confidence` = Minimum |
  | `seabed`, `holding` | `seabed`, `holding` | `HOLDING`, fehlt → `unknown` |
  | `limits` | `max_draft`, `max_length`, `capacity` | fehlend → `null` |
  | `mooring` | `mooring.types`, `mooring.buoys`, `mooring.line_ashore_required` | `MOORING_TYPE` dedupliziert sortiert; `buoys` = `present false` → 0, `count`, sonst `null` |
  | `services` | `services.water/electricity/fuel/showers/wifi/dinghy_landing`, `highlight.supply` (shop), `highlight.food` (taverna) | `true` → `yes`, `false` → `no`, fehlt → `unknown`; `shop`/`taverna` `yes` → `seasonal`, wenn `derived.season` einen Eintrag `open` hat |
  | `berth` | `occupancy` | `port`/`marina`: volle Monate ≥ 1 → `seasonFull` mit Monaten; nur `empty`/`moderate` → `usuallySpace`; sonst `unknown`; `sourcesCount` = `sourceKeys` der Provenienz; `bookable null`; Ankerplätze: `unknown`, `[]`, 0, `null` |
  | `occupancy` | `occupancy` | Monate ohne `unknown`, aufsteigend |
  | `exclude` | `exclude` (M5), `prohibitions` | `excluded` = Status `no_anchoring` oder Verbot `anchoring` mit `months null`; `reason` über `EXCLUDE_REASON` (Statusgrund) bzw. `anchoringProhibited`; `detail` = `EXCLUDE_REASON_DE` |
  | `hazards` | `hazards`, `restriction` (`ferry_lane`) | `{ kind: HAZARD_KIND, text: HAZARD_DE[kind] + (name ? ": " + name : "") }`, Fährkorridor zusätzlich `ferryTraffic`; sortiert nach `kind`, Text |
  | `seasonNote` | `derived.season` | `{ months, text: SEASON_DE[kind] }` |
  | `score` | `profile.confidence ?? 0`, `popularity ?? 0`, `derived.quietness`, `profile.sourcesCount`, jüngstes `observedAt` aus Text/Beobachtung | Zahlen auf 3 Stellen |
  | `highlightIds`, `regionId` | Kontext | |
  | `externalRefs` | `osmId`, `wikidataId` | `googlePlaceIds {}` (keine `external_refs`-Tabelle bis M8) |
  | `summary` | `src.summary` | Konfidenz < `lowConfidence` und Text ohne `lowConfidenceNote` → „ (wenig belegt)“ anhängen; ohne Summary dann „Wenig belegt.“; sonst fehlt das Feld ohne Summary |
  | `sources` | `src.sources` | Domains aus `forbiddenDomains` entfallen; neueste zuerst, höchstens `maxSources`; `kind` über `SOURCE_KIND` |
  | `provenance` | `profile.provenance` | Schlüssel `shelter` (8 Sektoren + Schwell), `depth`, `seabed`, `limits`, `mooring`, `services.<feld>`, `occupancy`, `exclude`, `hazards`, `anchorPosition`, `seasonNote` – je `aggregateProvenance` |
  | `mergedInto` | – | `null` (zusammengelegte setzt Task 9) |

- [ ] **Step 1: Failing tests** – ein Test je Vertragsfeld (`it.each(Object.keys(SPOT_FIELDS))` prüft, dass jedes Feld einen benannten Testfall hat), dazu:

```ts
it("kind mooring_field maps to mooringField", …);
it("shelter: eight sectors and swell, source computed+text when one sector is text-corrected", () => {
  expect(mapped.shelter).toEqual({ sectors: { N: 0.9, NE: 0.8, E: 0.4, SE: 0.1, S: 0.2, SW: 0.7, W: 0.9, NW: 0.95 }, swell: 0.5, source: "computed+text" });
});
it("a missing sector omits the spot as shelter_incomplete", …);
it("a marina has no anchorPosition", …);
it("taverna yes with an 'open' season note becomes seasonal; missing services are unknown", …);
it("berth of a marina full in Jul and Aug is seasonFull [7, 8]", …);
it("no_anchoring with status reason firing_area is excluded as military with German detail", …);
it("a year-round anchoring prohibition excludes as anchoringProhibited", …);
it("hazard rock 'Petra' becomes { kind: 'rock', text: 'Fels: Petra' }", …);
it("confidence 0.25 appends 'wenig belegt' to the summary", …);
it("a navily.com source is dropped and kinds are camelCase", …);
it("provenance.shelter takes text when any sector is text, the minimum confidence and the latest date", …);
it("never copies a quote: no field of the mapped spot contains a fact quote", …);       // Quote aus der Provenienz-Fixture
// geo.test.ts
it("distanceNm of one minute of latitude is 1 nm ± 0.01", …);
it("pointInPolygon respects holes and multipolygons", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/delivery/__tests__/map-spot.test.ts lib/domain/delivery/__tests__/geo.test.ts` → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(delivery): spot mapping table from profile to contract`

### Task 5: Highlights und Regionen

**Files:**
- Create: `lib/domain/delivery/map-highlight.ts`, `lib/domain/delivery/map-region.ts`
- Test: `lib/domain/delivery/__tests__/map-highlight.test.ts`, `lib/domain/delivery/__tests__/map-region.test.ts`

**Interfaces:**
- Consumes: `PoiSource`, `RegionSource` (Task 3), `geo.ts`, `vocab.ts` (Task 4), `getConsolidationConfig().importance.radiusNm` (M5, `[5, 10, 20, 35, 50]`), Profilattribute `derived.importance` (1–5), `derived.season`, `meltemi_exposure`, `ferry_traffic`, `charter_bases`, `supply_ports`.
- Produces:
  - `mapHighlights(pois: PoiSource[], spots: Array<{ id: string; position: LonLat; mergedInto: string | null }>, ctx: { radiusNm: number[]; cfg: DeliveryConfig; regionIdFor: (p: LonLat) => string | null }): { highlights: HighlightBody[]; dropped: Array<{ id: string; reason: "no_profile" | "no_importance" | "no_spot_in_radius" | "duplicate"; into?: string }> }` –
    `importance` aus `derived.importance`; Radius = `radiusNm[importance − 1]`; `spotIds` = Spots ohne `mergedInto` mit `distanceNm ≤ Radius`, nach Distanz, dann ID, höchstens `highlights.maxSpotIds`; leer → `dropped no_spot_in_radius`. Danach Dubletten: gleicher normalisierter Name (`normalizeName`) und Abstand < `highlightDuplicateM` → der mit höherer Bedeutung (dann kleinerer ID) bleibt, `spotIds` vereinigt und neu sortiert, der andere `dropped duplicate` mit `into`. `season` = Monate der `open`-Einträge von `derived.season` (vereinigt), sonst `null`; `score { confidence: profile.confidence ?? 0, sourcesCount, lastObserved }`; `externalRefs { googlePlaceId: null, osmId, wikidataId }`; `summary`/`sources` wie Spot.
  - `highlightIdsBySpot(highlights: HighlightBody[], spots: Array<{ id: string; position: LonLat }>): Map<string, string[]>` – Umkehrung von `spotIds`, nach Distanz sortiert.
  - `REGION_TYPE` (`coast_section` → `coast`, übrige gleich); `regionCharacter(facts: Region["facts"], cfg): string | null` – Bausteine in fester Reihenfolge: `meltemiExposure ≥ meltemiHigh` „Meltemi-exponiert“, `≤ meltemiLow` „vor dem Meltemi geschützt“; `ferryTraffic heavy` „starker Fährverkehr“, `none` „kein Fährverkehr“; `charterBase` „Charterbasis“; `supplyPort` „Versorgungshafen“; erster Baustein großgeschrieben, mit „, “ verbunden, Punkt am Ende; keiner → `null`.
  - `assignRegions(spots: Array<{ id: string; position: LonLat }>, regions: RegionSource[]): { regionIdBySpot: Map<string, string | null>; spotIdsByRegion: Map<string, string[]> }` – `regionId` = kleinste (`areaKm2`, ohne Polygon: Kreis aus `radiusNm`) Region, die den Punkt enthält; `spotIds` einer Region = alle enthaltenen Spots, sortiert.
  - `mapRegion(src: RegionSource, ctx: { areaPublicId: string; regionPublicIds: Map<string, string> /* geoObjectId → rg_ */; spotIds: string[]; cfg }): RegionBody` – `parentId` = erster Vorfahr mit `rg_` im Paket, sonst `areaPublicId`; `facts { meltemiExposure, ferryTraffic: none → none, low/moderate → light, high → heavy, charterBase: Liste nicht leer, supplyPort: Liste nicht leer }` (fehlend → `null`, alle `null` → Feld fehlt); `character` aus `regionCharacter`.

- [ ] **Step 1: Failing tests**

```ts
it("importance 2 gives radius 10 nm and spots sorted by distance", …);          // Spot in 3 sm und 9 sm, nicht 11 sm
it("a highlight losing its only spot is dropped and the spot loses the highlight id", …);
it("two 'Taverna Nikos' 300 m apart merge into the more important one", …);   // dropped duplicate into
it("highlight season months come from open season notes", …);
it("a spot inside an island inside an archipelago belongs to the island; the archipelago lists both", …);
it("region parent is the nearest delivered ancestor, else the area id", …);
it("character: 'Meltemi-exponiert, starker Fährverkehr, Charterbasis.'", () =>
  expect(regionCharacter({ meltemiExposure: 0.7, ferryTraffic: "heavy", charterBase: true, supplyPort: false }, cfg)).toBe("Meltemi-exponiert, starker Fährverkehr, Charterbasis."));
it("coast_section maps to type coast", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/delivery/__tests__/map-highlight.test.ts lib/domain/delivery/__tests__/map-region.test.ts` → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(delivery): highlight and region mapping with radius, duplicates and region assignment`

### Task 6: `coast.geojson` und `weather-points.json`

**Files:**
- Create: `lib/domain/delivery/coast.ts`, `lib/domain/delivery/weather-points.ts`
- Test: `lib/domain/delivery/__tests__/coast.test.ts`, `lib/domain/delivery/__tests__/weather-points.test.ts`

**Interfaces:**
- Consumes: `land_polygons` (`dataset_version`), `restricted_areas` (`validAt`), `utmSridFor` (M2), `RegionSource`, `PassageSource` (Task 3), `vocab.ts`, `CoastCollection`, `WeatherPoint` (Task 1).
- Produces:
  - `buildCoast(db, input: { bbox: [number, number, number, number]; cfg: DeliveryConfig["coast"]; asOf: string }): Promise<CoastCollection>` – Box = `bbox` um `marginNm` (1852 m je sm) erweitert; Land = `ST_Union` der `land_polygons` in der Box, geschnitten mit der Box, in der UTM-Zone der Boxmitte mit `ST_SimplifyPreserveTopology(…, simplifyToleranceM)` vereinfacht, zurück nach 4326, in Polygone zerlegt (`ST_Dump`) → `kind land`; Küstenlinie = Rand dieser Vereinigung ohne die Schnittkanten der Box (Schnitt mit dem um 1 m nach innen gepufferten Boxinneren) → `kind coastline`; je gültige Ausschlussfläche in der Box → `kind restrictedArea`, `reason` (`protected_area` → `protectedArea`, `ferry_lane` → `ferryLane`, `firing_area` → `firingArea`, übrige gleich), `source` = `source_ref` ?? `"EMODnet Human Activities"`. Land/Küste: `source` = `cfg.source`, `extractedAt` = `max(land_polygons.created_at)::date` der verwendeten Zeilen. Koordinaten auf 5 Stellen, Features sortiert nach `kind`, dann `ST_XMin`, `ST_YMin`.
  - `weatherPointId(geoObjectId: string, kind: WeatherPoint["kind"]): string` – `wp_` + die ersten 26 Zeichen der Crockford-Base32-Darstellung von sha256(`geoObjectId:kind`).
  - `buildWeatherPoints(db, input: { regions: RegionSource[]; passages: PassageSource[]; regionIdFor: (p: LonLat) => string | null; cfg: DeliveryConfig["weather"] }): Promise<WeatherPoint[]>` – Region mit Polygon (Typen `island`, `archipelago`, `coast_section`, `gulf`): Wasser = (Polygon um `regionBufferNm` gepuffert) minus Land; Punkt = Mittelpunkt von `ST_MaximumInscribedCircle` in der UTM-Zone, `kind region`; `strait`/`channel`: `ST_ClosestPoint(geom, ST_Centroid(geom))`, `kind channel`; `cape`: Peilung vom Schwerpunkt des Lands im Umkreis `capeLandRadiusM` zum Kap, Punkt `capeOffsetNm` weiter entlang dieser Peilung (`ST_Project` auf `geography`), `kind cape`; Name = Name des Objekts; Ergebnis nach `id` sortiert, Punkte ohne Wasser (leere Differenz) entfallen.

- [ ] **Step 1: Failing tests** (`withRollback`, Synthetik-Insel aus `seedDeliveryArea`)

```ts
it("coast covers the box plus 2 nm and contains land, coastline and the military area", …);
it("the coastline has no segment on the box edge", …);                // kein Küstenpunkt näher als 2 m am Boxrand
it("simplification keeps every vertex within 10 m of the original land", …);   // ST_HausdorffDistance in UTM ≤ 10
it("all coordinates have at most five decimals and the collection passes the contract schema", …);
it("the island's weather point lies on water at the largest distance to land within the buffer", …);
it("a cape point lies 1 nm seaward of the cape", () => expect(distanceNm(cape, wp.position)).toBeCloseTo(1, 1));
it("weather point ids are stable across builds", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/delivery/__tests__/coast.test.ts lib/domain/delivery/__tests__/weather-points.test.ts` → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(delivery): coast geojson and weather points from PostGIS`

### Task 7: Vertragsversionen und `changes.json`

**Files:**
- Create: `lib/domain/delivery/versioning.ts`, `lib/domain/delivery/changes.ts`
- Test: `lib/domain/delivery/__tests__/versioning.test.ts`, `lib/domain/delivery/__tests__/changes.test.ts`

**Interfaces:**
- Consumes: `canonicalJson` (M2), `delivered_objects` (Task 2), `change_events` (M5, `seq`, `severity`, `geo_object_id`), Typen aus Task 1.
- Produces:
  - `type ObjectDraft = { type: DeliveredObjectType; id: string; geoObjectId: string | null; body: SpotBody | HighlightBody | RegionBody }`; `type LatestDelivered = { profileVersion: number; contentHash: string; validFrom: string; removed: boolean }`.
  - `contentHash(body: object): string` – sha256 hex von `canonicalJson(body)` (Versionsfelder sind im Body nie enthalten).
  - `latestDelivered(db, areaId: string): Promise<Map<string, LatestDelivered & { type: DeliveredObjectType; geoObjectId: string | null }>>` – je `public_id` die Zeile mit höchster `profile_version`.
  - `assignVersions(drafts: ObjectDraft[], latest: Map<string, LatestDelivered>, today: string): { objects: Array<ObjectDraft & { profileVersion: number; validFrom: string; contentHash: string; status: "created" | "updated" | "same" }>; removed: Array<{ type; id; geoObjectId; profileVersion: number }> }` – kein Eintrag oder `removed` → Version = vorige + 1 (bzw. 1), `created`; gleicher Hash → alte Version und `validFrom`, `same`; sonst + 1, `today`, `updated`. `removed` = Einträge in `latest` ohne `removed`, die nicht in `drafts` stehen, mit Version + 1.
  - `changedFields(before: object, after: object): string[]` – Blattpfade bis Tiefe 3 mit Punkt (`shelter.sectors.N`, `services.taverna`, `limits.maxDraft`), Arrays als Blatt, ohne `profileVersion`/`validFrom`, sortiert.
  - `contractSeverity(fields: string[], before: object | null, after: object | null, cfg: DeliveryConfig["severity"]): ChangeSeverity` – `safety`: ein Feld beginnt mit `exclude`, `limits`, `hazards` oder ein Sektor `shelter.sectors.<S>` ändert sich um > `shelterDelta`; `notable`: `services`, `highlightIds`, `occupancy`, `berth`, `seasonNote`; sonst `info`.
  - `eventSeverities(db, geoObjectIds: string[], afterSeq: number, upToSeq: number): Promise<Map<string, ChangeSeverity>>` – höchste Severity der `change_events` je Objekt mit `afterSeq < seq ≤ upToSeq`.
  - `buildChanges(input: { objects: ReturnType<typeof assignVersions>["objects"]; removed: ReturnType<typeof assignVersions>["removed"]; previousBodies: Map<string, object>; eventSeverity: Map<string, ChangeSeverity> }): ChangeEntry[]` – nur `created`/`updated`/`removed`; Ereignis: `created`; `removed`; `merged`, wenn `mergedInto` neu gesetzt; `excluded`, wenn `exclude.excluded` false → true; sonst `updated` mit `fields`. Severity = Maximum aus `contractSeverity` und `eventSeverity[geoObjectId]` (`removed`, `merged`, `excluded` mindestens `notable`). `summary.de` aus festen Bausteinen: „Neu im Paket.“, „Nicht mehr im Paket.“, „Zusammengelegt mit <mergedInto>.“, „Ausgeschlossen: <EXCLUDE_REASON_DE>.“, „Geändert: <Feldlabels>.“ (`FIELD_LABELS_DE` für die Vertragsfelder erster Ebene, z. B. `shelter` „Schutz“, `services` „Versorgung“). Sortiert nach `objectType`, `objectId`.
  - `mergeChanges(lists: ChangeEntry[][] /* aufsteigende dataVersion */): ChangeEntry[]` – je Objekt: erstes `created` und letztes nicht `removed` → `created`; `created` … `removed` → entfällt; sonst letztes Ereignis; `fields` vereinigt (nur bei `updated`); Severity Maximum; `profileVersion` und `summary` des letzten.

- [ ] **Step 1: Failing tests**

```ts
it("generatedAt and validFrom do not enter the content hash", …);          // gleiche Bodies → gleicher Hash, Version bleibt
it("a changed sector bumps the version and sets validFrom to today", …);
it("a removed object gets event removed and the next version", …);
it("a reappearing object continues the version", …);                       // 1 → 2 removed → 3 created
it.each([
  [["shelter.sectors.N"], 0.6, 0.35, "safety"], [["shelter.sectors.N"], 0.6, 0.45, "info"],
  [["limits.maxDraft"], null, null, "safety"], [["services.water"], null, null, "notable"], [["holding"], null, null, "info"],
])("contract severity of %j", …);
it("an event severity safety from change_events wins over info", …);
it("exclude false → true is event excluded with summary 'Ausgeschlossen: Militärisches Sperrgebiet.'", …);
it("mergeChanges: created then updated is created, created then removed disappears, fields are united", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/delivery/__tests__/versioning.test.ts lib/domain/delivery/__tests__/changes.test.ts` → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(delivery): contract versions by content hash and change feed entries`

### Task 8: Validierung – eine benannte Prüfung je Regel

**Files:**
- Create: `lib/domain/delivery/validate.ts`, `test/fixtures/delivery/package.ts`
- Modify: `lib/domain/delivery/types.ts`
- Test: `lib/domain/delivery/__tests__/validate.test.ts`

**Interfaces:**
- Consumes: `checkJsonSchema` (Task 1), `geo.ts` (Task 4), `isPublicId`, `normalizeName`, `findArchiveCopies(db, text): Promise<{ shingles: number; hits: number }>` (M5), `getConsolidationConfig().importance.radiusNm`.
- Produces:
  - `type DeliveryPackage = { manifest: Manifest; files: { "spots.json": SpotsFile; "highlights.json": HighlightsFile; "regions.json": RegionsFile; "coast.geojson": CoastCollection; "weather-points.json": WeatherPointsFile; "changes.json"?: ChangesFile } }`.
  - `CHECK_NAMES = ["json_schema", "ids", "references", "spot_location", "shelter", "limits", "exclude_reason", "berth_months", "low_confidence_note", "highlight_radius", "spot_duplicates", "highlight_duplicates", "verbatim_text", "foreign_content", "data_version", "changes_complete"] as const`, `type CheckName`.
  - `type Finding = { file: ContractFile; objectId: string | null; path: string | null; message: string }`; `type ValidationReport = { ok: boolean; checks: Array<{ name: CheckName; ok: boolean; findings: Finding[] }>; warnings: Finding[] }` (jede Prüfung immer aufgeführt, Reihenfolge `CHECK_NAMES`).
  - `validatePackage(pkg: DeliveryPackage, deps: { previous: { dataVersion: number; versions: Map<string, number> } | null; findCopies: (text: string) => Promise<number>; cfg: DeliveryConfig; radiusNm: number[]; warnings?: Finding[] }): Promise<ValidationReport>` – Regeln:
    - `json_schema`: `checkJsonSchema` je vorhandene Datei inkl. Manifest.
    - `ids`: eindeutig über alle Dateien, Präfix je Datei (`sp_`, `hl_`, `rg_`, `wp_`, Manifest `ar_`).
    - `references`: `spotIds`, `highlightIds`, `regionId`, `mergedInto`, `parentId` (`rg_` oder Manifest-`area.id`), Wetterpunkt-`regionId`, `changes.objectId` (außer `removed`) existieren im Paket.
    - `spot_location`: Position in `manifest.bbox`; liegt sie in einem `land`-Polygon, dann Abstand zur Küstenlinie ≤ `maxWaterDistanceNm`.
    - `shelter`: genau 8 Sektoren 0–1, `swell` 0–1; `port`/`marina` mit einem Sektor < `harbourMinShelter` verlangen `provenance.shelter.source ∈ {text, observed}`.
    - `limits`: `maxDraft` `null` oder in `maxDraftM`, `maxLength` `null` oder in `maxLengthM`.
    - `exclude_reason`, `berth_months`, `low_confidence_note` (`score.confidence < lowConfidence` → `summary.de` enthält `lowConfidenceNote`, ohne Groß-/Kleinschreibung).
    - `highlight_radius`: Kategorie in der Liste, ≥ 1 `spotId` mit `distanceNm ≤ radiusNm[importance − 1]`.
    - `spot_duplicates`: zwei Spots gleicher `kind`, beide ohne `mergedInto`, < `spotDuplicateM`; `highlight_duplicates`: gleicher normalisierter Name < `highlightDuplicateM`.
    - `verbatim_text`: `summary.de` (Spot, Highlight), `character.de`, `seasonNote[].text`, `hazards[].text`, `exclude.detail`, `changes[].summary.de` – `findCopies(text) > 0` → Fund mit Objekt-ID und Pfad.
    - `foreign_content`: `externalRefs.osmId` `^(node|way|relation)/\d+$`, `wikidataId` `^Q\d+$`, Google-IDs `^[A-Za-z0-9_-]{10,}$`; keine `sources[].url` mit Domain (oder Subdomain) aus `forbiddenDomains`; kein Textfeld enthält eine URL.
    - `data_version`: `dataVersion > previous.dataVersion` (ohne Vorgänger ≥ 1); alle Dateien tragen dieselbe `dataVersion`, `area` und `schemaVersion`.
    - `changes_complete`: mit Vorgänger muss `changes.json` existieren; Menge der Objekte mit `profileVersion > previous.versions.get(id)` (oder neu) ∪ fehlende frühere IDs = Menge der `changes.objectId`; `changes.profileVersion` = Version im Paket.
  - `test/fixtures/delivery/package.ts`: `validPackage(): DeliveryPackage` (ein Spot, eine Marina, ein Highlight, eine Region, Küste mit einem Landpolygon, ein Wetterpunkt; besteht alle Prüfungen) und `breakPackage(pkg, patch: (draft) => void): DeliveryPackage` (structuredClone + Mutation).

- [ ] **Step 1: Failing tests** – genau ein Test je `CheckName` mit minimal kaputtem Paket, jeweils `expect(failed(report)).toEqual([<name>])` (nur diese Prüfung schlägt fehl), dazu:

```ts
it("the valid fixture passes every check", async () => expect((await validate(validPackage())).ok).toBe(true));
it.each([
  ["ids", (p) => { p.files["spots.json"].spots[1].id = p.files["spots.json"].spots[0].id; }],
  ["references", (p) => { p.files["spots.json"].spots[0].highlightIds = ["hl_01J9X4KQ3P2N1M0L9K8J7H6G5Z"]; }],
  ["spot_location", (p) => { p.files["spots.json"].spots[0].position = INLAND_2NM; }],
  ["shelter", (p) => { p.files["spots.json"].spots[1].shelter.sectors.S = 0.5; /* marina, provenance computed */ }],
  ["limits", (p) => { p.files["spots.json"].spots[0].limits.maxDraft = 12; }],
  ["exclude_reason", (p) => { p.files["spots.json"].spots[0].exclude = { excluded: true, reason: null, detail: null }; }],
  ["berth_months", (p) => { p.files["spots.json"].spots[1].berth = { status: "seasonFull", months: [], sourcesCount: 1, bookable: null }; }],
  ["low_confidence_note", (p) => { p.files["spots.json"].spots[0].score.confidence = 0.2; }],
  ["highlight_radius", (p) => { p.files["highlights.json"].highlights[0].importance = 1; /* Spot 7 sm entfernt */ }],
  ["spot_duplicates", (p) => { p.files["spots.json"].spots.push({ ...spotA, id: OTHER_SP, position: offset(spotA.position, 100) }); }],
  ["highlight_duplicates", …], ["data_version", …], ["changes_complete", …], ["json_schema", …],
])("%s fails on a minimally broken package", …);
it("a summary copying 16 words of a chunk with different accents is a violation", async () => {
  // withRollback: Chunk mit text_shingles, Summary = dieselben 16 Wörter in Großschreibung ohne Akzente; deps.findCopies über findArchiveCopies(tx, …)
});
it("a navily source url is foreign content", …);
it("a 15-word own sentence is no violation", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/delivery/__tests__/validate.test.ts` → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(delivery): package validation with one named check per rule`

### Task 9: `buildDelivery` – Paket bauen, archivieren, Zeile schreiben

**Files:**
- Create: `lib/domain/delivery/build.ts`, `test/fixtures/delivery/expected/{manifest.json,spots.json,highlights.json,regions.json,coast.geojson,weather-points.json}`
- Test: `lib/domain/delivery/__tests__/build.test.ts`

**Interfaces:**
- Consumes: Tasks 2–8, `Archive` (`put`, `get`), `testArchive()`, `withRollback`.
- Produces:
  - `serializeFile(data: unknown): Uint8Array` – `JSON.stringify(data, null, 2) + "\n"`, UTF-8; Objekte in Schema-Reihenfolge (die Abbilder bauen sie so), Listen bereits sortiert.
  - `previousPackage(db, archive, areaId: string): Promise<{ delivery: DeliveryRow; spots: Map<string, Spot>; highlights: Map<string, Highlight>; regions: Map<string, Region>; fileHashes: Record<string, string> } | null>` – jüngste `valid`-Zeile des Reviers, Dateien aus `storage_prefix`.
  - `type DeliveryRow = InferSelectModel<typeof deliveries>`.
  - `buildDelivery(db, archive, areaGeoObjectId: string, opts?: { runId?: string; now?: Date; triggeredBy?: string; cfg?: DeliveryConfig; scopeTransform?: (s: AreaScope) => AreaScope /* Test-Seam */; beforeCommit?: () => Promise<void> /* Test-Seam, nach S3-Upload */ }): Promise<{ deliveryId: string; status: DeliveryStatus; dataVersion: number | null; report: ValidationReport }>` – eine Transaktion mit `pg_advisory_xact_lock(hashtext('delivery:' || areaId))`:
    1. `previousPackage`; `loadAreaScope`; `today` = UTC-Datum von `now`; `upToSeq` = `max(change_events.seq)`.
    2. Regionen zuordnen, Highlights abbilden, Spots abbilden (`omitted` → Warnung „Spot nicht geliefert: Schutz unvollständig“ mit `objectId`); zusammengelegte Orte, die im Vorgängerpaket standen: dessen Inhalt mit `mergedInto` (ohne Versionsfelder); Highlight-`dropped` → Warnungen.
    3. `assignVersions` gegen `latestDelivered`; Küste und Wetterpunkte bauen.
    4. Keine Änderung (alle `same`, `removed` leer, Hashes von `coast.geojson` und `weather-points.json` gleich dem Vorgänger) → Zeile `unchanged` (ohne `data_version`, ohne S3), Bericht der Validierung mit Vorgänger-`dataVersion` + 1 als Probe.
    5. Sonst `dataVersion` = vorige + 1 (bzw. 1); `changes.json` nur mit Vorgänger (`buildChanges`, `eventSeverities(…, previous.change_seq, upToSeq)`); Manifest (Lizenzen aus Konfiguration, `files` mit sha256 und Bytes aller übrigen Dateien, `objectCounts`, `tiles`).
    6. `validatePackage`; gültig → S3 `deliveries/<ar_id>/<dataVersion>/<file>` (Content-Type `application/json` bzw. `application/geo+json`), Zeile `valid`, `delivered_objects` für `created`/`updated` und `removed` (`content_hash "removed"`, `removed true`); ungültig → S3 `deliveries/<ar_id>/rejected/<deliveryId>/<file>`, Zeile `rejected` ohne `data_version`, keine `delivered_objects`.
    Die `deliveries`-Zeile wird als Letztes geschrieben; die Delivery-ID wird vorab erzeugt (`newId()`), damit der Ablage-Pfad abgelehnter Pakete feststeht.

- [ ] **Step 1: Failing tests** (`withRollback` und `testArchive()`, `now` fest `2026-10-19T08:00:00Z`)

```ts
it("the fixture area builds a valid package equal to the checked-in files", async () => {
  // für jede Datei: expect(text).toMatchFileSnapshot("../../../../test/fixtures/delivery/expected/<file>")
});
it("the first package has data version 1, no changes.json and versions 1", …);
it("a second build without changes is unchanged and writes nothing", …);    // Status unchanged, keine neuen S3-Schlüssel, keine delivered_objects
it("shuffled load order gives identical files", …);                        // loadAreaScope-Ergebnis gemischt (Test-Seam opts.scopeTransform) → gleiche Hashes
it("a changed shelter value gives data version 2 with one updated change and severity safety", …);
it("a merged place keeps its last content with mergedInto and event merged", …);
it("an incomplete-shelter place is not delivered and appears as warning", …);
it("a summary with a copied 16-word passage rejects the package; files lie under rejected/, data version stays", …);
it("two parallel builds create one data version", async () => {
  // committed Synthetik-Revier (21,0° O / 35,2° N, eigener Schlüssel); Promise.all([build, build]) → Status-Menge {valid, unchanged}, delivered_objects je Objekt einmal
});
it("a failed commit leaves no delivery row and a retry reuses the keys", …);  // Fehler nach S3-Upload injiziert (opts-Seam) → keine Zeile; zweiter Lauf → dataVersion 1, gleiche Schlüssel
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/delivery/__tests__/build.test.ts` → FAIL. **Step 3:** implementieren; erwartete Dateien beim ersten grünen Lauf mit `npx vitest run -u lib/domain/delivery/__tests__/build.test.ts` erzeugen, von Hand gegen Teil B lesen (Felder, Rundung, Reihenfolge, keine Zitate) und einchecken. **Step 4: Run** `npx vitest run lib/domain/delivery` → PASS.
- [ ] **Step 5: Commit** `feat(delivery): build, validate and archive area packages`

### Task 10: Stufe `delivery.build` und Lauf „Paket bauen“

**Files:**
- Create: `lib/pipeline/delivery.ts`, `lib/jobs/handlers/delivery.ts`
- Modify: `lib/jobs/queues.ts`, `lib/jobs/stages.ts`, `lib/jobs/registry.ts`, `config/queues.json`
- Test: `lib/pipeline/__tests__/delivery-run.test.ts`

**Interfaces:**
- Consumes: `startRun`, `StageDefinition`, `JobHandler`, `getArchive()`, `buildDelivery` (Task 9).
- Produces:
  - Queue `delivery.build` in `QUEUES`, `config/queues.json` `{ "concurrency": 1, "retryLimit": 2, "retryDelaySeconds": 60, "retryBackoff": true }`.
  - `DELIVERY_STAGE = "delivery.build"`; `deliveryBuildStage: StageDefinition` – plant genau einen Job `{ key: areaId, areaId }` aus `run.params.areaId`.
  - `deliveryBuildHandler: JobHandler<JobData>` – `buildDelivery(ctx.db, getArchive(), areaId, { runId, triggeredBy })`, Log mit Status, `dataVersion`, Zahl der Fehlprüfungen; ein abgelehntes Paket ist ein erfolgreicher Job (kein Retry).
  - `startDeliveryRun(db, boss, input: { areaGeoObjectId: string; triggeredBy: string }): Promise<{ id: string }>` – Art `stage`, Umfang `{ type: "area", id: areaGeoObjectId }`, Stufen `["delivery.build"]`, `params { areaId }`; unbekanntes oder ungültiges Revier → Error.

- [ ] **Step 1: Failing tests**

```ts
it("the stage plans exactly one job for the area", …);
it("the handler builds the package and records status valid", …);           // withRollback, testArchive
it("a rejected package ends the job without error", …);
it("startDeliveryRun rejects a geo object that is not an area", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/pipeline/__tests__/delivery-run.test.ts` → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run lib/pipeline lib/jobs` → PASS.
- [ ] **Step 5: Commit** `feat(delivery): delivery.build stage and run`

### Task 11: API-Grundlage, Reviere, Paket, Dateien, Schema

**Files:**
- Create: `lib/api/respond.ts`, `lib/domain/delivery/read.ts`, `app/api/v1/areas/route.ts`, `app/api/v1/areas/[area]/package/route.ts`, `app/api/v1/areas/[area]/package/[file]/route.ts`, `app/api/v1/schema/[version]/[file]/route.ts`
- Modify: `lib/api/handler.ts`, `lib/security/route-policy.ts`
- Test: `lib/api/__tests__/handler.test.ts`, `lib/api/__tests__/respond.test.ts`, `app/__tests__/api-package.test.ts`, `lib/security/__tests__/route-policy.test.ts`

**Interfaces:**
- Consumes: `withApiClient`, `authenticateApiClient`, `createApiClient`, `revokeApiClient`, `contractJsonSchema` (Task 1), `deliveries` (Task 2), `buildDelivery` (Task 9, für Testdaten).
- Produces:
  - `respond.ts`: `apiError(status: 400 | 401 | 403 | 404 | 429 | 500, code: string, message: string, headers?: Record<string, string>): Response` (`Cache-Control: no-store`); `apiBody(req: Request, body: Uint8Array | object, meta: { schemaVersion: string; dataVersion: number | null; contentType?: string; maxAgeSeconds: number }): Response` – Bytes (Objekte über `serializeFile`), `ETag` = `"` + erste 32 Hex von sha256 + `"`, `Cache-Control: private, max-age=<n>`, `Periplus-Schema-Version`, `Periplus-Data-Version` (wenn gesetzt); `If-None-Match` (Liste, `W/`-Präfix erlaubt) trifft → 304 ohne Body mit `ETag`.
  - `withApiClient` verwendet `apiError` (Nachrichten: 401 „Missing or invalid API key.“, 403 „The API key lacks the required scope.“, 429 „Rate limit exceeded.“, 500 „Internal error.“) und reicht den Route-Kontext durch: `withApiClient<C = undefined>(scope, handler: (req: Request, client: ApiClient, ctx: C) => Promise<Response>): (req: Request, ctx: C) => Promise<Response>`.
  - `read.ts`: `resolveArea(db, ref: string): Promise<{ geoObjectId: string; publicId: string; key: string; name: string } | null>` (gültiges `area` per `public_id` oder `config_key`); `listAreas(db): Promise<Array<{ id: string; key: string; name: string; dataVersion: number | null; bbox: number[] | null; generatedAt: string | null }>>` (alle gültigen Reviere mit `public_id`, Daten aus der jüngsten `valid`-Lieferung); `validDelivery(db, areaGeoObjectId: string, dataVersion?: number): Promise<DeliveryRow | null>` (nur `valid`; ohne Version die höchste); `readDeliveryFile(archive, row: DeliveryRow, file: ContractFile): Promise<Uint8Array | null>`; `deliveryArchive(): Archive` (Standard `getArchive()`) mit Test-Seam `setDeliveryArchive(a: Archive | null): void` – die Routen lesen S3 nur hierüber.
  - Routen (alle `await connection()`, Scope `delivery:read`, `maxAgeSeconds` aus Konfiguration):
    - `GET /api/v1/areas` → `{ schemaVersion, areas }`.
    - `GET /api/v1/areas/[area]/package` → Manifest-Objekt + `links: Record<ContractFile, string>` (`/api/v1/areas/<ar_id>/package/<file>?dataVersion=<n>`, nur vorhandene Dateien); unbekanntes Revier oder ohne gültige Lieferung → 404 `not_found`.
    - `GET /api/v1/areas/[area]/package/[file]?dataVersion=` → Dateibytes unverändert (Hash = Manifest); `file` nicht in `CONTRACT_FILES` → 404; `dataVersion` nicht `^[1-9]\d*$` → 400 `invalid_data_version`; unbekannte Version → 404; Content-Type `application/geo+json` für `coast.geojson`.
    - `GET /api/v1/schema/[version]/[file]` → `contractJsonSchema`, sonst 404; `dataVersion` `null`.
  - `ROUTE_POLICY` + `"/api/v1/areas"`, `"/api/v1/areas/[area]/package"`, `"/api/v1/areas/[area]/package/[file]"`, `"/api/v1/areas/[area]/changes"`, `"/api/v1/spots/[id]"`, `"/api/v1/schema/[version]/[file]"` je `{ kind: "api", scope: "delivery:read" }`.

- [ ] **Step 1: Failing tests** (Routen direkt aufgerufen: `GET(new Request(url, { headers }), { params: Promise.resolve({...}) })`; Paket über `buildDelivery` in `withRollback` mit `testArchive()`, Archiv per Test-Seam `setDeliveryArchive(testArchive())` in `read.ts`)

```ts
it("errors carry code and message", async () => expect(await (await wrapped(reqWith())).json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid API key." } }));
it("401 without key, 401 with a revoked key, 403 with reports:write only", …);
it("the package manifest links every file of the current data version", …);
it("a file is served byte-identical to the manifest hash with schema and data version headers", …);
it("an older data version is served from the archive", …);                  // zwei Lieferungen, ?dataVersion=1
it("unknown file and traversal are 404", …);                                // "secrets.json", "..%2fspots.json" über decideAccess + Route
it("If-None-Match returns 304", …);
it("Cache-Control is private, max-age=60", …);
it("a rejected package is never served", …);                                // nur abgelehnte Lieferung → 404 auf package und Datei
it("the schema endpoint returns the checked-in JSON schema", …);
it("every new api route is in the route policy", …);                        // vorhandener Policy-Test erweitert
```

- [ ] **Step 2: Run** `npx vitest run lib/api app/__tests__/api-package.test.ts lib/security` → FAIL. **Step 3:** implementieren; vorher `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` (dynamische Segmente, `RouteContext`) lesen. Bestehende Erwartungen in `handler.test.ts` auf `{ code, message }` anpassen. **Step 4: Run** `npx vitest run lib/api app lib/security && npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(api): areas, package and file endpoints with ETag, schema endpoint`

### Task 12: API – Änderungen seit Version und Spot zum Datum

**Files:**
- Create: `app/api/v1/areas/[area]/changes/route.ts`, `app/api/v1/spots/[id]/route.ts`
- Modify: `lib/domain/delivery/read.ts`
- Test: `app/__tests__/api-changes-spots.test.ts`

**Interfaces:**
- Consumes: `mergeChanges` (Task 7), `delivered_objects`, `validDelivery`, `readDeliveryFile`, `apiBody`/`apiError` (Task 11).
- Produces:
  - `changesSince(db, archive, areaGeoObjectId: string, since: number): Promise<{ dataVersion: number; changes: ChangeEntry[] } | "invalid_since" | "not_found">` – keine gültige Lieferung → `not_found`; `since < 1` oder `since > aktuell` → `invalid_since`; `since = aktuell` → `[]`; sonst `mergeChanges` über `changes.json` der Versionen `since + 1 … aktuell`.
  - `spotAsOf(db, archive, publicId: string, asOf?: string): Promise<{ spot: Spot; dataVersion: number } | null>` – `delivered_objects` mit `public_id`, `valid_from ≤ asOf` (ohne `asOf`: alle), höchste `profile_version`; `removed` → `null`; Inhalt aus `spots.json` der `first_delivery_id`.
  - `GET /api/v1/areas/[area]/changes?since=` → `{ schemaVersion, area, since, dataVersion, changes }`; `since` fehlt oder nicht ganzzahlig → 400 `invalid_since`.
  - `GET /api/v1/spots/[id]?asOf=YYYY-MM-DD` → `{ schemaVersion, dataVersion, spot }`; `id` nicht `sp_<ulid>` → 404; `asOf` kein gültiges Kalenderdatum (`z.iso.date()` plus Rundreise über `Date`) → 400 `invalid_date`; nichts geliefert → 404.

- [ ] **Step 1: Failing tests**

```ts
it("changes since 1 merge the change files of versions 2 and 3", …);       // drei Lieferungen mit wechselnden Objekten
it("since equal to the current version is empty, since 0 is 400", …);
it("since above the current version is 400", …);
it("asOf returns the spot version delivered on that date", …);             // v1 am 2026-10-01, v2 am 2026-10-15 → asOf 2026-10-10 liefert v1
it("asOf before the first delivery is 404", …);
it("an invalid date is 400", …);                                            // "2026-13-45", "2026-02-30", "gestern"
it("a removed spot is 404 after removal and found before", …);
it("responses carry ETag and Periplus-Schema-Version 1.0", …);
```

- [ ] **Step 2: Run** `npx vitest run app/__tests__/api-changes-spots.test.ts` → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run app lib/domain/delivery` → PASS.
- [ ] **Step 5: Commit** `feat(api): merged change feed since a data version and spot as of a date`

### Task 13: Seite `/deliveries`, Download, „Paket bauen“, Übersicht, API-Clients

**Files:**
- Create: `lib/domain/delivery/view.ts`, `app/(admin)/deliveries/page.tsx`, `app/(admin)/deliveries/actions.ts`, `app/(admin)/deliveries/[id]/page.tsx`, `app/(admin)/deliveries/[id]/files/[file]/route.ts`, `app/(admin)/settings/actions.ts`
- Modify: `app/(admin)/_components/{nav.tsx,labels.ts}`, `app/(admin)/page.tsx`, `lib/domain/overview.ts`, `app/(admin)/settings/page.tsx`, `lib/domain/api-clients.ts`, `lib/security/route-policy.ts`
- Test: `lib/domain/delivery/__tests__/view.test.ts`, `app/(admin)/__tests__/delivery-actions.test.ts`, `lib/domain/__tests__/api-clients.test.ts`

**Interfaces:**
- Consumes: `startDeliveryRun` (Task 10), `previousPackage`, `readDeliveryFile`, `ValidationReport`, `revokeApiClient`, `requireAdmin`, `adminSession`, `getBoss`.
- Produces:
  - `listDeliveries(db, filter: { areaId?: string; page: number }): Promise<{ areas: Array<{ geoObjectId: string; key: string; name: string; current: { dataVersion: number; generatedAt: Date } | null }>; rows: Array<{ id: string; areaName: string; status: DeliveryStatus; dataVersion: number | null; generatedAt: Date; failedChecks: CheckName[]; objectCounts: Record<string, number>; runId: string | null }>; total: number }>` – 50 je Seite, neueste zuerst.
  - `deliveryDetail(db, archive, id: string): Promise<{ row: DeliveryRow; report: ValidationReport; changes: ChangeEntry[] | null; files: Array<{ name: ContractFile; sha256: string; bytes: number }>; objectLinks: Record<string, string> } | null>` – `objectLinks` = öffentliche ID → `/places/<placeId>` bzw. `/geo/<geoObjectId>`; `changes` aus `changes.json` (auch für abgelehnte, als „Diff zur Vorversion“).
  - `latestDeliveries(db, limit: number)` in `overview.ts`; Übersicht `/` zeigt die letzten 5 (Revier, Status, Version, Zeit).
  - `listApiClients(db): Promise<Array<{ id: string; name: string; scopes: ApiScope[]; rateLimitPerMin: number; createdAt: Date; revokedAt: Date | null }>>`; Server Action `revokeApiClientAction(input: FormData | { id: string })` (`requireAdmin`, zod-UUID) in `settings/actions.ts`; `/settings` Abschnitt „API-Clients“ mit Liste und „Sperren“ (Anlage weiter per CLI).
  - Server Action `buildDeliveryAction(input: FormData | { areaId: string })` → `startDeliveryRun`, Redirect `/runs/<id>`.
  - Download-Route `GET /deliveries/[id]/files/[file]` (Sitzung wie `map-data`, `no-store`, `Content-Disposition: attachment; filename="<ar>-<dataVersion|rejected>-<file>"`); auch abgelehnte Pakete (Diagnose).
  - Seiten: `/deliveries` – je Revier Kopf mit aktueller Version und Knopf „Paket bauen“, darunter Tabelle (Status farbig, Version, Zeitpunkt, fehlgeschlagene Prüfungen, Objektzahlen, Link zum Lauf); `/deliveries/[id]` – Validierungsbericht je Prüfung (Label, ok/Verstoß, Fundstellen mit Link zum Objekt), Warnungen, Änderungen (Ereignis, Severity, Felder, Zusammenfassung), Dateien mit Größe, Hash und Download.
  - Labels: `DELIVERY_STATUS_LABELS` (`valid` „Gültig“, `rejected` „Abgelehnt“, `unchanged` „Unverändert“), `CHECK_LABELS` (je `CheckName` deutsch, z. B. `verbatim_text` „Kein Text länger als 15 Wörter aus einer Quelle“), `CHANGE_EVENT_LABELS` (`created` „Neu“, `updated` „Geändert“, `excluded` „Ausgeschlossen“, `merged` „Zusammengelegt“, `removed` „Entfernt“), Navigation „Lieferungen“.
  - `ROUTE_POLICY` + `"/deliveries"`, `"/deliveries/[id]"`, `"/deliveries/[id]/files/[file]"` (`admin`).

- [ ] **Step 1: Failing tests**

```ts
it("listDeliveries shows each area with its current version and rows newest first", …);
it("deliveryDetail links findings to the place page", …);
it("buildDeliveryAction starts a delivery run for the area", …);           // runs-Zeile mit params.areaId, Stufe delivery.build
it("buildDeliveryAction rejects an unknown area id", …);
it("the download route needs a session and serves a rejected package's file", …);
it("revoking an api client makes its key fail", …);                        // listApiClients zeigt revokedAt; authenticateApiClient → null
```

- [ ] **Step 2: Run** `npx vitest run lib/domain app` → FAIL. **Step 3:** implementieren; vorher Next-Doku zu Server Actions und Route Handlers lesen. **Step 4: Run** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): deliveries page with report, changes, download and build action; api clients`

### Task 14: Ort-Reiter „Lieferung“

**Files:**
- Create: `app/(admin)/places/[id]/delivery-tab.tsx`
- Modify: `lib/domain/delivery/view.ts`, `app/(admin)/places/[id]/page.tsx`
- Test: `lib/domain/delivery/__tests__/place-delivery.test.ts`

**Interfaces:**
- Consumes: `spotAsOf` (Task 12), `loadAreaScope`-Bausteine und `mapSpot` (Tasks 3, 4), `contentHash` (Task 7).
- Produces:
  - `placeDelivery(db, archive, placeId: string): Promise<{ delivered: { spot: Spot; dataVersion: number; deliveryId: string } | null; preview: { spot: SpotBody; differs: boolean } | { omitted: string } | null; history: Array<{ profileVersion: number; validFrom: string; removed: boolean; deliveryId: string }> }>` – `delivered` = `spotAsOf(publicId)`; `preview` = `mapSpot` aus dem jüngsten Profil (Kontext `regionId`/`highlightIds` des gelieferten Objekts), `differs` = `contentHash` ungleich dem gelieferten; ohne `public_id` alles `null`.
  - Reiter „Lieferung“ (`?tab=delivery`): gelieferte JSON-Form (formatiert, `<pre>`), Version, `validFrom`, Link zur Lieferung; Hinweis „Nächstes Paket weicht ab“ mit der Vorschau, wenn `differs`; Versionsliste.

- [ ] **Step 1: Failing tests**

```ts
it("shows the delivered spot and no difference right after a build", …);
it("a newer profile shows a differing preview", …);
it("a candidate without public id has no delivery tab content", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/delivery/__tests__/place-delivery.test.ts` → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): place delivery tab with delivered contract object and preview`

### Task 15: Abnehmer-Skript, e2e, Runbook, Abnahme

**Files:**
- Create: `scripts/delivery-consume.ts`, `e2e/delivery.spec.ts`, `docs/pilot/m6-abnahme.md`
- Modify: `package.json` (`"delivery:consume": "tsx --env-file-if-exists=.env.local scripts/delivery-consume.ts"`), `e2e/global-setup.ts` (Synthetik-Revier mit gebautem Paket), `docs/runbook.md`
- Test: `scripts/__tests__/delivery-consume.test.ts`

**Interfaces:**
- Consumes: alle API-Routen (Tasks 11, 12), `seedDeliveryArea`, `buildDelivery`, `createApiClient`.
- Produces:
  - `consumePackage(input: { baseUrl: string; key: string; area: string; fetch?: typeof fetch }): Promise<{ dataVersion: number; files: Array<{ name: string; sha256Ok: boolean; schemaErrors: string[] }>; ok: boolean }>` – holt Manifest, je Link die Datei, prüft sha256 gegen das Manifest und validiert mit eigenem Ajv-2020 gegen das von `GET /schema/1.0/<file>` geladene Schema; nutzt nur die API (keine DB, keine Projekt-Imports außer Typen) – so prüft es, was ein fremder Abnehmer sieht.
  - CLI `npm run delivery:consume -- --base-url https://… --key pk_… --area saronic` – Ausgabe je Datei, Exit 1 bei `ok false`.
  - e2e: Login → `/deliveries` → Synthetik-Revier zeigt „Gültig“ und Version 1 → Detailseite listet alle 16 Prüfungen als bestanden → Download von `spots.json` liefert 200 → „Paket bauen“ führt auf die Lauf-Seite mit Stufe `delivery.build`.

- [ ] **Step 1: Failing test** – `delivery-consume.test.ts`: `fetch`-Stub, der URLs auf die Route-Handler abbildet; `a built package is consumed with matching hashes and no schema errors` und `a tampered file fails the hash check`.
- [ ] **Step 2: Run** `npx vitest run scripts/__tests__/delivery-consume.test.ts` → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Runbook** – Abschnitt „Lieferung“: Voraussetzung Profile (M5, `check:profiles`) → `/deliveries` „Paket bauen“ je Revier → Bericht prüfen; Verstöße beheben (Dublette: Orte zusammenlegen; kopierte Summary: Summary neu erzeugen; Spot außerhalb: Position korrigieren) → erneut bauen; API-Schlüssel `npm run apikey:create -- --name <abnehmer> --scopes delivery:read`, Sperren unter `/settings`; Abnehmer-Prüfung `delivery:consume`; neue Vertragsversion: neues Verzeichnis `contract/v2`, `contract:generate`, `schemaVersion` in `config/delivery.json`. Hinweis ODbL: Pakete bis zur rechtlichen Prüfung nur intern. `docs/pilot/m6-abnahme.md`: Checkliste (Paket Saronischer Golf `valid`, alle 16 Prüfungen grün, `delivery:consume` gegen den Server grün, ein Spot per `asOf` abrufbar, `changes.json` nach zweitem Bau plausibel, ODbL-Prüfung erledigt).
- [ ] **Step 6: Gesamtprüfung** – `npm run lint && npm run typecheck && npx vitest run && npm run test:e2e && npm run build` → alles grün.
- [ ] **Step 7: Commit** `docs: M6 consumer check, delivery e2e, runbook and acceptance`
- [ ] **Step 8: Übergabe an Christian (nicht vom Ausführenden zu erledigen)** – ODbL-Trennung (Spec 08 „Lizenz und ODbL“) rechtlich prüfen lassen; auf dem Server „Paket bauen“ für `saronic` (und `argolic`), Bericht grün, API-Schlüssel für den Test-Abnehmer anlegen, `delivery:consume` gegen den Server, Abnahme-Checkliste abhaken.

---

## Bewusste Abweichungen und Entscheidungen

- **Status `unchanged`** zusätzlich zu `valid`/`rejected`: ein Bau ohne Änderung wird mit Bericht protokolliert, schreibt aber weder Dateien noch eine `dataVersion` (Spec: „nur bei gültigem Paket mit mindestens einer Änderung“). „Änderung“ = ein Vertragsobjekt mit neuer Version, ein entferntes Objekt oder ein geänderter Hash von `coast.geojson`/`weather-points.json`.
- **Abgelehnte Pakete** liegen unter `deliveries/<ar>/rejected/<deliveryId>/` ohne `data_version`; die Nummer im Inhalt ist nur eine Probe. So kollidiert kein abgelehntes Paket mit einer späteren gültigen Version.
- **`delivered_objects` je Revier** (`area_id` zusätzlich): Regionen und Highlights können in zwei Revierpaketen mit unterschiedlichen `spotIds` stehen; ein globaler Zähler würde bei jedem Bau abwechselnd hochzählen. `profileVersion` ist damit die Version des Objekts in diesem Revierpaket.
- **`asOf` liest das Paketarchiv** (`delivered_objects` → Paket der Version), nicht eine Neuberechnung aus `profile_as_of`: ein gespeicherter Törn verweist auf ID und Vertragsversion, und genau diese Form soll er zurückbekommen (Teil B „im Pilot reicht das Archiv der Pakete je `dataVersion`“). Für M7 heißt das: vor dem simulierten Revisit wird ein Paket gebaut.
- **Spot-Auswahl über die Kachel-Partition** (Kachel mit Label-Revier), `bbox` = Ausdehnung der Revierkacheln: jeder Ort steht in genau einem Paket; die Box-Prüfung fängt Zuordnungsfehler.
- **Spots ohne vollständige acht Sektoren werden nicht geliefert** (Warnung im Bericht), statt erfundener Werte; Teil B verlangt acht Sektoren „notfalls aus der Geometrie“, und M2 liefert sie überall außer bei `origin_unresolved`.
- **Spot-Dubletten blockieren** (Admin legt über die vorhandene Ort-Aktion zusammen), **Highlight-Dubletten werden beim Bau zusammengeführt** (Highlights haben kein `mergedInto`; der bedeutendere bleibt, Warnung im Bericht). Highlights ohne Spot im Radius entfallen mit Warnung (Teil B „sonst wird es nicht geliefert“).
- **Highlight-`spotIds` werden beim Bau aus Bedeutung und Radius neu berechnet** (nur gelieferte Spots), statt die internen `derived.spot_ids` zu übersetzen; so gibt es keine Referenz auf nicht gelieferte Orte. `highlightIds` des Spots ist die Umkehrung.
- **Vertragserweiterungen gegenüber Teil B:** `hazards.kind` + `current`, `fishFarm`, `other` (das Fact-Schema v2 kennt sie; Weglassen würde Sicherheitshinweise verschlucken); `berth.bookable`, `mooring.buoys`, `mooring.lineAshoreRequired`, `score.quietness` und `regions.facts.*` dürfen `null` sein (unbekannt statt falsch); `region.polygon` darf `MultiPolygon` sein (Archipele). Alles additiv, Major bleibt 1.
- **Vokabular-Abbildungen:** `pontoon` → `sternTo`, `moderate` (Halt) → `fair`, `firing_area` → `military`, Fährverkehr `low`/`moderate` → `light`; `shop`/`taverna` aus `highlight.supply`/`highlight.food`, `seasonal` nur bei einer Saisonangabe „geöffnet“; `oftenFull` wird in v1 nie erzeugt (keine Datenbasis). `externalRefs.googlePlaceIds` bleibt `{}`, bis es `external_refs` gibt (M8).
- **Alle Vertragstexte außer den Summaries sind Bausteine** (Gefahren, Saisonhinweise, Ausschlussdetail, Regionscharakter, Änderungszusammenfassung): kein Modellaufruf im Paketbau, deterministisch, keine fremden Formulierungen; nur Eigennamen (≤ 80 Zeichen, M4) stammen aus Quellen. Die 15-Wörter-Prüfung läuft trotzdem über alle Textfelder.
- **Provenienz im Vertrag** je Vertragsfeld flach (Teil B), zusammengefasst: Herkunft review vor observed vor text vor computed, Konfidenz = Minimum der Teilattribute; `gazetteer`/`derived` gelten als `computed`. Damit ist die Hafen-Regel (Untergrenze 0,8 nur ohne Text) im Paket prüfbar.
- **Severity in `changes.json`** = Maximum aus der Vertragsregel von Teil B (auf dem Objekt-Diff) und den `change_events` des Geo-Objekts seit dem `change_seq` des Vorgängerpakets (Spec 07); `removed`, `merged`, `excluded` sind mindestens `notable`.
- **Wetterpunkt am Kap:** die Winkelhalbierende wird als Richtung vom Landschwerpunkt im 2-km-Umkreis zum Kap angenähert; Wetterpunkt-IDs `wp_…` sind ein Hash der Geo-Objekt-ID (stabil, ohne interne IDs offenzulegen).
- **JSON-Schemas beim Ausliefern aus zod berechnet**, nicht aus den Dateien gelesen: ein Drift-Test hält Dateien und Laufzeit gleich, und Next muss keine Dateien außerhalb von `app/` mitnehmen.
- **Fehlerformat** `{ error: { code, message } }` gilt jetzt auch für 401/403/429/500 aus `withApiClient`; die Nachrichten sind fest und englisch (API-Sprache).
- **`/api/v1/schema/…` braucht einen Schlüssel** wie alle `/api/v1`-Routen (Default-Deny); ein öffentlicher Schema-Endpunkt wäre eine Ausnahme ohne Bedarf.
- **ODbL:** `coast.geojson` vollständig, OSM-Namen und Regionspolygone als Felder im Manifest ausgewiesen (Konfiguration); `spots.json` enthält keine OSM-Geometrien. Die rechtliche Prüfung bleibt Übergabepunkt; bis dahin nur interne Abnehmer.
- **API-Clients sperren auf `/settings`** (Spec 09) statt eigener Seite (Spec 08 „Seite API-Clients“); Anlage bleibt CLI.
