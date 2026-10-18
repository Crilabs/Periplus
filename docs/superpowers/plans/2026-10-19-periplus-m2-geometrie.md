# Periplus M2 – Geometrie und Ausschlüsse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stufe 3 für das Pilotgebiet: für jeden Ort Schutz je Sektor, Fetch, Schwell-Schutz, Öffnung, Tiefen, Grund, Ankerfläche und erste Ankerposition als berechnete Facts mit `computations`-Beleg; amtliche Ausschlussflächen aus EMODnet Human Activities mit Ausschluss `no_anchoring`; Geometrie-Reiter, Ebene „Ausschlussflächen“, Lauf-Aktionen und eine dokumentierte Stichprobe gegen den Vergleichssatz.

**Architecture:** Zwei Läufe auf der vorhandenen Run-Mechanik: „Datensätze laden“ (Stufe `datasets.import`, ein Job je Datensatz und Revier: Bathymetrie, Meeresboden, Ausschlussflächen) und „Geometrie“ (Stufe `geometry.place`, ein Job je Ort). Die Rechnungen sind kleine Funktionen in `lib/domain/geometry/` (reine TS-Mathematik für Schutz/Öffnung/Schwell, PostGIS-SQL für Strahlen, Wasserfläche, Raster, Flächen); `lib/pipeline/geometry.ts` setzt sie je Ort zusammen und schreibt über `recordComputation` je Art eine `computations`-Zeile mit Eingängen und die Facts dazu – nur, wenn sich die Eingänge gegenüber der letzten Zeile geändert haben. EMODnet läuft über die vorhandene HTTP-Transportschicht mit Fixtures; GeoTIFFs kommen per `ST_FromGDALRaster` direkt aus dem Job in PostGIS-Raster.

**Tech Stack:** wie M1 (Next.js 16.4.2, React 19.3, Drizzle 0.45, pg-boss 12, zod 4, Vitest 5, maplibre-gl 6), PostGIS 3 mit `postgis_raster` (GDAL-Treiber GTiff), keine neuen npm-Abhängigkeiten.

**Spec:** `docs/superpowers/specs/2026-10-18-periplus-04-geometrie-design.md` (primär), `…-02-datenmodell-design.md` (`computations`, `facts`, `restricted_areas`, Fact-Schema als Konfiguration), `…-09-admin-ui-design.md` (Ort-Reiter „Geometrie“, Kartenebene, Kachel-Aktion „Geometrie“), `…-10-qualitaet-pilot-design.md` (Vergleichssatz, Grundprinzip 9), `…-07-konsolidierung-design.md` (nur Regelnamen der Attribute), Gesamtdesign `…-periplus-design.md` (Roadmap M2). Fachlich maßgebend: `.idea/datendienst-spec.md` (Stufe 3, Grundprinzipien 3, 5, 9; Spot-Feld `shelter`).

## Global Constraints

- Alle Global Constraints aus M0 und M1 gelten weiter (Next 16.4.2, Next-Doku vor Routen/`proxy.ts`, `cacheComponents: true`, kein `console.*`, Englisch im Code, Deutsch in der UI, Tests gegen `db-test` und lokales S3, kein Netz in Tests, Route-Policy je Route, stabile Tabellen nie löschen, `external_calls` je Aufruf, User-Agent mit Kontakt).
- „Alle Rechnungen in einer lokalen metrischen Projektion (UTM-Zone des Reviers, z. B. EPSG:32634 für den Pilot), Ergebnis zurück in WGS84.“ Zone je Ort: `32600 + floor((lon + 180) / 6) + 1` (Nordhalbkugel).
- Fetch: „72 Strahlen im 5°-Abstand, Länge bis 50 km; Fetch = Distanz bis zum ersten Schnitt mit Land … Strahlen, die nicht schneiden, haben Fetch 50 km.“ Strahl 0 = Peilung 0° (N), im Uhrzeigersinn.
- Schutz je Strahl `clamp(1 − log10(fetch_m / f_min) / log10(f_max / f_min), 0, 1)`, `f_min = 300 m`, `f_max = 20 km`; Sektor (Mitte N=0°, NE=45° …, ±22,5°, 9 Strahlen) = `0,7 × Mittelwert + 0,3 × Minimum`.
- Schwell: Schutz des Sektors mit dem längsten Fetch über 30 km, gemindert, wenn die Öffnung (Strahlen mit Fetch > 10 km) breiter als 60° ist; Konfidenz 0,4.
- Öffnung zur See: Peilung (Mittelrichtung) und Winkelbreite der Strahlen mit Fetch > 2 km.
- Tiefe: Stichproben in 50, 100 und 200 m entlang der Öffnungsrichtung, Minimum/Maximum in der Wasserfläche; „Tiefen auf LAT, positiv in Metern“; Konfidenz HR-DTM 0,8, 115-m-Raster bei Buchtbreite ≥ 300 m 0,6, darunter 0,3.
- Wasserfläche: Buchtpolygon aus OSM, sonst Kreis 600 m um den Punkt, davon Land abgezogen. Ankerfläche: Tiefe 3–12 m, Mindestabstand 30 m zum Land. Ankerposition: `ST_MaximumInscribedCircle`, Konfidenz 0,3, Herkunft `computed`; leere Ankerfläche = kein Wert, Lücke. Admin-Korrektur = Review-Fact, Konfidenz 0,9.
- Ausschluss: Ankerfläche (oder Position) zu mehr als 50 % in einer Ausschlussfläche mit Ankerverbot → `status = no_anchoring`, `status_reason` aus `kind`; Orte bleiben erhalten. Kabel gepuffert 500 m. Natura-2000-Ankerverbote je Gebiets-ID in `config/restrictions.json`.
- Raster-Tabelle `bathymetry` mit Spalten `dataset` und `resolution_m`, Kacheln 256×256. Jeder Import archiviert die Rohdatei unter `datasets/<name>/<version>/…` und trägt die Datensatzversion in jede Ableitung.
- „Jede Rechnung schreibt genau eine `computations`-Zeile je Art und Ort … und je Attribut einen Fact. Identische Eingänge wie beim letzten Lauf = keine neuen Zeilen.“
- `facts`: genau eins von `mention_id` / `computation_id` / `observation_id` / `review_decision_id` (Check-Constraint); `computations` und `facts` sind nur anfügend (`forbid_mutation('')`).
- Schutz intern 0–1 je Sektor (1 = voll geschützt). Parameter in `config/geometry.json`, Version als `rules_version`; jede Änderung an Werten oder Rechenlogik erhöht `rulesVersion`.
- Navily: „Gespeichert wird nur das Ergebnis, nie ein Navily-Wert“ (Grundprinzip 9). Die Navily-Datei wird nur zur Laufzeit von einem übergebenen Pfad gelesen; weder Repo noch DB noch Bericht enthalten Navily-Namen, -IDs, -URLs oder -Werte.
- Tests mit Geometrie laufen in `withRollback`; synthetische Daten außerhalb der Pilotbox 23,0–23,75° O × 37,0–38,0° N (Synthetik um 21,0° O / 35,2° N, UTM 32634).

## Review Focus

1. **Ort-Position an Land oder genau auf der Küstenlinie** (Seed-Position am Ufer, schmale Bucht): alle Strahlen hätten Fetch 0 und der Ort wäre „voll geschützt“. Erwartet: Ausgangspunkt wird ≥ 20 m vom Land in die Wasserfläche verschoben, kein Strahl < 15 m. → Task 4 Test `origin on land is moved into water`.
2. **Zweiter Geometrie-Lauf**: ohne geänderte Eingänge keine neuen Zeilen; eine vom Admin gesetzte Ankerposition wird nie überschrieben und ist Ausgangspunkt der Strahlen; die berechnete Ankerposition wird nie zum Ausgangspunkt (sonst kippen die Eingänge bei jedem Lauf). → Task 11 Tests `second run …`, `review anchor …`, `computed anchor …`.
3. **Achsen- und Vorzeichenfehler der EMODnet-Dienste**: WFS-Box als lat/lon gelesen (Features aus falscher Region oder keine), DTM als Höhe mit negativem Wasser (negative Tiefen). Erwartet: Features liegen in der angefragten Box; ein Seepunkt hat positive Tiefe, ein Landpunkt keine. → Task 10 Tests `seabed features lie inside the requested box`, `a sea point has positive depth, a land point none`.
4. **Datenlücken** (Ort am Rasterrand, nodata, keine 3–12-m-Fläche, kein Meeresboden): begründete Lücke statt 0 m oder Absturz; die 8 Sektorwerte entstehen trotzdem. → Task 5/6/7 Tests zu `null`, Task 11 Test `place outside the raster gets gaps but 8 shelter facts`.
5. **Erneuter Import der Ausschlussflächen**: unverändert → keine History; geänderte Geometrie → Update derselben Zeile (ID bleibt, `status_reason` zeigt weiter darauf); verschwundenes Feature → `valid_to`; ein schon bestätigter Ort in einer neuen Verbotsfläche → `no_anchoring` und offene Aufgabe `dismissed`, ein verworfener Ort bleibt. → Task 8 Tests.

---

## File Structure

```
lib/db/schema/derived.ts                  computations, facts (+ computation_kind)
lib/db/schema/geo.ts                      + bathymetry (raster), seabed_polygons (+ seabed_type)
lib/db/geometry.ts                        + raster-Spaltentyp
drizzle/00NN_*.sql                        generiert + handgeschrieben (Trigger, Checks, Raster-GIST)
docker/postgres/Dockerfile                GDAL-Treiber GTiff aktiv
config/fact-schema/{v1.ts,active.json}    Fact-Schema v1 (nur M2-Attribute)
config/geometry.json                      Rechenparameter, rulesVersion
config/restrictions.json                  Natura-2000-Gebiete mit Ankerverbot
config/datasets.json                      EMODnet-Endpunkte, Layer, Substrat-Zuordnung
config/gazetteer.json                     landBufferKm 55, noAnchoringKinds + aquaculture
lib/config/{schemas,index}.ts             + geometry, restrictions, datasets, factSchema
lib/domain/facts/
  schema-types.ts                         SECTORS, AttributeDef, FactSchema
  schema.ts                               getFactSchema, validateFactValue
  computations.ts                         recordComputation, latestComputations
lib/domain/geometry/
  projection.ts                           utmSridFor
  shelter.ts                              rayShelter, shelterFromFetch, opening, swellProtection
  water.ts                                waterArea, resolveOrigin
  rays.ts                                 computeFetch
  bathymetry.ts                           importBathymetryRaster
  depth.ts                                sampleDepths, depthRange, depthConfidence
  anchor-area.ts                          anchorArea
  seabed.ts                               classifySeabed, replaceSeabed, seabedShares
  restrictions.ts                         upsertRestrictedAreas, restrictionHits, exclusionFor, applyExclusion
  anchor-correction.ts                    setAnchorPosition
  check.ts                                checkGeometry
lib/domain/geometry-view.ts               placeGeometry (UI)
lib/domain/quality/navily-sample.ts       Stichprobe (nur Ergebnisse)
lib/adapters/emodnet.ts                   WCS-Coverage, WFS-Paging
lib/pipeline/datasets.ts                  importBathymetry, importSeabed, importRestrictions, Stufe
lib/pipeline/geometry.ts                  computePlaceGeometry, Stufe, startGeometryRun
lib/jobs/handlers/{datasets,geometry}.ts
lib/domain/seed.ts                        nutzt restrictionHits/exclusionFor
lib/domain/map-data.ts                    + Ebene restricted-areas
app/(admin)/places/[id]/{page.tsx,geometry-tab.tsx,actions.ts}
app/(admin)/_components/{wind-rose.tsx,wind-rose-math.ts,labels.ts,map-view.tsx}
app/(admin)/runs/{page.tsx,actions.ts}, app/(admin)/tiles/[id]/{page.tsx,actions.ts}
scripts/{compare-navily.ts,check-geometry.ts,fixtures-record.ts}
test/geometry/{synthetic.ts,raster.ts}    Testhelfer synthetische Küsten, 10×10-Raster
test/fixtures/http/emodnet-*/**, test/fixtures/geometry/{golden-places.json,golden.json}
test/fixtures/navily/sample.json          synthetisch, keine echten Navily-Daten
docs/runbook.md, docs/pilot/m2-abnahme.md
```

---

### Task 1: Tabellen `computations` und `facts`

**Files:**
- Create: `lib/db/schema/derived.ts`, Migration (generiert) + handgeschrieben `drizzle/00NN_derived_triggers.sql`
- Modify: `lib/db/schema/index.ts`
- Test: `lib/db/__tests__/derived-schema.test.ts`

**Interfaces:**
- Consumes: `geoObjects` (geo.ts), `reviewDecisions` (review.ts), `runs` (ops.ts), `forbid_mutation()` (0002).
- Produces:
  - Enum `computation_kind` (`shelter, fetch, depth, seabed, anchor_area, quietness, restriction`), Typ `ComputationKind`.
  - `computations`: `id` (UUIDv7), `geo_object_id uuid not null → geo_objects`, `kind`, `inputs jsonb not null`, `inputs_hash text not null`, `outputs jsonb not null default '{}'` (Zwischenergebnisse ohne eigenen Fact: Strahlen, Flächen, Lücken), `rules_version text not null`, `run_id uuid → runs` (nullable), `created_at`. Index `(geo_object_id, kind, created_at desc)`.
  - `facts`: `id`, `geo_object_id → geo_objects not null`, `attribute text not null`, `value jsonb not null`, `mention_id uuid`, `computation_id uuid → computations`, `observation_id uuid`, `review_decision_id uuid → review_decisions`, `quote text`, `quote_verified bool not null default false`, `observed_at date not null`, `confidence real not null` (Check 0–1), `extraction_run_id uuid`, `fact_schema_version text not null`, `created_at`. `mention_id`, `observation_id`, `extraction_run_id` ohne FK (Tabellen kommen in M4/M8; Kommentar im Schema). Checks `facts_one_basis`: `num_nonnulls(mention_id, computation_id, observation_id, review_decision_id) = 1`; `facts_quote_for_mention`: `mention_id is null or quote is not null`. Unique `(mention_id, attribute, extraction_run_id)` (Spec 02), partiell unique `(computation_id, attribute) where computation_id is not null` und `(review_decision_id, attribute) where review_decision_id is not null`. B-Tree `(geo_object_id, attribute, observed_at)`.
  - Trigger `computations_append_only`, `facts_append_only`: `forbid_mutation('')`.

- [ ] **Step 1: Failing tests**

```ts
it.each(["computations", "facts"])("%s rejects UPDATE and DELETE", …); // message /<table> is append-only/
it("a fact needs exactly one basis", async () => {
  // insert with no basis → violates facts_one_basis; with computation_id + review_decision_id → violates
});
it("a fact from a mention needs a quote", …);        // mention_id set, quote null → facts_quote_for_mention
it("(computation_id, attribute) is unique", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/db/__tests__/derived-schema.test.ts` → FAIL (Tabellen fehlen).
- [ ] **Step 3: Implementieren.** `npm run db:generate`, Checks und Trigger in der handgeschriebenen Migration mit `--> statement-breakpoint`, Journal-Eintrag wie `0006_geo_triggers.sql`.
- [ ] **Step 4: Run** `npx vitest run lib/db` → PASS.
- [ ] **Step 5: Commit** `feat(db): computations and facts, append-only with one basis per fact`

### Task 2: Fact-Schema v1 und `recordComputation`

**Files:**
- Create: `lib/domain/facts/schema-types.ts`, `config/fact-schema/v1.ts`, `config/fact-schema/active.json`, `lib/domain/facts/schema.ts`, `lib/domain/facts/computations.ts`
- Modify: `lib/config/schemas.ts`, `lib/config/index.ts`
- Test: `lib/domain/facts/__tests__/schema.test.ts`, `lib/domain/facts/__tests__/computations.test.ts`

**Interfaces:**
- Consumes: `computations`, `facts`, `ComputationKind` (Task 1).
- Produces:
  - In `schema-types.ts`: `SECTORS = ["N","NE","E","SE","S","SW","W","NW"] as const`, `type Sector`, `SECTOR_CENTER_DEG: Record<Sector, number>` (0, 45, …, 315), `type FactOrigin = "computed" | "text" | "observed"`, `type FactLevel = "place" | "area" | "island" | "cape_strait" | "poi"`, `type AttributeDef = { key: string; value: z.ZodType; rule: string; origins: FactOrigin[]; description: string }`, `type FactSchema = { version: string; levels: Record<FactLevel, AttributeDef[]> }`.
  - `factSchemaV1: FactSchema` in `config/fact-schema/v1.ts` (nur `place` befüllt, übrige Ebenen `[]`), `active.json` = `{ "version": "v1" }`; `AppConfig.factSchema: { version: string }`.
  - `getFactSchema(version?: string): FactSchema` (Default aktive Version; unbekannt → Error), `attributeDef(key: string, version?: string): AttributeDef`, `validateFactValue(key: string, value: unknown, version?: string): unknown`, Klassen `UnknownAttribute`, `InvalidFactValue` (Nachricht mit Schlüssel und zod-Issues).
  - `canonicalJson(v: unknown): string` (Schlüssel sortiert, rekursiv, ohne Leerraum).
  - `type ComputedFact = { attribute: string; value: unknown; confidence: number }`
  - `recordComputation(db, input: { geoObjectId: string; kind: ComputationKind; inputs: Record<string, unknown>; outputs?: Record<string, unknown>; rulesVersion: string; facts: ComputedFact[]; observedAt: string; runId?: string }): Promise<{ id: string; created: boolean }>` – in einer Transaktion: `pg_advisory_xact_lock(hashtext(geoObjectId || ':' || kind))`; `inputs_hash = sha256(canonicalJson({ kind, rulesVersion, inputs }))` (Ausgaben zählen nicht); gleich dem Hash der jüngsten Zeile `(geo_object_id, kind)` → `{ id: <jüngste>, created: false }`, nichts geschrieben; sonst jeden Fact validieren (Fehler → nichts geschrieben), Zeile und Facts (`computation_id`, `fact_schema_version` = aktive Version) einfügen.
  - `type StoredComputation = { id: string; kind: ComputationKind; inputs: Record<string, unknown>; outputs: Record<string, unknown>; rulesVersion: string; createdAt: Date; facts: Array<{ id: string; attribute: string; value: unknown; confidence: number; observedAt: string }> }`, `latestComputations(db, geoObjectId: string): Promise<Map<ComputationKind, StoredComputation>>`.

Attribute v1 (`place`), Werte als zod:

| Schlüssel | Wert | `rule` | `origins` |
| --- | --- | --- | --- |
| `shelter.<Sektor>` (8) | Zahl 0–1 | `shelter` | computed, text |
| `swell_protection` | Zahl 0–1 | `swell_protection` | computed, text |
| `opening_bearing` | `{ bearingDeg: number ∈ [0, 360) \| null; widthDeg: number ∈ [0, 360] }` | `computed_only` | computed |
| `fetch.<Sektor>` (8) | Ganzzahl 0–50000 (m, Mittel der 9 Strahlen) | `computed_only` | computed |
| `depth.min`, `depth.max`, `depth.anchoring_min`, `depth.anchoring_max` | Zahl ≥ 0 (m, LAT) | `bathymetry` | computed, text |
| `depth.approach` | `{ at50m, at100m, at200m: number ≥ 0 \| null }` | `bathymetry` | computed, text |
| `seabed` | `Array<{ type: sand\|mud\|gravel\|rock\|mixed\|weed; share: 0–1 }>`, ≥ 1 Eintrag, Summe 1 ± 0,01 | `bathymetry` | computed, text |
| `anchor_area` | `{ areaM2: number ≥ 0 }` | `computed_only` | computed |
| `anchor_position` | `{ lon: −180–180; lat: −90–90 }` | `review_over_computed` | computed, observed |
| `restriction` | `Array<{ kind: RestrictedKind; restrictedAreaId: uuid; sourceRef: string \| null; share: 0–1; anchoringBan: boolean }>` | `prohibitions` | computed |

- [ ] **Step 1: Failing tests**

```ts
it("v1 place attributes are exactly the M2 keys", () => {
  expect(getFactSchema("v1").levels.place.map((a) => a.key).sort()).toEqual([...EXPECTED_M2_KEYS].sort()); // 27 keys
});
it("validates values", () => {
  expect(validateFactValue("shelter.N", 0.4)).toBe(0.4);
  expect(() => validateFactValue("shelter.N", 1.2)).toThrow(InvalidFactValue);
  expect(() => validateFactValue("seabed", [{ type: "sand", share: 0.8 }])).toThrow(InvalidFactValue);
  expect(validateFactValue("opening_bearing", { bearingDeg: null, widthDeg: 50 })).toBeTruthy();
  expect(() => validateFactValue("shelter.X", 0.5)).toThrow(UnknownAttribute);
});
// computations.test.ts (withRollback, synthetic geo object outside the pilot box)
it("first call writes the computation and its facts with fact_schema_version v1", …);
it("same inputs with reordered keys → created false, no new rows", …);
it("changed inputs or rulesVersion → new row; A → B → A yields three rows", …);
it("outputs are not part of the hash", …);
it("an invalid fact value writes nothing", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/facts` → FAIL.
- [ ] **Step 3: Implementieren.** `config/fact-schema/v1.ts` importiert nur Typen aus `schema-types.ts` (kein Zyklus mit `schema.ts`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(facts): fact schema v1 for computed attributes, recordComputation`

### Task 3: Geometrie-Konfiguration und Schutz-Mathematik

**Files:**
- Create: `config/geometry.json`, `config/restrictions.json`, `lib/domain/geometry/projection.ts`, `lib/domain/geometry/shelter.ts`
- Modify: `lib/config/schemas.ts`, `lib/config/index.ts`, `config/gazetteer.json` (`landBufferKm` 10 → 55, `noAnchoringKinds` + `"aquaculture"`), `app/(admin)/settings/page.tsx`
- Test: `lib/domain/geometry/__tests__/shelter.test.ts`, `lib/domain/geometry/__tests__/projection.test.ts`, `lib/config/__tests__/config.test.ts`

**Interfaces:**
- Produces:
  - `GeometryConfig` (`geometrySchema`, strict) mit diesen Werten in `config/geometry.json`:
    `rulesVersion "geometry-1"`; `fetch { rayCount 72, rayStepDeg 5, maxRayM 50000, confidence 0.7 }`; `shelter { fMinM 300, fMaxM 20000, meanWeight 0.7, minWeight 0.3, confidence 0.6 }`; `opening { openFetchM 2000, minResultant 0.25, confidence 0.6 }`; `swell { longFetchM 30000, openFetchM 10000, maxOpeningDeg 60, wideOpeningFactor 0.5, noSourceValue 0.9, confidence 0.4 }`; `water { bayRadiusM 600, harbourRadiusM 250, maxPolygonAreaM2 4000000, originCoastOffsetM 20 }`; `depth { sampleDistancesM [50, 100, 200], hrResolutionM 30, confidenceHr 0.8, confidenceCoarseWide 0.6, confidenceCoarseNarrow 0.3, minBayWidthM 300 }`; `anchorArea { minDepthM 3, maxDepthM 12, landClearanceM 30, positionConfidence 0.3, correctionConfidence 0.9, correctionMaxDistanceM 2000 }`; `seabed { minCoverage 0.5, confidence 0.5 }`; `restriction { minShare 0.5, confidence 0.9 }`.
  - `RestrictionsConfig`: `{ protectedAreaAnchoringBan: string[] }` (Natura-2000-Codes, Regex `^[A-Z]{2}[0-9A-Z]{7}$`), Datei startet mit `[]`. `AppConfig` erhält `geometry`, `restrictions`.
  - `utmSridFor(lon: number, lat: number): number`
  - `rayShelter(fetchM: number, cfg: GeometryConfig["shelter"]): number`
  - `sectorRayIndices(sector: Sector, cfg: GeometryConfig["fetch"]): number[]` – 9 Indizes, N = `[68..71, 0..4]`
  - `shelterFromFetch(rays: number[], cfg: GeometryConfig): Record<Sector, number>` (auf 3 Stellen gerundet)
  - `sectorFetch(rays: number[], cfg: GeometryConfig): Record<Sector, number>` (Mittel der 9 Strahlen, ganze Meter)
  - `opening(rays: number[], cfg: GeometryConfig): { bearingDeg: number | null; widthDeg: number }` – offene Strahlen = Fetch > `openFetchM`; `widthDeg` = Anzahl × `rayStepDeg`; `bearingDeg` = Vektormittel der offenen Peilungen (gerundet auf 1°), `null`, wenn keine offen oder normierte Resultante < `minResultant`.
  - `swellProtection(rays: number[], sectors: Record<Sector, number>, cfg: GeometryConfig): number` – Sektor-Fetch hier = längster Strahl des Sektors; ist das Maximum ≤ `longFetchM` → `noSourceValue`; sonst kleinster Schutz unter den Sektoren mit diesem Maximum, × `wideOpeningFactor`, wenn die Strahlen mit Fetch > `swell.openFetchM` zusammen breiter als `maxOpeningDeg` sind.
  - `/settings` zeigt `rulesVersion`, Fact-Schema-Version und die Schutz-Parameter.

- [ ] **Step 1: Failing tests**

```ts
expect(utmSridFor(23.4, 37.7)).toBe(32634);
expect(utmSridFor(17.99, 40)).toBe(32633);
expect(utmSridFor(18.0, 40)).toBe(32634);
expect(rayShelter(300, cfg.shelter)).toBe(1);
expect(rayShelter(100, cfg.shelter)).toBe(1);
expect(rayShelter(20000, cfg.shelter)).toBe(0);
expect(rayShelter(500, cfg.shelter)).toBeCloseTo(0.8784, 3);
it("one open sector: S rays (indices 32..40) 50 km, all others 400 m", () => {
  // sectors: S 0, all other 7 sectors 0.9315 (±0.001); opening { bearingDeg 180, widthDeg 45 }; swell 0
});
it("all rays 50 km → every sector 0, opening { null, 360 }, swell 0", …);
it("no ray above 30 km → swell 0.9", …);
it("two opposite open rays (0° and 180°) → opening bearing null, width 10", …);
it("sectorFetch is the rounded mean of the sector's 9 rays", …);
it("config rejects a malformed Natura 2000 code", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/geometry lib/config` → FAIL.
- [ ] **Step 3: Implementieren.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(geometry): config and shelter, opening and swell math`

### Task 4: Wasserfläche, Ausgangspunkt und Fetch-Strahlen (synthetische Küsten)

**Files:**
- Create: `lib/domain/geometry/water.ts`, `lib/domain/geometry/rays.ts`, `test/geometry/synthetic.ts`
- Test: `lib/domain/geometry/__tests__/rays.test.ts`, `lib/domain/geometry/__tests__/water.test.ts`

**Interfaces:**
- Consumes: `land_polygons`, `utmSridFor`, `shelterFromFetch`, `opening`, `swellProtection` (Task 3).
- Produces:
  - `type LonLat = { lon: number; lat: number }` (in `water.ts` exportiert)
  - `type WaterArea = { geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null; key: string; widthM: number; source: "polygon" | "circle" }` – `key` = md5 von `ST_AsBinary(ST_SnapToGrid(geom, 1e-7))` (`"empty"` bei leer), `widthM` = Durchmesser des größten Inkreises (0 bei leer).
  - `waterArea(db, input: { geom: GeoJSON.Geometry; center: LonLat; isHarbour: boolean }, cfg: GeometryConfig["water"]): Promise<WaterArea>` – Polygon mit Fläche ≤ `maxPolygonAreaM2` → Polygon minus Land; größeres Polygon → Kreis `bayRadiusM` ∩ Polygon minus Land; Punkt → Kreis (`harbourRadiusM` bei Hafen, sonst `bayRadiusM`) minus Land. Kreis über `ST_Buffer(::geography)`.
  - `resolveOrigin(db, input: { position: LonLat; anchor: { position: LonLat; origin: string | null } | null; water: WaterArea }, cfg: GeometryConfig["water"]): Promise<{ origin: LonLat; source: "position" | "review_anchor" | "moved_off_land" } | null>` – Ausgang = Review-Anker (`anchor.origin === "review"`), sonst `position`; liegt er in Land → nächster Punkt der um `originCoastOffsetM` geschrumpften Wasserfläche (leer → `ST_PointOnSurface(water)`), Quelle `moved_off_land`; Wasserfläche leer → `null`.
  - `computeFetch(db, origin: LonLat, cfg: GeometryConfig): Promise<{ rays: number[]; srid: number; landVersions: string[] }>` – eine SQL-Abfrage: 72 Strahlen in `utmSridFor`, Länge `maxRayM`, je Strahl kleinste Distanz zur Schnittmenge mit den Landpolygonen (transformiert, Vorfilter `ST_DWithin`), sonst `maxRayM`; ganze Meter. `landVersions` = sortierte `dataset_version` der Landpolygone im Umkreis `maxRayM`.
  - Testhelfer `test/geometry/synthetic.ts`: `utm(x: number, y: number): string` (WKT-Punkt relativ zu E 500000 / N 3900000, EPSG:32634), `insertLand(tx, wktUtm: string[], version = "synthetic-1"): Promise<void>` (transformiert nach 4326), `lonLatOf(tx, x, y): Promise<LonLat>`.

Synthetische Küsten (Koordinaten in Metern relativ zum Bezugspunkt, Kreise per `ST_Buffer(…, r, 'quad_segs=64')`); erwartete Werte analytisch berechnet, Toleranz ± 0,02:

| Szene | Land | Ausgang | Sektoren N, NE, E, SE, S, SW, W, NW | Öffnung | Schwell |
| --- | --- | --- | --- | --- | --- |
| Halbkreis-Bucht nach Süden offen | Rechteck x −20000…20000, y 0…20000 minus Kreis r 500 um (0,0) | (0, 100) | 0,930 · 0,913 · 0,483 · 0 · 0 · 0 · 0,483 · 0,913 | 180°, 155° | 0 |
| Kanal | x −20000…−400 und 400…20000, y −30000…30000 | (0, 0) | 0,335 · 0,803 · 0,923 · 0,803 · 0,335 · 0,803 · 0,923 · 0,803 | null, 50° | 0,335 |
| Insel im Meer | Kreis r 2000 um (0, 2200) | (0, 0) | 1,0 · 0,898 · 0 · 0 · 0 · 0 · 0 · 0,898 | 180°, 225° | 0 |

- [ ] **Step 1: Failing tests**

```ts
it("half-circle bay open to the south", async () => withRollback(async (tx) => {
  // rays[0] 400±2, rays[18] 490±2, rays[20] 508±3, rays[21] 50000, rays[36] 50000; sectors/opening/swell per table
}));
it("channel", …);            // rays[0] 50000, rays[1] 4589±10, rays[18] 400±2; table values
it("island in the sea", …);  // rays[0] 200±2, rays[13] 773±5, rays[14] 50000; table values
it("landVersions lists the dataset versions within reach", …); // ["synthetic-1"]
it("origin on land is moved into water", async () => {
  // bay scene, position (0, 1000) → source "moved_off_land", origin ≥ 19 m from land, min(rays) ≥ 15
});
it("a review anchor is the origin, a computed anchor is not", …);
// water.test.ts
it("point bay → 600 m circle minus land; harbour point → 250 m circle (area π·250² ±2 %)", …);
it("bay polygon minus land; polygon over 4 km² is cut to the 600 m circle", …);
it("water entirely on land → geometry null, key 'empty', resolveOrigin null", …);
```

- [ ] **Step 2: Run** `npx vitest run lib/domain/geometry` → FAIL.
- [ ] **Step 3: Implementieren.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(geometry): water area, origin and fetch rays with synthetic coasts`

### Task 5: Bathymetrie-Raster und Tiefen

**Files:**
- Create: `lib/domain/geometry/bathymetry.ts`, `lib/domain/geometry/depth.ts`, `test/geometry/raster.ts`, Migration (generiert) + handgeschrieben (GIST)
- Modify: `docker/postgres/Dockerfile` (`ENV POSTGIS_GDAL_ENABLED_DRIVERS=GTiff`), `lib/db/geometry.ts`, `lib/db/schema/geo.ts`
- Test: `lib/domain/geometry/__tests__/bathymetry.test.ts`, `lib/domain/geometry/__tests__/depth.test.ts`

**Interfaces:**
- Produces:
  - `raster(name: string)` – Drizzle-`customType`, SQL-Typ `raster`.
  - `bathymetry` (Arbeitszustand, Datensatz): `id`, `dataset text not null`, `dataset_version text not null`, `resolution_m real not null`, `tile_id text not null` (Periplus-Kachel des Abrufs, ohne FK), `rast raster not null`, `created_at`; GIST auf `ST_ConvexHull(rast)`. **Gespeichert wird Tiefe unter LAT in Metern, positiv im Wasser**; Werte ≤ 0 sind Land/trocken.
  - `importBathymetryRaster(db, input: { bytes: Uint8Array; dataset: string; datasetVersion: string; resolutionM: number; tileId: string; valueIsElevation: boolean }): Promise<{ rasterTiles: number }>` – Transaktion: Zeilen `(dataset, tile_id)` löschen, `ST_Tile(ST_FromGDALRaster(bytes), 256, 256)` einfügen; bei `valueIsElevation` vorher Vorzeichen per `ST_MapAlgebra` umkehren (nodata bleibt nodata).
  - `sampleDepths(db, origin: LonLat, bearingDeg: number, distancesM: number[]): Promise<Array<number | null>>` – Punkte per `ST_Project(::geography)`, Wert aus dem feinsten Raster (`resolution_m` aufsteigend), der den Punkt deckt; nodata, ≤ 0 oder keine Deckung → `null`; 0,1 m gerundet.
  - `depthRange(db, area: GeoJSON.Geometry): Promise<{ min: number; max: number; resolutionM: number; datasets: Array<{ dataset: string; version: string; resolutionM: number }> } | null>` – nur Pixelwerte > 0 innerhalb `area` (`ST_Clip`); keine → `null`.
  - `depthConfidence(resolutionM: number, bayWidthM: number, cfg: GeometryConfig["depth"]): number`
  - Testhelfer `insertTestRaster(tx, opts?: { asElevationGtiff?: boolean; landPixel?: [row, col] }): Promise<Uint8Array | void>` – 10×10, links oben (21,000; 35,210), Pixel 0,001°, SRID 4326, Band `32BF`, nodata −9999, Zeile r hat Tiefe `2·(r+1)` m (2 … 20); mit `asElevationGtiff` liefert er stattdessen GTiff-Bytes mit Höhenwerten `−2·(r+1)` (über `ST_AsGDALRaster`).

- [ ] **Step 1: Failing tests**

```ts
it("GTiff round trip works (GDAL driver enabled)", …); // ST_FromGDALRaster(ST_AsGDALRaster(r,'GTiff')) width 10
it("importBathymetryRaster flips elevation to positive depth and replaces per tile", async () => {
  // GTiff bytes with -2(r+1) → value at row 2 = 6; second import → same row count
});
it("samples 50/100/200 m south of the origin", async () => {
  expect(await sampleDepths(tx, { lon: 21.0045, lat: 35.2077 }, 180, [50, 100, 200])).toEqual([6, 8, 10]);
});
it("outside the raster and on a land pixel the sample is null", …); // landPixel value -5
it("depthRange over rows 1..5 → min 4, max 12; outside → null", …);
it("depthConfidence", () => {
  expect(depthConfidence(115, 350, cfg.depth)).toBe(0.6);
  expect(depthConfidence(115, 200, cfg.depth)).toBe(0.3);
  expect(depthConfidence(20, 100, cfg.depth)).toBe(0.8);
});
```

- [ ] **Step 2: Run** `npm run services:up && npx vitest run lib/domain/geometry` → FAIL (Image neu gebaut, Tabelle fehlt).
- [ ] **Step 3: Implementieren.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(geometry): bathymetry raster import and depth sampling`

### Task 6: Ankerfläche und erste Ankerposition

**Files:**
- Create: `lib/domain/geometry/anchor-area.ts`
- Test: `lib/domain/geometry/__tests__/anchor-area.test.ts`

**Interfaces:**
- Consumes: `bathymetry`, `land_polygons`, `insertTestRaster` (Task 5), `utmSridFor`.
- Produces: `anchorArea(db, water: GeoJSON.Geometry, cfg: GeometryConfig["anchorArea"]): Promise<{ geometry: GeoJSON.MultiPolygon | null; areaM2: number; position: LonLat | null; key: string }>` – Rasterpixel mit `minDepthM ≤ Tiefe ≤ maxDepthM` als Polygone (`ST_DumpAsPolygons` auf `ST_Clip`), vereinigt, ∩ Wasser, minus `ST_Buffer(Land::geography, landClearanceM)`, nur Flächenanteile; Fläche über `::geography`; Position = Mittelpunkt von `ST_MaximumInscribedCircle` in UTM, zurück nach WGS84; leer → `null`, `0`, `null`, `key "empty"`; `key` wie `WaterArea.key`.

- [ ] **Step 1: Failing tests** (Raster aus Task 5, Wasser = Rasterausdehnung)

```ts
it("band 3–12 m without land: ≈ 504,600 m² ±2 %, position on the band's centre line", async () => {
  // position.lat within 30 m of 35.2065, ST_Within(position, geometry), ST_IsValid(geometry)
});
it("a land strip lon 21.000–21.001 with 30 m clearance → ≈ 437,500 m² ±2 %", …);
it("water only over the 2 m row → null geometry, 0 m², no position", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(geometry): anchor area and first anchor position`

### Task 7: Meeresboden

**Files:**
- Create: `lib/domain/geometry/seabed.ts`, Migration (generiert)
- Modify: `lib/db/schema/geo.ts`
- Test: `lib/domain/geometry/__tests__/seabed.test.ts`

**Interfaces:**
- Produces:
  - Enum `seabed_type` (`sand, mud, gravel, rock, mixed, weed`), Typ `SeabedType`.
  - `seabed_polygons` (Arbeitszustand): `id`, `substrate seabed_type not null`, `habitat text`, `source_ref text`, `area_key text not null`, `dataset_version text not null`, `geom geometry(Polygon) not null`, `created_at`; GIST.
  - `type SeabedFeature = { substrate: SeabedType; habitat: string | null; sourceRef: string; geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon }`
  - `classifySeabed(props: Record<string, unknown>, cfg: DatasetsConfig["seabed"]): SeabedType | null` – `weed`, wenn ein Feld aus `habitatFields` eines der `weedPatterns` enthält (ohne Groß-/Kleinschreibung); sonst `substrateMap[props[substrateField]]`; sonst `null`. (`DatasetsConfig` kommt in Task 9; bis dahin definiert dieser Task den Teil `seabed` des Schemas in `lib/config/schemas.ts` und Task 9 ergänzt den Rest.)
  - `replaceSeabed(db, input: { areaKey: string; datasetVersion: string; box: Bbox; features: SeabedFeature[] }): Promise<{ inserted: number }>` – Transaktion: Zeilen des `area_key` löschen, Features `ST_MakeValid`, auf `box` geschnitten, in Polygone zerlegt einfügen.
  - `seabedShares(db, area: GeoJSON.Geometry): Promise<{ shares: Array<{ type: SeabedType; share: number }>; coverage: number; versions: string[] }>` – je Typ Fläche von `ST_Union` ∩ `area` (Überlappungen zählen einmal), Anteil an der gedeckten Fläche auf 0,01 gerundet, Nullen weg, größter Anteil gleicht die Summe auf 1 aus, absteigend; `coverage` = gedeckt / Fläche.

- [ ] **Step 1: Failing tests**

```ts
it.each([
  [{ substrate: "Sand" }, "sand"], [{ substrate: "Rock or other hard substrata" }, "rock"],
  [{ substrate: "Sand", habitat: "Posidonia oceanica meadows" }, "weed"], [{ substrate: "Unknown" }, null],
])("classifySeabed %o → %s", …);
it("1 km² split 70/30 sand/rock → [{sand,0.7},{rock,0.3}], coverage 1", …);
it("the same polygon imported for two areas is not counted twice", …);
it("only 40 % covered → coverage 0.4", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(geometry): seabed polygons and substrate shares`

### Task 8: Ausschlussflächen – Import-Regeln und Ausschluss

**Files:**
- Create: `lib/domain/geometry/restrictions.ts`
- Modify: `lib/domain/seed.ts` (privates `restrictionAt` ersetzen)
- Test: `lib/domain/geometry/__tests__/restrictions.test.ts`, `lib/domain/__tests__/seed.test.ts` (ein Fall ergänzt)

**Interfaces:**
- Consumes: `restricted_areas` (stabil, History auf `kind, geom, valid_to`), `createReviewTask`-Tabelle `review_tasks`, `GazetteerConfig.noAnchoringKinds`, `RestrictionsConfig`.
- Produces:
  - `type RestrictedFeature = { kind: RestrictedKind; sourceRef: string; geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon }`
  - `upsertRestrictedAreas(db, input: { layerPrefix: string; box: Bbox; features: RestrictedFeature[]; today?: string }): Promise<{ inserted: number; updated: number; unchanged: number; ended: number }>` – Abgleich über `source_ref` unter gültigen Zeilen: gleiche Geometrie (Vergleich auf `ST_SnapToGrid(…, 1e-7)`) → unverändert; andere → `UPDATE geom` derselben Zeile; keine gültige Zeile → neu. Gültige Zeilen mit `source_ref like layerPrefix || '%'`, die `box` schneiden und im Import fehlen → `valid_to = today`.
  - `type RestrictionHit = { restrictedAreaId: string; kind: RestrictedKind; sourceRef: string | null; share: number; anchoringBan: boolean }`
  - `isAnchoringBan(kind: RestrictedKind, sourceRef: string | null, cfg: { noAnchoringKinds: RestrictedKind[]; protectedAreaAnchoringBan: string[] }): boolean` – `kind ∈ noAnchoringKinds`, oder `protected_area` mit Gebietscode (Teil nach dem letzten `/` von `sourceRef`) in der Liste.
  - `restrictionHits(db, target: { area: GeoJSON.Geometry | null; position: LonLat }, cfg): Promise<RestrictionHit[]>` – alle gültigen Flächen, die `area` (sonst `position`) schneiden; `share` = Schnittfläche/Fläche über `::geography`, bei `area = null` 1; sortiert nach `share` absteigend, dann `kind`, `id`.
  - `exclusionFor(hits: RestrictionHit[], minShare: number): RestrictionHit | null` – erster Treffer mit `anchoringBan` und `share > minShare`.
  - `applyExclusion(db, placeId: string, hit: RestrictionHit): Promise<boolean>` – nur `candidate`/`confirmed`: `status no_anchoring`, `status_reason "restricted:<kind>:<id>"`, offene `place_candidate`-Aufgabe mit `subject_id = placeId` → `dismissed`; sonst `false`.
  - `seedTile(db, tileId, cfg: GazetteerConfig, restrictions: RestrictionsConfig = getConfig().restrictions)` – neue Orte über `exclusionFor(restrictionHits(tx, { area: null, position }, …), geometry.restriction.minShare)`; sonst unverändert.

- [ ] **Step 1: Failing tests**

```ts
it("re-import: unchanged rows write no history, a changed geometry updates the same row, a missing one ends", async () => {
  // import 3 → inserted 3; same → unchanged 3, 0 history rows; one changed → updated 1, same id, 1 history row;
  // one missing → ended 1 with valid_to = today; a feature outside the box stays valid; reappearing → inserted 1
});
it("anchor area 60 % in a military area → exclusion; 40 % → hit listed with share 0.4, no exclusion", …);
it("protected area: banned only if its site code is configured", …);
it("without anchor area the position decides (share 1)", …);
it("applyExclusion: candidate → no_anchoring and its open task dismissed; confirmed keeps public_id; rejected untouched", …);
// seed.test.ts
it("a new place inside a configured protected area becomes no_anchoring", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run lib/domain` → PASS (bestehende Seed-Tests grün).
- [ ] **Step 5: Commit** `feat(geometry): restricted area upsert and anchoring exclusion rule`

### Task 9: EMODnet-Adapter

**Files:**
- Create: `lib/adapters/emodnet.ts`, `config/datasets.json`
- Modify: `lib/config/schemas.ts`, `lib/config/index.ts`
- Test: `lib/adapters/__tests__/emodnet.test.ts`

**Interfaces:**
- Consumes: `httpCall`, `Transport`, `CallContext`, `HttpError`, `RetryableHttpError` (M1 Task 9).
- Produces:
  - `DatasetsConfig` (`datasetsSchema`), `AppConfig.datasets`:
    - `bathymetry { wcsUrl "https://ows.emodnet-bathymetry.eu/wcs", coverageId "emodnet:mean", dataset "emodnet-dtm", datasetVersion "2024", resolutionM 115, valueIsElevation true, timeoutSeconds 120, ratePerMinute 20 }`
    - `seabed { wfsUrl "https://ows.emodnet-seabedhabitats.eu/geoserver/emodnet_open/wfs", typeName "emodnet_open:eusm2023_subs_full", substrateField "substrate", habitatFields ["habitat", "eunis2019d"], substrateMap { "Mud": "mud", "Sandy mud": "mud", "Fine mud": "mud", "Sandy mud or Muddy sand": "mud", "Muddy sand": "sand", "Sand": "sand", "Coarse substrate": "gravel", "Mixed sediment": "mixed", "Rock or other hard substrata": "rock" }, weedPatterns ["posidonia", "seagrass", "cymodocea", "zostera"], pageSize 500, timeoutSeconds 180, ratePerMinute 20 }`
    - `humanActivities { wfsUrl "https://ows.emodnet-humanactivities.eu/wfs", layers [{ typeName "emodnet:telecomcables", kind "cable", bufferM 500, idField "id" }, { typeName "emodnet:pcablesrona", kind "cable", bufferM 500, idField "id" }, { typeName "emodnet:militaryareas", kind "military", bufferM 0, idField "id" }, { typeName "emodnet:natura2000areas", kind "protected_area", bufferM 0, idField "sitecode" }, { typeName "emodnet:finfish", kind "aquaculture", bufferM 0, idField "id" }, { typeName "emodnet:shellfish", kind "aquaculture", bufferM 0, idField "id" }], pageSize 1000, timeoutSeconds 180, ratePerMinute 20 }`
    - `bufferKm 2`
  - **Namen prüfen:** `coverageId`, `typeName`, Feldnamen (`substrateField`, `habitatFields`, `idField`) und die Substratwerte sind Startwerte. Vor den Tests je Dienst **ein** `GetCapabilities`-Aufruf (Bathymetrie zusätzlich ein `DescribeCoverage` für die Achsennamen), nicht als Fixture eingecheckt; Kriterien: Bathymetrie = mittlere Tiefe des DTM 2024; Meeresboden = EUSeaMap-Substratlayer in voller Auflösung mit Mittelmeer; Human Activities = Telekommunikations- und Stromkabel, Militärgebiete, Natura 2000, Aquakultur (Fisch und Muscheln). Gibt es einen Layer nicht, fällt er aus der Liste; Abweichungen in der Commit-Nachricht.
  - `coverageUrl(cfg: DatasetsConfig["bathymetry"], bbox: Bbox): string` – `service=WCS&version=2.0.1&request=GetCoverage&coverageId=<id>&format=image/tiff&subset=Long(<w>,<e>)&subset=Lat(<s>,<n>)` (Achsennamen laut `DescribeCoverage`).
  - `fetchCoverage(transport: Transport, bbox: Bbox, ctx: CallContext, cfg: DatasetsConfig["bathymetry"]): Promise<Uint8Array>` – Service `emodnet-bathymetry`; Antwort ohne TIFF-Kennung (`II*\0`/`MM\0*`) → `HttpError` mit den ersten 200 Zeichen der Antwort.
  - `wfsPageUrl(input: { url: string; typeName: string; bbox: Bbox; startIndex: number; count: number }): string` – WFS 2.0.0 `GetFeature`, `typeNames`, `outputFormat=application/json`, `srsName=urn:ogc:def:crs:OGC:1.3:CRS84`, `bbox=<w>,<s>,<e>,<n>,urn:ogc:def:crs:OGC:1.3:CRS84`, `count`, `startIndex` (lon/lat-Reihenfolge, Grund: Review Focus 3).
  - `fetchWfsFeatures(transport: Transport, input: { service: string; url: string; typeName: string; bbox: Bbox; pageSize: number; timeoutMs: number; ratePerMinute: number }, ctx: CallContext): Promise<{ pages: string[]; features: GeoJSON.Feature[] }>` – Seiten bis eine Seite weniger als `pageSize` Features hat; kaputtes JSON → `RetryableHttpError`; mehr als 50 Seiten → Error.

- [ ] **Step 1: Failing tests** (nur Fake-Transports; echte Fixtures kommen in Task 10)

```ts
it("coverageUrl puts lon into Long() and lat into Lat()", …);
it("wfsPageUrl uses CRS84 and w,s,e,n order", …);
it("pages until a short page: 2 full + 1 partial → 3 calls, all features", …);
it("an OGC exception instead of a TIFF is a non-retryable HttpError", …);
it("invalid JSON from WFS is retryable", …);
it("every call is recorded in external_calls with service emodnet-*", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren, Namen gegen GetCapabilities prüfen. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(adapters): emodnet wcs and wfs clients`

### Task 10: Stufe `datasets.import`

**Files:**
- Create: `lib/pipeline/datasets.ts`, `lib/jobs/handlers/datasets.ts`
- Modify: `lib/jobs/stages.ts`, `lib/jobs/registry.ts`, `lib/jobs/queues.ts`, `config/queues.json`, `scripts/fixtures-record.ts` (`--datasets`)
- Test: `lib/pipeline/__tests__/datasets.test.ts`, Fixtures `test/fixtures/http/emodnet-bathymetry/`, `…/emodnet-seabed/`, `…/emodnet-human-activities/`

**Interfaces:**
- Consumes: `fetchCoverage`, `fetchWfsFeatures` (Task 9), `importBathymetryRaster` (Task 5), `classifySeabed`, `replaceSeabed` (Task 7), `upsertRestrictedAreas` (Task 8), `tileNeighbours`, `areaBbox`, `bufferBbox`, `getArchive()`, `getTransport()`, `startRun`.
- Produces:
  - `DATASET_KINDS = ["bathymetry", "seabed", "restrictions"] as const`, `type DatasetKind`, `DATASETS_STAGE = "datasets.import"`.
  - `importBathymetry(db, input: { area: AreaConfig; runId?: string }, deps: { transport: Transport; archive: Archive }): Promise<{ tiles: number; rasterTiles: number; reused: number }>` – Kacheln = Küstenkacheln des Reviers (`tiles.area_id`, `has_coast`) ∪ deren 8 Nachbarn; je Kachel genau ihre Box abrufen, außer `datasets/emodnet-bathymetry/<datasetVersion>/<tileId>.tif` liegt schon im Archiv (dann `reused`); danach `importBathymetryRaster`.
  - `importSeabed(db, input, deps): Promise<{ features: number; unmapped: number; version: string }>` – Box = `bufferBbox(areaBbox(area), bufferKm)`; Version = erste 12 Hex-Zeichen von sha256 über alle Seiten; Seiten nach `datasets/emodnet-seabed/<version>/<areaKey>/<n>.json`; nicht zuordenbare Features zählen in `unmapped` (Werte im Log), dann `replaceSeabed`.
  - `importRestrictions(db, input, deps): Promise<Partial<Record<RestrictedKind, { inserted: number; updated: number; unchanged: number; ended: number }>>>` – je Layer abrufen, Seiten nach `datasets/emodnet-human-activities/<YYYY-MM-DD>/<areaKey>/<typeName>-<n>.json`; Geometrie in SQL normalisieren: `bufferM > 0` → `ST_Buffer(::geography, bufferM)`, sonst `ST_CollectionExtract(ST_MakeValid(g), 3)` (leer → übersprungen); `sourceRef = "<typeName>/<props[idField] ?? feature.id>"`; `upsertRestrictedAreas` mit `layerPrefix "<typeName>/"`.
  - Alle HTTP-Abrufe vor der DB-Transaktion (Hinweis in `httpCall`).
  - Queue `datasets.import` (concurrency 1, retryLimit 2, retryDelaySeconds 300, backoff true). Stage `datasets.import`: aus `params { areaKey, datasets?: DatasetKind[] }` je Datensatz ein Job `{ key: "<dataset>:<areaKey>", dataset, areaKey }`.
  - `startDatasetImportRun(db, boss, areaKey: string, triggeredBy: string, datasets?: DatasetKind[]): Promise<{ id: string }>` – Umfang `area`, Stufe `["datasets.import"]`.
  - `scripts/fixtures-record.ts --area <key> --datasets` zeichnet die drei Importe mit `recordingTransport(fetchTransport)` gegen die Wegwerf-DB auf.

- [ ] **Step 1: Fixtures aufzeichnen** – `npm run fixtures:record -- --area aegina-west --datasets` (Netz, wenige Aufrufe; Revier `aegina-west` = Kachel `q025:813:510` wie in M1).
Expected: Dateien unter `test/fixtures/http/emodnet-{bathymetry,seabed,human-activities}/`. Ein Layer ohne Features im Ausschnitt ist eine gültige leere Seite.

- [ ] **Step 2: Failing tests** (`vi.mock` der Konfiguration mit Revier `aegina-west` wie `gazetteer-run.test.ts`; DB-Teil in `withRollback`, weil die Kachel in der Pilotbox liegt)

```ts
it("importBathymetry stores rasters per tile; a sea point has positive depth, a land point none", async () => {
  // sea: 23.30, 37.62 (≥ 1 km from land in the land fixture) → depth > 5; land: Agistri interior 23.345, 37.695 → null
});
it("a second bathymetry import reuses the archived tif without HTTP", …); // transport spy: 0 calls
it("seabed features lie inside the requested box", …); // every feature bbox intersects the box in lon/lat order
it("restrictions: cable lines become 500 m polygons; re-import changes nothing", …);
it("stage plans one job per requested dataset", …);
```

- [ ] **Step 3: Run** `npx vitest run lib/pipeline/__tests__/datasets.test.ts` → FAIL.
- [ ] **Step 4: Implementieren.** Liegen die Fixture-Features außerhalb der Box oder ist die Tiefe negativ, Achsen bzw. `valueIsElevation` in `config/datasets.json` korrigieren, nicht die Tests.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(datasets): datasets.import stage for bathymetry, seabed and restricted areas`

### Task 11: Stufe `geometry.place`

**Files:**
- Create: `lib/pipeline/geometry.ts`, `lib/jobs/handlers/geometry.ts`
- Modify: `lib/jobs/stages.ts`, `lib/jobs/registry.ts`, `lib/jobs/queues.ts`, `config/queues.json`
- Test: `lib/pipeline/__tests__/geometry.test.ts`

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces:
  - `GAP_REASONS = ["no_water", "origin_unresolved", "no_bathymetry", "no_anchor_area", "no_seabed_coverage"] as const`, `type GapReason`, `type Gap = { attribute: string; reason: GapReason }`; Lücken stehen in `outputs.gaps` der jeweiligen Computation.
  - `computePlaceGeometry(db, placeId: string, opts?: { runId?: string; today?: string }): Promise<{ created: ComputationKind[]; unchanged: ComputationKind[]; gaps: Gap[]; excluded: boolean }>` – eine Transaktion. Fehlt jede `bathymetry`-Zeile für die Kachel des Orts → `Error("bathymetry not imported for tile <id> – run Datensätze laden")`; fehlen Landpolygone im Umkreis 50 km → `Error("land polygons missing …")`. Reihenfolge und Inhalt:

| Art | `inputs` | Facts (Konfidenz) | `outputs` |
| --- | --- | --- | --- |
| `fetch` | `origin` (6 Stellen), `originSource`, `srid`, `landVersions`, `params: cfg.fetch` | `fetch.<S>` (0,7) | `rays` |
| `shelter` | `fetchComputationId`, `params: { shelter, opening, swell }` | `shelter.<S>` (0,6), `swell_protection` (0,4), `opening_bearing` (0,6) | – |
| `anchor_area` | `waterKey`, `landVersions`, `bathymetry` (Datensatz, Version, Auflösung), `params: cfg.anchorArea` | `anchor_area`, `anchor_position` (0,3) | `water`, `area` (GeoJSON), `gaps` |
| `depth` | `origin`, `bearingDeg`, `waterKey`, `anchorAreaKey`, `bathymetry`, `params: cfg.depth` | `depth.approach`, `depth.min`, `depth.max` (Wasser), `depth.anchoring_min`, `depth.anchoring_max` (Ankerfläche), alle `depthConfidence` | `samples` (Punkte), `gaps` |
| `seabed` | `target` (`anchor_area` oder `water`), `targetKey`, `seabedVersions` | `seabed` (0,5) | `coverage`, `gaps` |
| `restriction` | `targetKey`, `restrictedAreas: [{ id, kind }]`, `params: { minShare, protectedAreaAnchoringBan, noAnchoringKinds }` | `restriction` (0,9) | – |
| `quietness` | `origin`, `settlementId` | keine | `settlementDistanceM` |

    Ausgang aus `resolveOrigin` (`null` → keine `fetch`/`shelter`/`depth`-Zeilen, Lücken `origin_unresolved` für `shelter.*`); Tiefen-Peilung = `opening.bearingDeg`, bei `null` die Peilung des längsten Strahls (kleinster Index); `anchor_area`/`anchor_position`/`depth.anchoring_*` nur bei nicht leerer Ankerfläche (sonst Lücke `no_anchor_area`); keine Rasterwerte → Lücke `no_bathymetry`; Grund auf der Ankerfläche, sonst der Wasserfläche, `coverage < minCoverage` → Lücke `no_seabed_coverage`. `observedAt = today`. Die berechnete Ankerposition wird in `places` geschrieben (`anchor_confidence 0.3`, `anchor_origin "computed"`), nur wenn `anchor_origin` leer oder `computed` ist und sich der Wert ändert. Danach `exclusionFor(hits, minShare)` → `applyExclusion`.
  - Queue `geometry.compute` (concurrency 4, retryLimit 2, retryDelaySeconds 60, backoff true). Stage `geometry.place`: aus `params { tileIds?: string[]; areaKey?: string }` alle gültigen Orte ohne `merged_into_id` mit Status `candidate`, `confirmed` oder `no_anchoring`; Job `{ key: placeId, placeId }`.
  - `startGeometryRun(db, boss, scope: { tileId: string } | { areaKey: string }, triggeredBy: string): Promise<{ id: string }>` – Umfang `tile` bzw. `area`, Stufe `["geometry.place"]`.

- [ ] **Step 1: Failing tests** (Szene: Halbkreis-Bucht aus Task 4, Raster aus Task 5 so verschoben, dass es die Bucht deckt, zwei Grundpolygone, Ort `candidate` mit Bucht-Punkt-Objekt; alles in `withRollback`)

```ts
it("writes all seven computations and the 27 M2 facts", async () => {
  // shelter.S 0 ±0.02, shelter.N 0.93 ±0.02; every fact has computation_id; depth.approach not all null
});
it("second run creates no computations or facts", …);                     // counts unchanged
it("computed anchor is written with 0.3 and is not used as origin on a rerun", …); // rerun → all unchanged
it("review anchor is the ray origin and is never overwritten", …);        // fetch inputs.originSource "review_anchor"
it("a new land dataset version recomputes exactly fetch, shelter and anchor_area", …);
it("place outside the raster gets gaps no_bathymetry and no_anchor_area but 8 shelter facts", …);
it("anchor area > 50 % in a military area → no_anchoring, task dismissed", …);
it("missing bathymetry for the tile fails with a clear message", …);
it("stage plan skips rejected and merged places", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run lib/pipeline lib/jobs` → PASS.
- [ ] **Step 5: Commit** `feat(geometry): geometry.place stage writing computations and computed facts`

### Task 12: Golden-Test an drei Pilotorten

**Files:**
- Create: `test/fixtures/geometry/golden-places.json`, `test/fixtures/geometry/golden.json`, `lib/pipeline/__tests__/geometry-golden.test.ts`
- Modify: `vitest.config.ts` (Test in `PILOT_RUN_TESTS`)

**Interfaces:**
- Consumes: `computePlaceGeometry` (Task 11), Fixtures aus Task 10 und M1 (`test/fixtures/land/aegina-west.geojson`).
- Produces:
  - `golden-places.json`: `[{ name, kind, lon, lat }]` für **Perdika**, **Aponisos** (Agistri) und den **Hafen Ägina**, Koordinaten aus den Objekten gleichen Namens im aufgezeichneten Gazetteer-Fixture (fehlt eins, die nächste benannte Bucht der Kachel; in der Commit-Nachricht nennen).
  - `golden.json`: `{ rulesVersion, places: { [name]: { sectors: Record<Sector, number>; swell: number; opening: { bearingDeg: number | null; widthDeg: number }; depth: { approach, min, max } | null; seabed: Array<{ type; share }> | null; anchorAreaM2: number } } }`.
  - Vergleich: Werte 0–1 Abweichung ≤ 0,1; Peilung ≤ 10° (zirkulär); Meter und m² ≤ 10 % relativ (mindestens 1 m); Grund gleiche Typmenge. `UPDATE_GOLDEN=1` schreibt die Datei neu statt zu vergleichen.

- [ ] **Step 1: Test schreiben**, Orte aus Fixture-Koordinaten in `withRollback` anlegen (Landpolygone aus dem Fixture, Raster und Grund über `importBathymetry`/`importSeabed` mit `fixtureTransport`).
- [ ] **Step 2: Run** `npx vitest run lib/pipeline/__tests__/geometry-golden.test.ts` → FAIL (keine Golden-Datei).
- [ ] **Step 3: Erzeugen** `UPDATE_GOLDEN=1 npx vitest run lib/pipeline/__tests__/geometry-golden.test.ts`, Werte gegen Seekarte/Satellitenbild auf Plausibilität prüfen (offene Seiten je Ort), Befund in die Commit-Nachricht.
- [ ] **Step 4: Run** ohne `UPDATE_GOLDEN` → PASS; einen Sektorwert in `golden.json` testweise um 0,15 ändern → FAIL; zurücksetzen.
- [ ] **Step 5: Commit** `test(geometry): golden values for Perdika, Aponisos and Aegina harbour`

### Task 13: Ankerposition korrigieren und Geometrie-Sicht

**Files:**
- Create: `lib/domain/geometry/anchor-correction.ts`, `lib/domain/geometry-view.ts`
- Test: `lib/domain/geometry/__tests__/anchor-correction.test.ts`, `lib/domain/__tests__/geometry-view.test.ts`

**Interfaces:**
- Consumes: `latestComputations` (Task 2), `rayShelter` (Task 3), `DecisionNotAllowed` (M1 Task 18).
- Produces:
  - `setAnchorPosition(db, input: { placeId: string; position: LonLat; decidedBy: string; now?: Date }): Promise<{ factId: string }>` – eine Transaktion: Position weiter als `correctionMaxDistanceM` (2000 m) von `places.position` → `DecisionNotAllowed`; `review_tasks` (`kind place_candidate`, `subject_type "place_anchor"`, `subject_id placeId`, `status decided`, `context { previous, previousOrigin }`), `review_decisions` (`decision { action: "set_anchor", position }`), Fact `anchor_position` mit `review_decision_id`, Konfidenz 0,9, `observed_at` heute; `places.anchor_position`, `anchor_confidence 0.9`, `anchor_origin "review"`.
  - `type PlaceGeometryView = { computedAt: Date | null; rulesVersion: string | null; origin: LonLat | null; originSource: string | null; sectors: Record<Sector, { shelter: number; fetchM: number }> | null; swell: number | null; opening: { bearingDeg: number | null; widthDeg: number } | null; rays: Array<{ bearingDeg: number; fetchM: number; shelter: number; end: LonLat }>; depth: { approach: { at50m: number | null; at100m: number | null; at200m: number | null } | null; min: number | null; max: number | null; anchoringMin: number | null; anchoringMax: number | null; confidence: number | null }; seabed: Array<{ type: SeabedType; share: number }> | null; water: GeoJSON.Geometry | null; anchorArea: { areaM2: number; geometry: GeoJSON.Geometry | null } | null; anchorPosition: { lon: number; lat: number; confidence: number | null; origin: string | null } | null; restriction: RestrictionHit[]; gaps: Gap[]; computations: Array<{ id: string; kind: ComputationKind; rulesVersion: string; createdAt: Date; inputs: Record<string, unknown> }> }`
  - `placeGeometry(db, placeId: string): Promise<PlaceGeometryView | null>` – aus den jüngsten Computations je Art; Strahl-Endpunkt per `ST_Project` mit `min(fetchM, 3000)` (Anzeige); unbekannter Ort → `null`.

- [ ] **Step 1: Failing tests**

```ts
it("setAnchorPosition writes one decided task, one decision, one review fact (0.9) and updates the place", …);
it("a position 3 km away is DecisionNotAllowed and writes nothing", …);
it("placeGeometry returns 72 rays, 8 sectors, depths and gaps for a computed place", …); // scene from Task 11
it("placeGeometry for a place without computations has null values and empty lists", …);
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(geometry): anchor correction as review fact, place geometry view`

### Task 14: Ort-Reiter „Geometrie“

**Files:**
- Create: `app/(admin)/places/[id]/geometry-tab.tsx`, `app/(admin)/places/[id]/actions.ts`, `app/(admin)/_components/wind-rose.tsx`, `app/(admin)/_components/wind-rose-math.ts`
- Modify: `app/(admin)/places/[id]/page.tsx`, `app/(admin)/_components/labels.ts`
- Test: `app/(admin)/__tests__/wind-rose.test.ts`, `app/(admin)/__tests__/place-actions.test.ts`

**Interfaces:**
- Consumes: `placeGeometry`, `setAnchorPosition` (Task 13), `placeDetail` (M1 Task 21), `<MiniMap features onPick>` (M1 Task 19), `requireAdmin`.
- Produces:
  - `wedge(sector: Sector, value: number, radius: number): { startDeg: number; endDeg: number; r: number }` – N `startDeg −22.5`, `endDeg 22.5`; `r = value × radius`; `wedgePath(…)` als SVG-Pfad (Mitte oben = N, im Uhrzeigersinn).
  - `<WindRose sectors={Record<Sector, number>} size={number} />` – Server-Komponente, 8 Keile, Farbe von Rot (0) nach Grün (1), Sektor-Beschriftung.
  - Server Action `setAnchorAction(input: FormData | { placeId: string; lon: number; lat: number })` – zod (`placeId` uuid, `lon` −180–180, `lat` −90–90), `requireAdmin`, `setAnchorPosition`, `revalidatePath`; `DecisionNotAllowed` → Fehlermeldung „Ankerposition zu weit vom Ort entfernt (max. 2 km)“.
  - Labels: `SECTOR_LABELS` (`N, NO, O, SO, S, SW, W, NW`), `SEABED_TYPE_LABELS` (Sand, Schlamm, Kies, Fels, Gemischt, Seegras/Algen), `GAP_REASON_LABELS` (`no_water` „Keine Wasserfläche“, `origin_unresolved` „Kein Ausgangspunkt im Wasser“, `no_bathymetry` „Keine Bathymetrie“, `no_anchor_area` „Keine Fläche mit 3–12 m“, `no_seabed_coverage` „Grund nicht abgedeckt“), `COMPUTATION_KIND_LABELS` (Schutz, Fetch, Tiefe, Grund, Ankerfläche, Ruhe, Ausschluss) als vollständige `Record`s.

Seite `/places/[id]`: Reiterleiste über `?tab=` mit „Übersicht“ (bisheriger Inhalt, Standard) und „Geometrie“; spätere Reiter kommen mit ihren Meilensteinen. Reiter „Geometrie“: Windrose mit Werten, Tabelle Sektor/Schutz/Fetch, Schwell und Öffnung, Tiefen (50/100/200 m, min/max, Ankertiefe, Konfidenz), Grundanteile, Ankerfläche m², Ausschluss-Treffer mit Anteil, Lücken mit Begründung, Eingangsdaten je Computation (aufklappbar, `rulesVersion`, Zeitpunkt). Karte: Strahlen (Farbe nach Schutz), Wasserfläche, Ankerfläche, Ankerposition, Tiefenpunkte; Klick setzt einen Vorschlag, Knopf „Ankerposition übernehmen“ sendet die Action. Vor dem Code die Next-Doku zu `searchParams` und Cache Components lesen.

- [ ] **Step 1: Failing tests** – `wedge("N", 1, 100)` → `{ startDeg: -22.5, endDeg: 22.5, r: 100 }`; `wedge("E", 0.5, 100).r === 50`; Action: `rejects without admin session`, `rejects lat 91`, `sets the anchor and writes a review fact`, `too far → German error message`; Route-Policy-Test bleibt grün.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): place geometry tab with wind rose, rays and anchor correction`

### Task 15: Kartenebene „Ausschlussflächen“ und Lauf-Aktionen

**Files:**
- Modify: `lib/domain/map-data.ts`, `app/(admin)/map-data/[layer]/route.ts` (falls Layer-Liste dort geprüft), `app/(admin)/_components/map-view.tsx`, `app/(admin)/_components/labels.ts`, `app/(admin)/runs/page.tsx`, `app/(admin)/runs/actions.ts`, `app/(admin)/tiles/[id]/page.tsx`, `app/(admin)/tiles/[id]/actions.ts`
- Test: `lib/domain/__tests__/map-data.test.ts`, `app/(admin)/__tests__/actions.test.ts`

**Interfaces:**
- Consumes: `MAP_LAYERS`, `mapLayer` (M1 Task 20), `isAnchoringBan` (Task 8), `startDatasetImportRun` (Task 10), `startGeometryRun` (Task 11).
- Produces:
  - `MAP_LAYERS` + `"restricted-areas"`; Features: gültige Flächen in der Box, Properties `{ id, kind, sourceRef, anchoringBan }`.
  - `RESTRICTED_KIND_LABELS`: `military` „Militärgebiet“, `cable` „Kabel“, `protected_area` „Schutzgebiet“, `aquaculture` „Aquakultur“, `ferry_lane` „Fährkorridor“, `firing_area` „Schießgebiet“.
  - `MapView`: Schalter „Ausschlussflächen“, Füllung je `kind`, Umriss kräftiger bei `anchoringBan`; Seitenleiste zeigt Art, Kennung, „Ankerverbot ja/nein“.
  - Server Actions `startDatasetImportAction({ areaKey })` (areaKey ∈ Konfiguration), `startGeometryAction({ areaKey } | { tileId })` (tileId wie `startSeedAction` geprüft).
  - Läufe-Seite: Formulare „Datensätze laden“ und „Geometrie für Revier“ (Auswahl Revier); Kachelseite: Knopf „Geometrie“.

- [ ] **Step 1: Failing tests** – `restricted-areas layer returns only valid areas in the bbox with anchoringBan`, `an ended area is not on the map`, `startGeometryAction for a tile starts a tile-scoped run with stage geometry.place`, `startDatasetImportAction rejects an unknown area`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** `npx vitest run && npm run lint && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(admin): restricted areas map layer, dataset and geometry run actions`

### Task 16: Stichprobe gegen den Vergleichssatz

**Files:**
- Create: `lib/domain/quality/navily-sample.ts`, `scripts/compare-navily.ts`, `test/fixtures/navily/sample.json` (synthetisch)
- Modify: `package.json` (Skript `compare:navily`)
- Test: `lib/domain/quality/__tests__/navily-sample.test.ts`

**Interfaces:**
- Consumes: `comparison_set` (M1 Task 22), `latestComputations` (Task 2), `runs`, `external_calls`.
- Produces:
  - `type NavilySpot = { lat: number; lon: number; prot: string[] | null; seabeds: string[] | null }` – nur diese Felder werden gelesen (zod, übrige Felder verworfen).
  - `loadNavilySpots(path: string): Promise<NavilySpot[]>` – liest die Datei; schreibt nie etwas.
  - `type OwnPlaceValues = { placeId: string; publicId: string | null; name: string; position: LonLat; shelter: Record<Sector, number> | null; seabed: SeabedType[] | null; depthGap: GapReason | null; hasDepth: boolean }`
  - `ownValuesForComparisonSet(db, areaKey: string): Promise<OwnPlaceValues[]>` – Orte des Vergleichssatzes mit den Facts der jüngsten Computations; `seabed` = Typen mit Anteil ≥ 0,3.
  - `type PlaceVerdict = { placeId: string; publicId: string | null; name: string; matched: boolean; sectorsAgree: number | null; sectorResults: Record<Sector, "match" | "deviation"> | null; seabed: "match" | "deviation" | "no_own_value" | "not_at_navily"; depth: "value" | GapReason; verdict: "stimmt" | "teilweise" | "weicht ab" | "nicht bei Navily" | "ohne Geometrie" }`
  - `comparePlace(own: OwnPlaceValues, spots: NavilySpot[], opts: { radiusM: number; protectedThreshold: number }): PlaceVerdict` – rein. Zuordnung: nächster Spot ≤ `radiusM` (Default 500). Sektor geschützt bei Periplus = Wert ≥ `protectedThreshold` (Default 0,5), bei Navily = Kleinbuchstaben-Sektor in `prot`; Grund: Navily `algae` = `weed`, Übereinstimmung bei nicht leerer Schnittmenge. Urteil: ≥ 6/8 „stimmt“, 4–5 „teilweise“, ≤ 3 „weicht ab“. Navily hat keine Tiefe: Tiefe wird nur als Deckung berichtet.
  - `renderReport(input: { areaKey: string; generatedAt: Date; verdicts: PlaceVerdict[]; runtime: { runId: string; places: number; durationS: number; perPlaceS: number } | null; costs: { calls: number; costEur: number; byService: Record<string, number> } }): string` – Markdown: Kopf mit Hinweis „Navily-Werte wurden nur zur Laufzeit gelesen und nicht gespeichert (Grundprinzip 9).“; Kennzahlen (verglichene Orte, bei Navily gefunden, Sektor-Übereinstimmung gesamt und je Sektor in %, Grund-Übereinstimmung %, Tiefen-Deckung %); Tabelle je Ort (eigener Name, eigene ID, Sektoren n/8, Grund, Tiefe oder Lücken-Label, Urteil); Abschnitt „Laufzeit und Kosten“.
  - `geometryRunStats(db, areaKey): Promise<{ runId: string; places: number; durationS: number; perPlaceS: number } | null>` (jüngster beendeter Lauf mit Stufe `geometry.place` und Umfang dieses Reviers), `datasetImportCosts(db, areaKey): Promise<{ calls: number; costEur: number; byService: Record<string, number> }>` (`external_calls` des jüngsten `datasets.import`-Laufs).
  - CLI `npm run compare:navily -- --area saronic --navily <pfad> [--out <datei>]`; Pfad alternativ aus `NAVILY_SPOTS_PATH`, ohne beides Abbruch; Standard-Ausgabe `docs/pilot/<YYYY-MM-DD>-m2-stichprobe.md`; Exit 1, wenn weniger als 20 Orte mit Geometrie verglichen wurden (Spec 04: Stichprobe 20 Orte).

- [ ] **Step 1: Failing tests** (synthetisches `sample.json` mit Feldern wie die echte Datei, darunter `name "NAVILY-ONLY-NAME"`, `id 987654321`, `url "https://www.navily.com/x"`)

```ts
it("prot [n, ne, nw] vs own N .9, NE .8, NW .7, rest .1 → 8/8 'stimmt'", …);
it("nearest spot 800 m away → 'nicht bei Navily'", …);
it("algae matches own weed", …);
it("a place without shelter facts → 'ohne Geometrie'", …);
it("the report contains no Navily values", () => {
  const md = renderReport(…);
  for (const s of ["NAVILY-ONLY-NAME", "987654321", "navily.com", '"prot"']) expect(md).not.toContain(s);
});
it("ownValuesForComparisonSet reads facts of the latest computations", …); // withRollback
```

- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(quality): navily spot check reporting results only`

### Task 17: Abnahme-Prüfung, Runbook, Übergabe

**Files:**
- Create: `lib/domain/geometry/check.ts`, `scripts/check-geometry.ts`, `docs/pilot/m2-abnahme.md`
- Modify: `package.json` (Skript `check:geometry`), `docs/runbook.md`
- Test: `lib/domain/geometry/__tests__/check.test.ts`

**Interfaces:**
- Consumes: `latestComputations`, `GAP_REASONS`.
- Produces:
  - `checkGeometry(db, areaKey: string): Promise<{ places: number; complete: number; missing: Array<{ placeId: string; name: string; missing: string[] }>; depthGaps: Array<{ placeId: string; name: string; reason: GapReason }> }>` – Orte wie Stufe `geometry.place`; vollständig = 8 `shelter.*`-Facts, `opening_bearing` und (`depth.approach` oder `depth.min`, oder eine Lücke `no_bathymetry`/`no_anchor_area`).
  - CLI `npm run check:geometry -- --area saronic` – gibt die Werte aus, Exit 1 bei nicht leerem `missing`.

- [ ] **Step 1: Failing test** – `reports a place with 7 shelter facts as missing and counts a depth gap as complete`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implementieren. **Step 4: Run** → PASS.
- [ ] **Step 5: Runbook** – Abschnitt „Geometrie und Ausschlüsse“: Landpolygone mit `landBufferKm 55` je Revier neu importieren (Strahlen reichen 50 km) → „Datensätze laden“ je Revier → „Geometrie für Revier“ → `check:geometry` → `compare:navily` mit lokalem Navily-Pfad; neue Datensatzversion oder geänderte `config/geometry.json` (`rulesVersion` erhöhen) → „Geometrie“ erneut, nur Geändertes entsteht neu; Pflege der Ankerverbots-Gebiete in `config/restrictions.json`. `docs/pilot/m2-abnahme.md`: Checkliste aus Roadmap und Spec 04 (8 Sektorwerte mit Beleg je Kandidat, Öffnung, Tiefe oder begründete Lücke, Stichprobe ≥ 20 Orte dokumentiert, Laufzeit und Kosten dokumentiert, Golden-Test grün).
- [ ] **Step 6: Gesamtprüfung** – `npm run lint && npm run typecheck && npx vitest run && npm run test:e2e && npm run build` → alles grün.
- [ ] **Step 7: Commit** `docs: M2 acceptance check and runbook`
- [ ] **Step 8: Übergabe an Christian (nicht vom Ausführenden zu erledigen)** – Natura-2000-Gebiete mit Ankerverbot im Saronischen/Argolischen Golf prüfen und in `config/restrictions.json` eintragen; auf dem Server Landpolygone neu importieren, „Datensätze laden“ und „Geometrie“ für beide Reviere starten; `check:geometry` grün; `compare:navily` ausführen, Bericht unter `docs/pilot/` einchecken, Abweichungen ansehen.

---

## Bewusste Abweichungen und Entscheidungen dieses Plans

- **Raster-Import per `ST_FromGDALRaster` im Job statt `raster2pgsql`.** `raster2pgsql` liegt nur im Postgres-Image, der Worker läuft im Node-Image; der Job lädt das GeoTIFF je Kachel (≈ 240 × 240 Pixel), archiviert es und reicht die Bytes an PostGIS (`ST_Tile` 256×256). Dafür ist der GDAL-Treiber GTiff im Postgres-Image eingeschaltet. Landpolygone bleiben beim CLI aus M1.
- **Tiefe wird beim Import positiv gespeichert** (Vorzeichen des EMODnet-Höhenmodells umgekehrt), damit jede Leseabfrage dieselbe Regel hat: Wert > 0 = Wassertiefe unter LAT, sonst keine Tiefe.
- **Nur EMODnet DTM 2024 (~115 m) in M2.** HR-Küsten-DTMs und GEBCO-Fallback kommen erst, wenn der Pilot Lücken zeigt; die Spalten `dataset`/`resolution_m` und `depthConfidence` sind dafür vorbereitet.
- **Datensatzversionen:** Bathymetrie über die Release-Version aus der Konfiguration, Meeresboden über einen Inhalts-Hash der WFS-Antworten – ein unveränderter Re-Import löst so keine Neuberechnung aus. Ausschlussflächen sind stabil und tragen Gültigkeit statt Version; die Restriction-Computation hält die IDs der getroffenen Flächen.
- **`computations.outputs` und `inputs_hash`** ergänzen Spec 02: `outputs` hält Zwischenergebnisse ohne eigenen Fact (72 Strahlen, Wasser- und Ankerfläche, Lücken mit Grund) für UI und Nachvollziehbarkeit; `inputs_hash` macht „identische Eingänge = keine neuen Zeilen“ prüfbar. Verglichen wird mit der jüngsten Zeile je Ort und Art, nicht global (A → B → A ergibt drei Zeilen).
- **Ausgangspunkt der Strahlen** ist die Ortsposition oder eine vom Admin gesetzte Ankerposition, nie die berechnete Ankerposition – sonst würden sich die Eingänge bei jedem Lauf ändern.
- **Lücken** („begründete Lücke“) stehen bis zur Konsolidierung (M5) in `outputs.gaps` der Computation; die Lückenliste des Profils baut M5 daraus.
- **Ruhe (`quietness`)** legt in M2 nur den Abstand zur nächsten Siedlung aus dem Gazetteer ab, ohne Fact; den Straßenabstand bringt M5 mit der Ruhe-Formel, weil Straßen bisher nicht importiert werden.
- **Unbenannte Buchten (`geometry.detect_bays`) rücken nach M7**, wie Spec 04 bei knapper Zeit erlaubt.
- **Schiffsdichte wird in M2 nicht geladen.** Spec 04 sieht nur Download und Ablage vor; ohne Verbraucher vor M9 wäre die Datei dort ohnehin veraltet.
- **`landBufferKm` steigt von 10 auf 55 km**, damit Strahlen bis 50 km Land finden; Landpolygone müssen je Revier neu importiert werden (Runbook).
- **`aquaculture` gilt als Ankerverbot** (`noAnchoringKinds`), weil der Liefervertrag `aquaculture` als Ausschlussgrund kennt. Natura-2000-Gebiete schließen nur aus, wenn ihr Code in `config/restrictions.json` steht; die Liste startet leer und wird von Christian gepflegt.
- **Ausschluss ändert auch bestätigte Orte** auf `no_anchoring` (Liefervertrag liefert sie mit Grund); verworfene und verlassene Orte bleiben unberührt; eine Rücknahme bei verschwundener Fläche ist eine Review-Entscheidung, nicht automatisch.
- **Ankerkorrektur ohne eigene Review-Art:** eine sofort entschiedene Aufgabe `place_candidate` mit `subject_type "place_anchor"` trägt die Entscheidung, an der der Review-Fact hängt (Spec 02 verlangt `review_decision_id` mit `task_id`).
- **Stichprobe als Bericht, nicht als `comparison_results`.** `comparison_results` braucht `profile_version` und kommt mit M7; der M2-Bericht enthält nur Kennzahlen und Urteile je Ort, keine Navily-Werte. Navily hat keine Tiefen, die Tiefe wird nur als Deckung berichtet.
