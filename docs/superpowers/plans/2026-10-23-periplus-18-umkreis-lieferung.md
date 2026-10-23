# Periplus 18 – Lieferung nach Umkreis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Abnehmer lädt mit Heimatmarina und Törndauer ein offline nutzbares Paket für den Umkreis `50 sm × Tage / 2`, zusammengesetzt aus den gültigen Landesteil-Paketen, und holt danach nur die Änderungen; `popularity` bekommt eine feste Nachbarschaft von 50 sm.

**Architecture:** Vertrag 3.0 trägt in Manifest und Dateikopf einen `scope` (Landesteil oder Umkreis). Das Umkreis-Paket wird von einer reinen Funktion (`composeRadiusPackage`) aus den gelesenen Landesteil-Paketen gebaut; eine dünne Schicht liest die Pakete aus S3, schneidet die Küste in PostGIS zu, speichert das Ergebnis unter einem Schlüssel aus den beteiligten Landesteil-Versionen und liefert es über `/api/v3`. Die Liefer-API zieht von `/api/v2` nach `/api/v3` um.

**Tech Stack:** TypeScript, Next.js 16 (Route Handlers), zod 4 (Vertrag), Drizzle + PostgreSQL 17/PostGIS, S3 über `lib/adapters/s3`, Vitest gegen `db-test`.

**Spec:** `docs/superpowers/specs/2026-10-23-periplus-18-umkreis-lieferung-design.md` (dazu Teil-Spec 08, 14, 17)

## Global Constraints

- Radius `= nmPerDay × days × returnFactor` mit `nmPerDay = 50`, `returnFactor = 0.5`; `days` ganzzahlig 1–28; Distanz Großkreis (`distanceNm` in `lib/domain/delivery/geo.ts`).
- Mittelpunkt nur ein ausgelieferter Spot mit `kind = "marina"` und nicht `exclude.excluded`.
- `popularity.neighbourhoodNm = 50`; Formel `log(1 + n) / log(1 + max)` unverändert.
- Werte in `config/delivery.json`, nicht im Code: `"radius": { "nmPerDay": 50, "returnFactor": 0.5, "minDays": 1, "maxDays": 28 }`, `"popularity": { "neighbourhoodNm": 50 }`.
- Vertrag `SCHEMA_VERSION = "3.0"`; 2.3 bleibt als eingefrorene Kopie `contract/v2_3/` reproduzierbar und veröffentlicht. `contract/v2/` bleibt das Verzeichnis der aktuellen Version (Konvention des Repos).
- Kein Objekt im Umkreis-Paket mit einem Wert, der in keinem gültigen Landesteil-Paket steht (nur `spotIds` werden vereinigt und gekürzt).
- Fachlogik nur in `lib/domain`; Routen dünn. Vor Code an Routen und `lib/security/route-policy.ts`: Next-16-Doku in `node_modules/next/dist/docs/` lesen (Route Handlers, `RouteContext`).
- Nur anfügende Tabellen (`radius_packages`, `radius_package_requests`) bekommen den `forbid_mutation`-Trigger wie `deliveries` (`drizzle/0039_delivery_triggers.sql` als Vorbild).
- Tests gegen echte Postgres (`withRollback` aus `test/db.ts`), S3 über das Test-Archiv (`test/s3.ts`) oder ein In-Memory-Archiv; kein Netz. Testdateien, die die Delivery-Fixture seeden, gehören in `DELIVERY_FIXTURE_TESTS` in `vitest.config.ts`.
- Oberflächentexte Deutsch, Code und Bezeichner Englisch. Commits enden mit `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Nach jeder Aufgabe grün: `npx vitest run <betroffene Dateien>`, `npx tsc --noEmit`, `npm run lint`.

## Review Focus

- Kreis über den Antimeridian ist im Mittelmeer unmöglich, aber ein Kreis, der **keinen** Landesteil mit Paket außer dem der Marina berührt, muss trotzdem ein gültiges Paket ergeben (nur `delivered`-Eintrag). → Test in Task 4.
- Eine Marina, die im aktuellen Paket ihres Landesteils inzwischen `excluded` oder nicht mehr enthalten ist, darf kein Paket mehr bekommen (404), auch wenn ein altes Umkreis-Paket für sie im Zwischenspeicher liegt. → Test in Task 5.
- Zwei gleichzeitige Anfragen mit derselben Marina und Dauer bauen nur einmal und liefern denselben Schlüssel. → Test in Task 5.
- `since` mit dem Schlüssel eines Pakets für eine andere Marina oder Dauer ist 400, nicht eine Liste falscher Änderungen. → Test in Task 6.
- Ein Highlight außerhalb des Kreises, dessen einziger zugeordneter Spot im Kreis liegt, bleibt mit gekürzten `spotIds` im Paket; eines, das keinem enthaltenen Spot zugeordnet ist und außerhalb liegt, fehlt. → Test in Task 4.

---

### Task 1: Vertrag 3.0 mit `scope`, Landesteil-Pakete in 3.0

**Files:**
- Create: `contract/v2_3/*` (Kopie von `contract/v2/*` vor der Änderung, `schemaVersion: z.literal("2.3")` bleibt dort)
- Create: `contract/schema/3.0/*.schema.json` (über `npm run contract:generate`)
- Modify: `contract/v2/common.ts`, `contract/v2/manifest.ts`, `contract/v2/index.ts`, `contract/index.ts`, `contract/schema/published.ts`
- Modify: `lib/domain/delivery/build.ts` (Kopf und `buildManifest`), `lib/domain/delivery/validate.ts` (Prüfungen `ids`, `data_version`, Kopf-gegen-Manifest bei Zeile ~487–515), `lib/domain/delivery/read.ts`, `lib/domain/delivery/view.ts` und alle weiteren Leser von `manifest.subdivision`/`manifest.dataVersion` (finden mit `grep -rn "manifest\.\(subdivision\|dataVersion\|previousDataVersion\)\|\.subdivision\b" lib app scripts`), `scripts/delivery-consume.ts`, `config/delivery.json` (`schemaVersion: "3.0"`), `test/fixtures/delivery/package.ts`
- Test: `contract/__tests__/contract.test.ts`, `lib/domain/delivery/__tests__/build.test.ts`, `lib/domain/delivery/__tests__/validate.test.ts`

**Interfaces:**
- Produces (in `contract/v2`, exportiert über `@/contract`):
  - `subdivisionRef = z.strictObject({ id: publicId("sd"), key, name, names, polygon: areal })` (der bisherige Inhalt von `manifest.subdivision`)
  - `coverageEntry = z.strictObject({ id: publicId("sd"), key: z.string().min(1), name: z.string().min(1), status: z.enum(["delivered", "missing"]), dataVersion: z.number().int().min(1).nullable() })` mit Refinement `status === "delivered"` ⇔ `dataVersion !== null`
  - `manifestScope = z.discriminatedUnion("type", [ { type: "subdivision", subdivision: subdivisionRef, dataVersion: int ≥ 1, previousDataVersion: int ≥ 1 | null }, { type: "radius", key: z.string().regex(/^[0-9a-f]{16}$/), homeMarina: { id: publicId("sp"), name }, center: latLon, days: int 1–28, radiusNm: z.number().positive(), circle: geoPolygon } ])`
  - `fileScope = z.discriminatedUnion("type", [ { type: "subdivision", id: publicId("sd"), dataVersion: int ≥ 1 }, { type: "radius", key: /^[0-9a-f]{16}$/ } ])`
  - `fileEnvelope = { schemaVersion: z.literal("3.0"), scope: fileScope, generatedAt: isoDateTime }`
  - `manifestSchema`: `schemaVersion: "3.0"`, `scope: manifestScope`, `coverage: z.array(coverageEntry).min(1)`, ohne `subdivision`, `dataVersion`, `previousDataVersion`; Rest unverändert
  - Typen `ManifestScope`, `FileScope`, `CoverageEntry` über `@/contract`; `SCHEMA_VERSION = "3.0"`
- Produces (`lib/domain/delivery/read.ts`): `manifestSubdivision(m: Manifest): { id: string; key: string; dataVersion: number } | null` — `null` für ein Umkreis-Manifest; alle bisherigen Leser gehen darüber.

- [ ] **Step 1: 2.3 einfrieren.** `contract/v2/` nach `contract/v2_3/` kopieren, Kopfkommentare auf „frozen 2.3“ anpassen, in `contract/index.ts` `CONTRACT_SCHEMAS_V2_3` und Eintrag `"2.3"` in `SCHEMAS_BY_VERSION` wie bei 2.2 ergänzen, Kommentar oben um 3.0 erweitern („3.0 adds `scope` and `coverage`, spec 18; major“).

- [ ] **Step 2: Failing tests schreiben** in `contract/__tests__/contract.test.ts`:

```ts
it("3.0 manifest takes a subdivision scope and a radius scope", () => {
  const base = validPackage().manifest; // fixture auf 3.0 umgestellt (Step 4)
  expect(manifestSchema.safeParse(base).success).toBe(true);
  const radius = { ...base, scope: { type: "radius", key: "0123456789abcdef", homeMarina: { id: SPOT_M, name: "Marina" },
    center: { lat: 37.5, lon: 23.4 }, days: 7, radiusNm: 175, circle: CIRCLE_FIXTURE }, objectCounts: { ...base.objectCounts, changes: 0 } };
  expect(manifestSchema.safeParse(radius).success).toBe(true);
  expect(manifestSchema.safeParse({ ...base, subdivision: base.scope }).success).toBe(false); // strict: no 2.3 field
});
it("coverage: delivered needs a data version, missing has none", () => {
  expect(coverageEntry.safeParse({ id: SUBDIVISION_ID, key: "XT", name: "X", status: "missing", dataVersion: 3 }).success).toBe(false);
  expect(coverageEntry.safeParse({ id: SUBDIVISION_ID, key: "XT", name: "X", status: "delivered", dataVersion: null }).success).toBe(false);
});
it("publishes 2.3 and 3.0", () => {
  expect(publishedJsonSchema("2.3", "manifest.schema.json")).not.toBeNull();
  expect(publishedJsonSchema("3.0", "manifest.schema.json")).toEqual(contractJsonSchema("3.0", "manifest.schema.json"));
});
```

`CIRCLE_FIXTURE`: ein geschlossener `Polygon`-Ring mit 5 Positionen, 5 Nachkommastellen.

- [ ] **Step 3: Tests laufen lassen.** `npx vitest run contract/__tests__/contract.test.ts` → FAIL (`coverageEntry` nicht exportiert).

- [ ] **Step 4: Schemas umstellen** (`contract/v2/common.ts`, `manifest.ts`, `index.ts`), dann `npm run contract:generate` und `contract/schema/published.ts` um `"3.0"` ergänzen. Fixture `test/fixtures/delivery/package.ts` (`validPackage`, `PREVIOUS`) auf 3.0 umstellen: Kopf `scope: { type: "subdivision", id: SUBDIVISION_ID, dataVersion }`, Manifest `scope` + `coverage: [{ id: SUBDIVISION_ID, key, name, status: "delivered", dataVersion }]`.

- [ ] **Step 5: Bau und Prüfung umstellen.** `build.ts`: Kopf `{ schemaVersion: SCHEMA_VERSION, scope: { type: "subdivision", id, dataVersion }, generatedAt }`; `buildManifest` schreibt `scope` (mit `dataVersion`, `previousDataVersion`) und `coverage` mit genau einem `delivered`-Eintrag. `validate.ts`: Prüfung Kopf gegen Manifest vergleicht `scope` (Typ, ID bzw. Schlüssel, `dataVersion` nur bei `subdivision`); `ids` besucht `scope.subdivision.id` bzw. `scope.homeMarina.id` und jede `coverage[].id`; `data_version` und `changes_complete` greifen nur bei `scope.type === "subdivision"`. Einen Test in `validate.test.ts` ergänzen: „Kopf mit anderer Landesteil-ID als `scope` im Manifest → Befund“.

- [ ] **Step 6: Leser umstellen** über `manifestSubdivision` (read.ts, view.ts, Admin-Seiten unter `app/(admin)/deliveries`, `scripts/delivery-consume.ts`). `deliveries.schema_version` neuer Zeilen ist `"3.0"`; alte Zeilen bleiben lesbar (ihr Manifest ist 2.x und wird nur als Datei ausgeliefert, nicht über `manifestSubdivision` gelesen — wo Admin-Code alte Manifeste liest, fällt er auf die Spalten von `deliveries` zurück).

- [ ] **Step 7: Verifizieren.** `npx vitest run contract lib/domain/delivery scripts/__tests__/delivery-consume.test.ts app/__tests__/api-package.test.ts` → PASS; `npx tsc --noEmit` und `npm run lint` sauber.

- [ ] **Step 8: Commit** `feat(contract): contract 3.0 with scope and coverage, subdivision packages in 3.0 (spec 18)`

---

### Task 2: Liefer-API zieht nach `/api/v3`

**Files:**
- Move: `app/api/v2/**` → `app/api/v3/**` (`git mv`)
- Modify: `lib/security/route-policy.ts` (Einträge `/api/v2/…` → `/api/v3/…`), `lib/domain/delivery/read.ts` (Links in `currentPackage`), `lib/domain/revisit/verify.ts`, `scripts/delivery-consume.ts`, `docs/runbook.md` (Pfade), `e2e/**` falls Treffer (`grep -rn "api/v2" app lib scripts e2e docs/runbook.md`)
- Test: `app/__tests__/api-package.test.ts`, `app/__tests__/api-changes-spots.test.ts`, `lib/security/__tests__/route-policy.test.ts`

**Interfaces:**
- Consumes: Task 1 (`SCHEMA_VERSION = "3.0"`).
- Produces: Basis `/api/v3` für alle späteren Routen; `/api/v2/*` antwortet 404 (Route existiert nicht mehr). `/api/v1/schema/…` bleibt.

- [ ] **Step 1: Failing test** in `lib/security/__tests__/route-policy.test.ts`: `expect(Object.keys(ROUTE_POLICY).some((r) => r.startsWith("/api/v2/"))).toBe(false)` und `expect(ROUTE_POLICY["/api/v3/subdivisions"]).toEqual({ kind: "api", scope: "delivery:read" })` (Namen wie in der Datei).
- [ ] **Step 2:** `npx vitest run lib/security/__tests__/route-policy.test.ts` → FAIL.
- [ ] **Step 3:** Routen verschieben, `RouteContext<"/api/v3/…">`-Typen, Policy, Links und Aufrufer umstellen; in den API-Tests die Pfade ersetzen.
- [ ] **Step 4:** `npx vitest run lib/security app/__tests__ lib/domain/revisit scripts/__tests__/delivery-consume.test.ts` → PASS; `npm run build` läuft durch (prüft die Routentypen).
- [ ] **Step 5: Commit** `refactor(api): delivery API moves to /api/v3 (spec 18)`

---

### Task 3: `popularity` mit fester Nachbarschaft

**Files:**
- Modify: `lib/domain/consolidation/derived/popularity.ts`, `lib/domain/delivery/load.ts:82`, `lib/config/schemas.ts` (`deliverySchema`), `config/delivery.json`, `lib/domain/delivery/types.ts` (Kommentar `popularity`), `docs/superpowers/specs/2026-10-18-periplus-07-konsolidierung-design.md` (Zeile zu `popularity`: Verweis auf Teil-Spec 18)
- Test: `lib/domain/consolidation/derived/__tests__/popularity-neighbourhood.test.ts` (neu, DB)

**Interfaces:**
- Produces: `popularityForPlaces(db: Db, geoObjectIds: string[], today: string, neighbourhoodNm: number): Promise<Map<string, number>>` — für jeden übergebenen Ort, der die bisherigen Bedingungen erfüllt (bestätigt, nicht zusammengelegt, gültig am `today`, gültiges Geo-Objekt und gültige Kachel; Bedingungen aus `popularityForSubdivision` übernehmen), `popularity(n, max)` mit `max` über alle so gültigen Orte **jedes Landesteils** innerhalb `neighbourhoodNm` (Geography-Distanz zwischen `geo_objects.centroid`, `ST_DWithin(a::geography, b::geography, nm × 1852)`), der Ort selbst eingeschlossen. `popularityForSubdivision` entfällt.
- Config: `DeliveryConfig["popularity"] = { neighbourhoodNm: number }` (positiv), `DeliveryConfig["radius"] = { nmPerDay: number; returnFactor: number; minDays: number; maxDays: number }` (positiv, `minDays ≤ maxDays`, ganzzahlige Tage) — beide hier einführen, `radius` nutzt Task 4.

- [ ] **Step 1: Failing test** (`withRollback`, Orte direkt seeden wie in den bestehenden Konsolidierungstests unter `test/consolidation.ts`):

```ts
it("normalises within 50 nm across subdivisions", async () => {
  // A (sources 2) in Landesteil X, B (sources 8) in Landesteil Y, 30 nm apart; C (sources 4) 80 nm from A, in X
  const p = await popularityForPlaces(tx, [a, b, c], TODAY, 50);
  expect(p.get(a)).toBeCloseTo(Math.log(3) / Math.log(9));   // max in A's neighbourhood is B (8)
  expect(p.get(b)).toBeCloseTo(1);
  expect(p.get(c)).toBeCloseTo(1);                            // alone within 50 nm
});
it("a place without sources gets 0, a candidate place no value", async () => { /* n = 0 → 0; status candidate → not in map */ });
```

- [ ] **Step 2:** `npx vitest run lib/domain/consolidation/derived/__tests__/popularity-neighbourhood.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren; `load.ts` ruft `popularityForPlaces(db, spotRows.map(r => r.geoObjectId), today, cfg.popularity.neighbourhoodNm)`. Config-Schema und `config/delivery.json` ergänzen.
- [ ] **Step 4:** `npx vitest run lib/domain/consolidation lib/domain/delivery` → PASS (bestehende `load.test.ts`-Erwartungen zu `popularity` an die Nachbarschaft anpassen, nicht löschen).
- [ ] **Step 5: Commit** `feat(consolidation): popularity per fixed 50 nm neighbourhood across subdivisions (spec 18)`

---

### Task 4: Umkreis-Paket zusammensetzen (rein)

**Files:**
- Create: `lib/domain/delivery/radius/geometry.ts`, `lib/domain/delivery/radius/compose.ts`, `lib/domain/delivery/radius/types.ts`
- Test: `lib/domain/delivery/radius/__tests__/geometry.test.ts`, `lib/domain/delivery/radius/__tests__/compose.test.ts`

**Interfaces:**
- Consumes: Task 1 (Typen `Manifest`, `CoverageEntry`, `FileScope`, Dateitypen), Task 3 (`DeliveryConfig["radius"]`).
- Produces (`geometry.ts`):
  - `radiusNm(days: number, cfg: DeliveryConfig["radius"]): number` — wirft `RangeError` außerhalb `minDays…maxDays` oder bei nicht ganzzahligen Tagen
  - `circlePolygon(center: LonLat, radiusNm: number, segments = 64): GeoJSON.Polygon` — geodätische Zielpunkte, gegen den Uhrzeigersinn, geschlossen, 5 Nachkommastellen (`round5`)
  - `circleBbox(center: LonLat, radiusNm: number): [number, number, number, number]`
  - `regionTouchesCircle(region: Region, center: LonLat, radiusNm: number): boolean` — mit Polygon: `distanceToPolygonNm(center, polygon) ≤ radiusNm`; ohne: `distanceNm(center, region.center) - region.radiusNm ≤ radiusNm`
- Produces (`types.ts`):
  - `SourcePackage = { coverage: CoverageEntry & { status: "delivered" }; generatedAt: string; spots: Spot[]; highlights: Highlight[]; regions: Region[]; weatherPoints: WeatherPoint[]; tiles: Manifest["tiles"]; areas: Manifest["areas"]; licenses: Manifest["licenses"]; imageFiles: Array<{ name: string; sha256: string; bytes: number }> }`
  - `RadiusInput = { key: string; homeMarina: Spot; days: number; radiusNm: number; generatedAt: string; packages: SourcePackage[]; missing: Array<CoverageEntry & { status: "missing" }>; missingTiles: string[] }`
  - `ComposedRadius = { manifestDraft: Omit<Manifest, "files" | "objectCounts">; files: { "spots.json": SpotsFile; "highlights.json": HighlightsFile; "regions.json": RegionsFile; "weather-points.json": WeatherPointsFile }; imageFiles: SourcePackage["imageFiles"]; warnings: string[] }`
- Produces (`compose.ts`): `composeRadiusPackage(input: RadiusInput, cfg: DeliveryConfig): ComposedRadius` — ohne `coast.geojson` (Task 5) und ohne `files`/`objectCounts` im Manifest (Task 5 rechnet sie nach dem Serialisieren).

Regeln (aus der Spec, hier verbindlich):
- Spots: Position im Kreis (`distanceNm ≤ radiusNm`).
- Highlights: mindestens ein `spotId` in den enthaltenen Spots **oder** Position im Kreis; `spotIds` gekürzt auf enthaltene Spots.
- Regionen: `regionTouchesCircle`, dazu rekursiv jede `parentId` (aus irgendeinem Paket); jede `regionId` eines enthaltenen Spots oder Highlights muss enthalten sein, sonst wird die Region nachgezogen; `spotIds` gekürzt.
- Wetterpunkte: `distanceNm(center, position) ≤ radiusNm + cfg.coast.marginNm` und `regionId` null oder enthalten.
- Doppelte IDs über Pakete: höhere `profileVersion`, bei Gleichstand jüngeres `generatedAt`; `spotIds` vereinigt (dann gekürzt); sonstige Abweichung (Vergleich ohne `spotIds`, `profileVersion`, `validFrom`) → `warnings` mit ID.
- Bilder: alle `imageFiles`, deren Name mit der ID eines enthaltenen Spots oder Highlights beginnt (`images/<id>-<slot>.jpg`).
- Manifest-Entwurf: `scope = { type: "radius", key, homeMarina: { id, name }, center: homeMarina.position, days, radiusNm, circle: circlePolygon(...) }`; `coverage` = gelieferte plus `missing`, nach `key` sortiert; `bbox = circleBbox`; `tiles` = Kacheln der Pakete, deren 0,25°-Zelle (`q025:<x>:<y>`, Zelle aus der ID wie in `lib/domain/tiles` berechnen) den Kreis schneidet, plus `missingTiles` mit `lastRunAt: null, profilesAsOf: null`, nach ID sortiert; `areas` und `licenses` vereinigt (Lizenzen nach `name`, `files`/`fields` vereinigt); Kopf jeder Datei `{ schemaVersion: SCHEMA_VERSION, scope: { type: "radius", key }, generatedAt }`. Alle Listen nach `id` sortiert.

- [ ] **Step 1: Failing tests `geometry.test.ts`:** `radiusNm(7) === 175`, `radiusNm(1) === 25`, `radiusNm(28) === 700`, `radiusNm(0)`, `radiusNm(29)`, `radiusNm(2.5)` werfen `RangeError`; `circlePolygon` hat 65 Positionen, erste = letzte, jeder Punkt `distanceNm` zum Mittelpunkt in `radiusNm ± 0.01`; `regionTouchesCircle` für Polygon knapp außerhalb (Abstand R + 0,1) false, knapp innerhalb true.
- [ ] **Step 2: Failing tests `compose.test.ts`** mit zwei `SourcePackage`, gebaut aus `validPackage()` (zweiter Landesteil: IDs und Positionen verschoben, eigene `coverage`):
  - Spot bei R − 0,1 sm enthalten, bei R + 0,1 sm nicht.
  - Highlight außerhalb mit einzigem Spot innerhalb: enthalten, `spotIds` nur dieser Spot; Highlight außerhalb ohne enthaltenen Spot: fehlt.
  - Region, die den Kreis nur schneidet, enthalten samt `parentId`-Kette.
  - Gemeinsame Region in beiden Paketen: einmal, Fassung mit höherer `profileVersion`, `spotIds` = Vereinigung ∩ enthaltene Spots; abweichender `name` bei gleicher Version → eine Warnung, kein Fehler.
  - Nur der Landesteil der Marina berührt: `coverage` hat einen `delivered`-Eintrag; mit `missing`: `coverage` enthält ihn, `tiles` enthält `missingTiles` mit `lastRunAt: null`.
  - Kein neuer Wert: jedes Objekt im Ergebnis ist, ohne `spotIds`, `toEqual` einer seiner Eingangsfassungen ohne `spotIds`.
  - Ergebnis besteht `spotsFileSchema`, `highlightsFileSchema`, `regionsFileSchema`, `weatherPointsFileSchema`.
- [ ] **Step 3:** `npx vitest run lib/domain/delivery/radius` → FAIL.
- [ ] **Step 4:** `geometry.ts`, `types.ts`, `compose.ts` implementieren.
- [ ] **Step 5:** `npx vitest run lib/domain/delivery/radius` → PASS.
- [ ] **Step 6: Commit** `feat(delivery): compose a radius package from subdivision packages (spec 18)`

---

### Task 5: Umkreis-Paket bauen, speichern, zwischenspeichern

**Files:**
- Create: `lib/db/schema/radius.ts` (in `lib/db/schema/index.ts` exportieren), `drizzle/0069_radius_packages.sql` über `npm run db:generate` plus Trigger von Hand (Vorbild `drizzle/0039_delivery_triggers.sql`)
- Create: `lib/domain/delivery/radius/build.ts`, `lib/domain/delivery/radius/coast.ts`, `lib/domain/delivery/radius/load.ts`
- Test: `lib/domain/delivery/radius/__tests__/build.test.ts` (in `DELIVERY_FIXTURE_TESTS`), `test/fixtures/delivery/radius.ts` (Helfer)

**Interfaces:**
- Consumes: Task 4 (`composeRadiusPackage`, `radiusNm`, `circlePolygon`), Task 1 (`manifestSchema`, `CONTRACT_SCHEMAS`), `validDelivery`, `readJsonFile`, `readManifest`, `deliveryArchive` aus `read.ts`, `serializeFile`/`sha256Hex` aus `serialize.ts`.
- Produces (Tabellen, beide nur anfügend):
  - `radius_packages(id uuid pk, key text unique not null, home_marina_public_id text not null, days int not null, radius_nm double not null, coverage jsonb not null /* CoverageEntry[] */, schema_version text not null, generated_at timestamptz not null, storage_prefix text not null, file_hashes jsonb not null, object_counts jsonb not null, warnings jsonb not null default '[]', created_at)`
  - `radius_package_requests(id uuid pk, radius_package_id uuid not null references radius_packages, api_client_id uuid null references api_clients, kind text not null check in ('package','file','changes'), created_at)`
- Produces (`load.ts`):
  - `resolveHomeMarina(db: Db, archive: Archive, publicId: string): Promise<{ spot: Spot; subdivisionId: string } | null>` — Spot aus dem **aktuellen** gültigen Paket seines Landesteils (Landesteil über die jüngste nicht entfernte `delivered_objects`-Zeile); null, wenn nicht enthalten, `kind !== "marina"` oder `exclude?.excluded`.
  - `radiusCoverage(db: Db, circle: GeoJSON.Polygon): Promise<{ delivered: Array<{ subdivisionId: string; entry: CoverageEntry }>; missing: CoverageEntry[]; missingTiles: string[] }>` — aktive, gültige Landesteile mit `ST_Intersects(subdivisions.geom, circle)`; `missingTiles` = gültige Küstenkacheln (Label = fehlender Landesteil) mit `ST_Intersects` zum Kreis.
  - `loadSourcePackage(db: Db, archive: Archive, subdivisionId: string, entry: CoverageEntry): Promise<SourcePackage & { coast: CoastCollection; prefix: string }>`
- Produces (`coast.ts`): `clipCoast(db: Db, collections: CoastCollection[], circle: GeoJSON.Polygon, marginNm: number, toleranceM: number): Promise<CoastCollection>` — Kreis um `marginNm` gepuffert (Geography); Land = `ST_Union` aller Land-Features ∩ Puffer; Küstenlinie = `ST_LineMerge(ST_Union(...))` ∩ Puffer; Sperrflächen nach (Geometrie, `reason`, `source`) entdoppelt ∩ Puffer; `extractedAt` = jüngstes der Quellen; Ausgabe 5 Nachkommastellen, Reihenfolge wie `buildCoast` (`KIND_ORDER`, dann Geometrie-Text).
- Produces (`build.ts`):
  - `radiusPackageKey(input: { marina: string; days: number; radiusNm: number; coverage: CoverageEntry[]; schemaVersion: string }): string` — erste 16 Hex-Zeichen von `sha256Hex` über `marina|days|radiusNm|schemaVersion|` + `coverage` nach `key` sortiert als `id:dataVersion|missing`
  - `getRadiusPackage(db: Db, archive: Archive, req: { marina: string; days: number; apiClientId?: string; kind?: "package" | "file" | "changes"; now?: Date }): Promise<RadiusPackageRow | "marina_not_found" | "invalid_days">` — prüft Tage (`radiusNm`, `RangeError` → `"invalid_days"`), Marina, Abdeckung; berechnet den Schlüssel; liefert eine vorhandene Zeile, sonst baut sie unter `pg_advisory_xact_lock(hashtext('radius:' || key))` (nach dem Lock erneut nachsehen), schreibt die Dateien nach `deliveries/radius/<marina>/<days>/<key>/` (Bilder von ihrem Landesteil-Präfix kopiert), prüft jede Datei mit `CONTRACT_SCHEMAS[file].safeParse` und die Verweise (jede `spotIds`-, `regionId`-, `parentId`-Referenz zeigt ins Paket), legt die Zeile an; schreibt eine `radius_package_requests`-Zeile. Ein Prüffehler wirft (kein stilles Paket).
  - `RadiusPackageRow = InferSelectModel<typeof radiusPackages>`
  - `readRadiusFile(archive: Archive, row: RadiusPackageRow, file: string): Promise<Uint8Array | null>` (Hash-Prüfung wie `readStoredFile`)
  - `radiusPackageByKey(db: Db, key: string): Promise<RadiusPackageRow | null>`

- [ ] **Step 1: Helfer** `test/fixtures/delivery/radius.ts`: `storeSubdivisionPackage(tx, archive, { subdivisionId, pkg: DeliveryPackage, dataVersion })` legt eine gültige `deliveries`-Zeile samt Dateien und `delivered_objects` an (ohne vollen Bau); `insertSecondSubdivision(tx)` legt einen zweiten aktiven Landesteil neben der Delivery-Fixture an.
- [ ] **Step 2: Failing tests** `build.test.ts`:
  - Marina mit 7 Tagen: Zeile mit `radius_nm = 175`, Manifest besteht `manifestSchema`, `coverage` enthält beide Landesteile, Dateien in S3 mit passenden Hashes.
  - Zweiter Aufruf mit gleichen Eingaben: dieselbe Zeile, kein zweiter Bau (Zahl der `radius_packages` bleibt 1), zwei `radius_package_requests`.
  - Zwei gleichzeitige Aufrufe (`Promise.all` auf zwei Pool-Verbindungen, Muster `startWhileLocked` aus `test/db.ts`): eine Zeile.
  - Neues Paket im zweiten Landesteil (`dataVersion` +1): neuer Schlüssel, neue Zeile.
  - Spot mit `kind: "anchorage"` als Marina → `"marina_not_found"`; Marina im aktuellen Paket `excluded` → `"marina_not_found"`, auch wenn eine ältere Zeile für sie existiert; `days: 0` → `"invalid_days"`.
  - Küste: Land-Feature, das ganz außerhalb des gepufferten Kreises liegt, fehlt; eines, das ihn schneidet, ist zugeschnitten (alle Positionen im Puffer + 0,01 sm).
- [ ] **Step 3:** `npx vitest run lib/domain/delivery/radius/__tests__/build.test.ts` → FAIL.
- [ ] **Step 4:** Schema, Migration (`npm run db:generate`, Trigger ergänzen, `npm run db:migrate` gegen dev und test), `load.ts`, `coast.ts`, `build.ts` implementieren; Testdatei in `DELIVERY_FIXTURE_TESTS` eintragen.
- [ ] **Step 5:** `npx vitest run lib/domain/delivery` → PASS; `npx tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(delivery): build, store and cache radius packages by subdivision versions (spec 18)`

---

### Task 6: Änderungen seit einem Umkreis-Paket

**Files:**
- Create: `lib/domain/delivery/radius/changes.ts`
- Test: `lib/domain/delivery/radius/__tests__/changes.test.ts` (in `DELIVERY_FIXTURE_TESTS`)

**Interfaces:**
- Consumes: Task 5 (`getRadiusPackage`, `radiusPackageByKey`, `readRadiusFile`), `changesSince` aus `read.ts` (je Landesteil, `since` = Version aus der alten `coverage`), `mergeChanges` aus `changes.ts`.
- Produces: `radiusChangesSince(db: Db, archive: Archive, req: { marina: string; days: number; since: string; apiClientId?: string }): Promise<{ key: string; changes: ChangeEntry[] } | "marina_not_found" | "invalid_days" | "invalid_since">`
  - `since` unbekannt oder zu anderer Marina/Tagen → `"invalid_since"`; `since === key` → keine Änderungen.
  - Für jeden Landesteil, der in beiden Paketen `delivered` ist: `changesSince(sd, alteVersion)`; Ergebnis über `mergeChanges` zusammenführen, gefiltert auf IDs aus altem ∪ neuem Paket (Spots, Highlights, Regionen aus `spots.json`, `highlights.json`, `regions.json` beider Pakete).
  - Objekt nur im neuen Paket ohne Eintrag → `{ objectType, objectId, event: "created", fields: [], severity: "info", summary: { de: "Neu im Umkreis" }, profileVersion }`; nur im alten ohne Eintrag → `event: "removed"`, `summary.de` „Nicht mehr im Umkreis“, `profileVersion` aus dem alten Paket. Sortiert nach `objectType`, dann `objectId`.

- [ ] **Step 1: Failing tests:** (a) Spot im Kreis geändert, Landesteil neu gebaut → ein `updated` aus dem Feed; (b) Landesteil vorher `missing`, jetzt gebaut → seine Spots im Kreis als `created` „Neu im Umkreis“; (c) Spot per Korrektur aus dem Kreis verschoben → `removed`; (d) IDs(alt) + `created` − `removed` = IDs(neu); (e) `since` eines Pakets mit anderen Tagen → `"invalid_since"`; (f) `since` = aktueller Schlüssel → `[]`.
- [ ] **Step 2:** `npx vitest run lib/domain/delivery/radius/__tests__/changes.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(delivery): changes since a radius package by key (spec 18)`

---

### Task 7: API-Routen für Umkreis und Heimatmarinas

**Files:**
- Create: `app/api/v3/radius/package/route.ts`, `app/api/v3/radius/package/[file]/route.ts`, `app/api/v3/radius/package/images/[file]/route.ts`, `app/api/v3/radius/changes/route.ts`, `app/api/v3/home-marinas/route.ts`
- Create: `lib/domain/delivery/radius/home-marinas.ts`
- Modify: `lib/security/route-policy.ts` (neue Routen, Scope `delivery:read`)
- Test: `app/__tests__/api-radius.test.ts` (in `DELIVERY_FIXTURE_TESTS`)

**Interfaces:**
- Consumes: Task 5 (`getRadiusPackage`, `readRadiusFile`, `radiusPackageByKey`), Task 6 (`radiusChangesSince`), `withApiClient`, `apiBody`, `apiError`, `apiNotFound` aus `lib/api`.
- Produces: `listHomeMarinas(db: Db, archive: Archive, bbox?: [number, number, number, number]): Promise<Array<{ id: string; name: string; position: LonLat; subdivision: string }>>` — Spots `kind === "marina"`, nicht ausgeschlossen, aus dem aktuellen gültigen `spots.json` jedes Landesteils; in-process Cache je `deliveries.id`.
- Routen (Muster wie `app/api/v3/subdivisions/[subdivision]/package/route.ts`, `await connection()`):
  - `GET /radius/package?marina=&days=` → Manifest + `links` (je Datei `/api/v3/radius/package/<file>?marina=…&days=…&key=<key>`), Header `Periplus-Schema-Version: 3.0`, `dataVersion: null`.
  - `GET /radius/package/{file}?marina=&days=&key=` → Bytes mit `sha256`-ETag; `key` fehlt oder passt nicht zu Marina/Tagen → 400 `invalid_key`; Datei nicht im Paket → 404.
  - `GET /radius/changes?marina=&days=&since=` → `{ schemaVersion, since, key, changes }`.
  - `GET /home-marinas?bbox=w,s,e,n` → Liste; ungültige bbox → 400.
  - Fehlercodes: `days` keine ganze Zahl 1–28 → 400 `invalid_days`; Marina unbekannt/nicht ausgeliefert → 404; `since` ungültig → 400 `invalid_since`.

- [ ] **Step 1: Failing tests** (Muster `app/__tests__/api-package.test.ts`): Manifest mit Links; Datei per Link abrufbar, Hash = Manifest-Eintrag; `days=0` → 400; `days=7.5` → 400; unbekannte Marina → 404; falscher `key` → 400; Änderungen leer bei aktuellem Schlüssel; Heimatmarinas enthalten die Fixture-Marina und keinen Ankerplatz; ohne API-Schlüssel → 401.
- [ ] **Step 2:** `npx vitest run app/__tests__/api-radius.test.ts` → FAIL.
- [ ] **Step 3:** Next-16-Doku zu Route Handlers lesen, dann Routen, `home-marinas.ts` und Policy-Einträge implementieren.
- [ ] **Step 4:** → PASS; `npm run build`.
- [ ] **Step 5: Commit** `feat(api): radius package, radius changes and home marinas under /api/v3 (spec 18)`

---

### Task 8: Admin-Vorschau und Doku

**Files:**
- Create: `app/(admin)/deliveries/radius/page.tsx`, `app/(admin)/deliveries/radius/actions.ts`, `app/(admin)/deliveries/radius/radius-map.tsx` (Client-Komponente auf Basis von `app/(admin)/_components/map-view.tsx`)
- Create: `lib/domain/delivery/radius/view.ts`
- Modify: `app/(admin)/deliveries/page.tsx` (Link „Umkreis-Paket“), `docs/runbook.md` (Abschnitt „Umkreis-Pakete“: API, Zwischenspeicher, Neubau der Landesteile nach `popularity`-Umstellung, Migration 0069), `docs/superpowers/specs/2026-10-18-periplus-08-liefervertrag-api-design.md` (Hinweis auf Vertrag 3.0 und `/api/v3` mit Verweis auf Teil-Spec 18)
- Test: `lib/domain/delivery/radius/__tests__/view.test.ts`, `app/(admin)/__tests__/radius-actions.test.ts`

**Interfaces:**
- Consumes: Task 5 (`getRadiusPackage`, `readRadiusFile`), Task 7 (`listHomeMarinas`).
- Produces:
  - `previewRadius(db: Db, archive: Archive, marina: string, days: number): Promise<{ row: RadiusPackageRow; manifest: Manifest; totalBytes: number } | "marina_not_found" | "invalid_days">` (ruft `getRadiusPackage` ohne `apiClientId`, `kind: "package"`)
  - `listRadiusPackages(db: Db, page: number): Promise<Array<{ key: string; marina: string; days: number; generatedAt: string; requests: number; coverage: CoverageEntry[] }>>`, nach `generated_at` absteigend
  - Server-Action `downloadRadiusZip(marina, days)` → ZIP aller Dateien mit `fflate` (bereits Abhängigkeit), hinter `requireAdmin`.
- UI (Deutsch): Auswahl Heimatmarina (aus `listHomeMarinas`), Feld „Tage“ (1–28), Knopf „Vorschau“; Karte mit Kreis und Landesteilen, gefärbt nach `delivered`/`missing` („geliefert“/„fehlt“); Zahlen je Datei; Gesamtgröße; Knopf „Als ZIP laden“; darunter Tabelle „Zwischengespeicherte Umkreis-Pakete“ (Marina, Tage, Schlüssel, Stand, Abrufe).

- [ ] **Step 1: Failing tests:** `previewRadius` gibt `totalBytes` = Summe der `file_hashes[].bytes`; `listRadiusPackages` zählt Abrufe aus `radius_package_requests`; Action ohne Admin-Sitzung wirft.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** Implementieren, Doku schreiben.
- [ ] **Step 4:** → PASS; `npm run build`; Seite im Dev-Server einmal öffnen (Skill `run`) und mit der Fixture-Marina eine Vorschau erzeugen.
- [ ] **Step 5: Commit** `feat(admin): radius package preview, cache list and runbook (spec 18)`

---

## Abschluss

- [ ] Gesamte Suite: `npx vitest run` → grün; `npx tsc --noEmit`; `npm run lint`; `npm run build`.
- [ ] Gesamtdesign Abschnitt 11, Zeile 18: „umgesetzt“ ergänzen.
