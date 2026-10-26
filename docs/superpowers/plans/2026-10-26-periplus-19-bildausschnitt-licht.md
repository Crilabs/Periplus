# Bildausschnitt und Licht (Spec 19) – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Das automatische Titelbild nimmt die Kamera aus dem Umriss (Becken, Molen, Ankerfenster), wählt das Licht nach
der Stadt im Bild und malt mit Prompt v2; das geht zusammen mit PR 38 und 39 in einem Merge auf `main` und damit in einen
Deploy.

**Architecture:**
- **Domain:** neue Module in `lib/domain/images` berechnen ohne Rendering:
  - die Projektion (gleiche Kamera wie `scene.ts`),
  - die Kameraanpassung an einen Fokus,
  - die Wasser-Vorhersage,
  - Hafen-Fokus und Ankerfenster.
- **Einstieg:** `planView` wählt für die automatische Ansicht (`slot: "title"` ohne Zoom und ohne Startrichtung) die neue
  Kamera, sonst `planRender` (camera-3) wie bisher. Plan (`stage.ts`) und Job (`generate.ts`) rufen beide `planView`, damit
  ihre Erzeugungsschlüssel übereinstimmen.
- **Molen und Stege:** kommen als neuer Datensatz `harbour_structures` je Landesteil (wie `roads`).

**Tech Stack:** TypeScript, Drizzle/PostGIS, three.js (nur Mathematik), Vitest gegen `db-test`.

**Spec:** `docs/superpowers/specs/2026-10-26-periplus-19-bildausschnitt-licht-design.md` (ergänzt Spec 13,
`docs/superpowers/specs/2026-10-20-periplus-13-ortsbilder-design.md`).

## Global Constraints

- Code, Bezeichner, Config, Prompts Englisch; Oberfläche und Specs Deutsch.
- Fachlogik nur in `lib/domain` und `lib/pipeline`; Seiten und Job-Handler bleiben dünn.
- Schwellen, Gewichte, Prompts in `config/`, nicht im Code. Werte aus Spec 19, Abschnitt „Konfiguration“, wörtlich.
- Externe Dienste nur über Adapter in `lib/adapters`. Tests rufen nie das Netz; Bildmodell über `MockImageModel`.
- Tests gegen echte Postgres (`db-test`); Testdaten mit `withRollback`.
- `camera.rulesVersion` = `camera-4`, `promptVersion` von `generate-place-image` = 2. Beides geht in den
  Erzeugungsschlüssel ein, sodass alle Titelbilder neu entstehen.
- Plan und Job müssen für denselben Ort dieselbe Kamera und denselben Schlüssel liefern: keine Zufallswerte, keine
  Uhrzeit, keine Netzaufrufe im Plan.
- Das Laborskript `scripts/lab-image-framing.ts` wird nicht eingecheckt.

## Review Focus

1. **Ankerplatz auf offener See** (kein Land in 1.500 m): `planView` fällt auf `planRender` (camera-3) zurück statt auf
   `no_water_view`.
   Test in Task 6.
2. **Marina-Fläche, deren Wasserfläche leer ist** (Polygon ganz auf Land): weiter mit Molen, sonst camera-3, nie ein leerer
   Fokus.
   Test in Task 5.
3. **Plan und Job geben verschiedene Schlüssel:** `imageTargets` und `generatePlaceImage` liefern für einen Ort mit Becken
   und einen Ankerplatz denselben Schlüssel.
   Test in Task 7.
4. **Stadt knapp außerhalb des Bildes oder nur `village`:** Mittag, kein Abend.
   Test in Task 8.
5. **Nur Sentinel-2 (Kataster leer):** die Kamera bleibt mindestens auf der Höhe von z1 (260 m), auch wenn der Fokus
   klein ist.
   Test in Task 7.

---

### Task 0: Arbeitsbaum und Spec

**Files:**
- Move: `docs/superpowers/specs/2026-10-26-periplus-19-bildausschnitt-licht-design.md`,
  `docs/superpowers/specs/2026-10-20-periplus-13-ortsbilder-design.md` (Hinweis-Abschnitt), dieser Plan; jetzt
  uncommittet in `main`.

- [ ] **Step 1:** Worktree `.claude/worktrees/bildausschnitt`, Branch `feat/bildausschnitt` von `origin/main`
  (`superpowers:using-git-worktrees`). `npm ci`; `.env.local` aus dem Hauptbaum verlinken.
- [ ] **Step 2:** Die drei Dokumente in den Worktree kopieren und im Hauptbaum zurücksetzen (`git checkout --` für Spec 13,
  löschen für die neuen Dateien).
- [ ] **Step 3:** Commit `docs: spec 19 Bildausschnitt und Licht, plan`.

### Task 1: Projektion

**Files:**
- Create: `lib/domain/images/projection.ts`
- Test: `lib/domain/images/__tests__/projection.test.ts`

**Interfaces:**
- Produces:
  - `type LonLat = [lon: number, lat: number]` (aus `render-plan.ts` exportieren und hier verwenden);
  - `projectGround(camera: RenderCamera, points: LonLat[]): Array<[x: number, y: number] | null>` liefert NDC (−1…1,
    y nach oben) von Punkten auf Meereshöhe, `null` hinter der Kamera;
  - `groundAt(camera: RenderCamera, ndc: [number, number], maxM: number): LonLat | null` liefert den Schnitt des
    Sehstrahls mit Meereshöhe, `null` über dem Horizont oder weiter als `maxM`.
- **Vorgaben:**
  - Kamera wie `perspective()` in `lib/pipeline/images/scene/scene.ts:304`: three.js `PerspectiveCamera`, `up` = z, Ziel
    im Ursprung.
  - Lokaler Rahmen wie `scene.ts`: `kx = 111320·cos(lat)`, `ky = 110540`.
  - Im Code mit Verweis auf `scene.ts` kommentieren, dass beide gleich bleiben müssen.

- [ ] **Step 1: Failing tests**
  - `the target projects to the image centre`: `projectGround(cam, [cam.target])[0]` ≈ `[0, 0]` (±1e-9).
  - `a point beyond the target lies above the centre, one to the right of the view lies right`.
  - `a point behind the camera is null`.
  - `groundAt inverts projectGround`: Hin und zurück für NDC `[0.5, -0.5]`, Abweichung < 0,01 m.
  - `groundAt of a ray above the horizon is null`.

  Kamera: `cameraFor(target, 200, "z1", cfg)` mit `tiltDeg` 40.
- [ ] **Step 2:** `npx vitest run lib/domain/images/__tests__/projection.test.ts`; Erwartung: FAIL (Modul fehlt).
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** Tests laufen grün.
- [ ] **Step 5:** Commit `feat(images): ground projection of the render camera (spec 19)`.

### Task 2: Kamera aus dem Fokus

**Files:**
- Create: `lib/domain/images/fit.ts`
- Modify: `config/images.json`, `lib/config/schemas.ts` (Abschnitt `composition`)
- Test: `lib/domain/images/__tests__/fit.test.ts`

**Interfaces:**
- Consumes: `projectGround` (Task 1), `RenderCamera` (Feld `zoom` trägt die Untergrenzen-Stufe).
- Produces:
  ```ts
  fitCamera(
    rings: LonLat[][],
    azimuthDeg: number,
    opts: { tiltDeg: number; fill: number; centreY: number; minHeightM: number; zoom: ZoomLevel },
    cfg: Pick<ImagesConfig, "camera" | "composition">,
  ): RenderCamera | null
  ```
- **Config:**
  - `composition.fit`:
    `{ "margin": 0.1, "minHeightM": 100, "maxHeightM": 900, "heightStep": 1.04, "centreTolerance": 0.02, "maxIterations": 15, "floorZoom": "z3" }`;
  - `camera.rulesVersion`: `"camera-4"`.
- **Algorithmus:** wie Spec 19, Teil A.
  - Höhe von `max(minHeightM, fit.minHeightM)` bis `fit.maxHeightM`, je Schritt × `heightStep`.
  - Je Höhe höchstens `maxIterations` Nachführungen des Ziels: quer = `dx · slant · tan(hfov/2)`, längs =
    `dy · slant · tan(vfov/2) / sin(tilt)` mit `slant = h / sin(tilt)`.
  - Treffer, wenn
    - Breite ≤ `2 · min(fill, 1 − 2·margin)`,
    - Höhe ≤ `(1 + centreY) · 2 · min(fill, 1 − 2·margin)`,
    - beide Mittenabweichungen < `centreTolerance`.
  - `distanceM = h / tan(tilt)`.

- [ ] **Step 1: Failing tests**
  - `a 200 m square fits inside the safe area at fill 0.6`: alle Ecken mit |x| ≤ 0,8 und |y| ≤ 0,8; die Mitte liegt bei
    `centreY` ±0,02.
  - `a larger square needs a higher camera`: 400 m gibt eine größere `heightM` als 200 m.
  - `the camera never goes below minHeightM`: ein 20-m-Quadrat mit `minHeightM` 260 ergibt `heightM` ≥ 260.
  - `a focus too large for maxHeightM gives null`: Quadrat von 20 km.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren, Config und Zod-Schema ergänzen.
- [ ] **Step 4:** grün; außerdem `npx vitest run lib/config` grün.
- [ ] **Step 5:** Commit `feat(images): camera fitted to a focus outline (spec 19)`.

### Task 3: Wasser-Vorhersage

**Files:**
- Create: `lib/domain/images/prediction.ts`
- Modify: `config/images.json` (`composition.prediction: { "gridX": 32, "gridY": 21, "maxRayM": 20000 }`), Schema
- Test: `lib/domain/images/__tests__/prediction.test.ts`

**Interfaces:**
- Produces:
  ```ts
  predictShares(db: Db, camera: RenderCamera, cfg: Pick<ImagesConfig, "composition">):
    Promise<{ water: number; land: number; sky: number }>
  ```
  - Raster von `gridX` × `gridY` Zellmitten, Schnitt mit Meereshöhe über `groundAt`.
  - Eine SQL-Abfrage gegen `land_polygons` für alle Punkte (`unnest` zweier float8-Arrays).
  - Die drei Anteile summieren sich zu 1.

- [ ] **Step 1: Failing tests** (mit `withRollback`; Land über `insertLand` wie in
  `lib/domain/images/__tests__/render-plan.test.ts:13`; Ort auf offener See bei 19.37/36.61):
  - `without land everything below the horizon is water`: `land` 0, `water` + `sky` = 1.
  - `land behind the target covers the upper part`: Land nördlich ab 100 m hinter dem Ziel, Kamera blickt nach Norden;
    `land` > 0,3 und `water` > 0,3.
  - `shares sum to one`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** grün.
- [ ] **Step 5:** Commit `feat(images): water share predicted from land polygons (spec 19)`.

### Task 4: Datensatz `harbour_structures`

**Files:**
- Modify:
  - `lib/db/schema/geo.ts` (Tabelle wie `roads`, `lib/db/schema/geo.ts:335`);
  - Migration über `npm run db:generate` (nächste Nummer nach `0082`);
  - `lib/adapters/overpass.ts`;
  - `lib/pipeline/datasets.ts` (`DATASET_KINDS`, `importDataset`);
  - `config/datasets.json` + Schema.
- Create: `lib/domain/geometry/harbour-structures.ts`
- Test: `lib/adapters/__tests__/overpass.test.ts` (oder die bestehende Query-Testdatei), `lib/pipeline/__tests__/datasets.test.ts`

**Interfaces:**
- **Tabelle `harbour_structures`:** `id` uuid, `osm_id` text unique, `man_made` text, `geom` geometry
  (LineString oder Polygon, 4326, GIST-Index), `dataset_version` text, `created_at`.
- **Overpass:** `buildHarbourStructuresQuery(bbox: Bbox, values: string[], timeoutSeconds: number): string` liefert
  `way["man_made"~"^(pier|breakwater|groyne)$"]` im Box-Format von `buildRoadsQuery`.
- **Ersetzen:** `replaceHarbourStructures(db, input: { box: Bbox; datasetVersion: string; structures: HarbourStructure[] })`
  liefert `Promise<{ stored: number; removed: number }>`, wie `replaceRoads`.
  - `type HarbourStructure = { osmId: string; manMade: string; geometry: LineString | Polygon }`;
  - ein geschlossener Weg wird Polygon.
- **Import:** `importHarbourStructures(db, input: DatasetImportInput, deps: DatasetImportDeps)` liefert
  `{ structures: number; removed: number; version: string }`.
  - Box = Landesteil + `bufferKm`;
  - Archiv `datasets/osm-harbour-structures/<version>/<key>.json`;
  - `DATASET_KINDS` bekommt `"harbour_structures"`.
- **Config `datasets.harbourStructures`:** `{ "manMade": ["pier", "breakwater", "groyne"], "bufferKm": 1 }`.

- [ ] **Step 1: Failing tests**
  - Query-Builder enthält den `man_made`-Filter und die Box.
  - `harbour structures are stored per way; a rerun keeps them, a vanished way is removed`: wie der Roads-Test
    `lib/pipeline/__tests__/datasets.test.ts:371`, mit einem offenen und einem geschlossenen Weg; der geschlossene ist
    danach `ST_GeometryType` = `ST_Polygon`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren, Migration erzeugen, `npm run db:migrate` lokal und für `db-test`.
- [ ] **Step 4:** grün.
- [ ] **Step 5:** Prüfen, dass die Datensatz-Auswahl die neue Art kennt: MCP `datasets_start`, Admin-Knopf, Runbook. Fehlt
  sie dort, ergänzen.
- [ ] **Step 6:** Commit `feat(datasets): OSM piers, breakwaters and groynes per subdivision (spec 19)`.

### Task 5: Hafen-Fokus und Kamera

**Files:**
- Create: `lib/domain/images/harbour-focus.ts`
- Modify: `config/images.json`
  (`composition.harbour: { "tiltDeg": 40, "fill": 0.6, "centreY": -0.1, "pierRadiusM": 300, "pierBufferM": 25 }`),
  Schema
- Test: `lib/domain/images/__tests__/harbour-focus.test.ts`

**Interfaces:**
- **Fokus:** `harbourFocus(db, input: PlaceImageInput, cfg)` liefert `Promise<{ source: "basin" | "structures"; rings: LonLat[][] } | null>`.
  - Ort ist eine Fläche (`ST_Dimension(geo_objects.geom) = 2`) und `anchor_area.outputs.water` ist nicht leer: die
    Ringe des Wassers.
  - Sonst `harbour_structures` innerhalb `pierRadiusM`: `ST_ConvexHull` der um `pierBufferM` gepufferten Geometrien.
  - Sonst `null`.
- **Kamera:** `planHarbour(db, input, floorZoom: ZoomLevel, cfg)` liefert `Promise<RenderCamera | null>`.
  - `fitCamera` mit Werten aus `composition.harbour`;
  - `minHeightM = camera.zooms[floorZoom].heightM`;
  - Azimute über `candidateAzimuths(baseAzimuthFor(input) ?? 0, rotateStepDeg)`;
  - die erste Kamera, deren Bodenpunkt nicht auf Land liegt (`firstOverWater` aus `render-plan.ts` exportieren).

- [ ] **Step 1: Failing tests**
  - `a polygon marina uses its water area`.
  - `a point marina uses the hull of structures within 300 m, a structure 400 m away is ignored`.
  - `a polygon marina whose water is empty falls back to structures` (Review Focus 2).
  - `no focus gives null`.
  - `planHarbour keeps every focus corner inside the safe area`: über `projectGround`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** grün.
- [ ] **Step 5:** Commit `feat(images): harbour focus from basin or piers (spec 19)`.

### Task 6: Ankerfenster

**Files:**
- Create: `lib/domain/images/anchor-window.ts`
- Modify: `config/images.json`, Schema
- Test: `lib/domain/images/__tests__/anchor-window.test.ts`

**Interfaces:**
- **Config `composition.anchorWindow`:** wörtlich aus Spec 19, mit `fill` 0.6.
- **Küstenrichtung:** `coastDirection(db, origin: LonLat, cfg)` liefert `Promise<{ bearingDeg: number; shore: LonLat; shoreM: number } | null>`.
  - Je Strahl das erste Land (die bestehende `landDistances` aus `render-plan.ts` exportieren).
  - Mittel der Einheitsvektoren mit Gewicht `1 / max(d, minRayM)`.
  - Uferpunkt ist das erste Land in dieser Richtung, sonst das nächste Land.
  - `null` ohne Land in `rayMaxM`.
- **Plan:** `planAnchorWindow(db, input: PlaceImageInput, floorZoom: ZoomLevel, cfg)` liefert
  `Promise<{ camera: RenderCamera; score: number; water: number } | null>`.
  - Alle Kombinationen aus `radiiM × tilts × centres × Azimut (±spanDeg, Schritt rotateStepDeg)`.
  - `fitCamera` mit Fokus Fensterkreis + Uferkreis.
  - Bodenpunkt über Wasser, `predictShares`, Bewertung nach Spec 19.
  - Highlights: `geo_objects` vom Typ `poi`, `category` in `highlightWeights`, innerhalb `highlightReachM`, im Bild
    (`projectGround`, |x|, |y| ≤ 0,95).
  - Bei gleicher Bewertung gewinnt die frühere Kombination (feste Reihenfolge).

- [ ] **Step 1: Failing tests** (U-Bucht aus drei Landrechtecken: Westufer, Ostufer, Buchtscheitel im Norden 300 m vom
  Ankerpunkt; das Westufer 120 m nah):
  - `coast direction points into the bay head, not to the nearer side shore`: Peilung 0° ± 20°.
  - `the window camera looks into the bay and predicts water near 0.45`: Blickrichtung ±30° um Nord; `water` zwischen 0,3
    und 0,6.
  - `open sea without land within 1500 m gives null` (Review Focus 1).
  - `a highlight in view lowers the score`: ein `food`-POI am Buchtscheitel macht die Bewertung kleiner als ohne.
  - `same input gives the same camera twice`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** grün.
- [ ] **Step 5:** Commit `feat(images): anchor window along the coastline (spec 19)`.

### Task 7: `planView` in Plan und Job

**Files:**
- Modify: `lib/domain/images/render-plan.ts`, `lib/pipeline/images/generate.ts` (`initialZoom`, `resolveView`,
  `generatePlaceImage`), `lib/pipeline/images/stage.ts:60-75`
- Test: `lib/domain/images/__tests__/render-plan.test.ts`, `lib/pipeline/images/__tests__/stage.test.ts`,
  `lib/pipeline/images/__tests__/generate.test.ts`

**Interfaces:**
- **Einstieg:** `planView(db, input: PlaceImageInput, view: ImageView, zoom: ZoomLevel, cfg)` liefert
  `Promise<RenderPlan>`.
  - Automatische Ansicht (`view.zoom === undefined && view.azimuthDeg === undefined`):
    - Marina/Hafen: `planHarbour`;
    - Ankerplatz/Bojenfeld: `planAnchorWindow`;
    - je `null` → `planRender(db, input, zoom, cfg, null)`.
  - Sonst `planRender` wie bisher.
  - `ImageView` wandert nach `lib/domain/images/render-plan.ts` (generate re-exportiert).
- **Zoom:** `titleZoomFor` nimmt als gewünschte Stufe `composition.fit.floorZoom` und gibt die feinste erlaubte Stufe bis
  dorthin zurück. Der Zoom ist damit die Untergrenze der Höhe. Für Sentinel-2 allein bleibt es z1 (Review Focus 5).
- **Aufrufer:** `generatePlaceImage`, `resolveView` und `imageTargets` rufen `planView` statt `planRender`.

- [ ] **Step 1: Failing tests**
  - `the automatic title of a marina with a basin uses the fitted camera, a view with zoom uses camera-3`.
  - `plan and job agree on the key for a marina with a basin and for an anchorage` (Muster
    `lib/pipeline/images/__tests__/stage.test.ts:138`; Review Focus 3).
  - `with only Sentinel-2 imagery the fitted camera is at least z1 high` (Muster `stage.test.ts:122`).
  - Bestehende Erwartungen an `camera-3` für die Titelansicht auf `camera-4` und die neue Kamera umstellen; Tests für
    weitere Ansichten bleiben.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** `npx vitest run lib/domain/images lib/pipeline/images` grün.
- [ ] **Step 5:** Commit `feat(images): automatic title camera from the outline, camera-4 (spec 19)`.

### Task 8: Licht nach Stadt im Bild, Prompt v2, ohne Komposition „bei einer Stadt“

**Files:**
- Modify:
  - `lib/domain/images/light.ts`, `prompt.ts`, `camera-label.ts`, `place-info.ts`;
  - `lib/pipeline/images/generate.ts` (`keyFor`, `base`/`light` nach der Kamera);
  - `config/images.json`: `light.townPlaces` `["town", "city"]`, `light.nearTown` `"evening"`,
    `light.townInFrameMargin` 0.05;
  - entfernen: `composition.nearTown`, `scene.near_town`;
  - `config/models.json` (`promptVersion` 2), Schema;
  - `render-plan.ts`: `nearTownCamera`, `nearTownSamples`, der Zweig `near_town` fallen weg.
- Create: `config/prompts/generate-place-image/v2.md`
- Test: `lib/domain/images/__tests__/light.test.ts`, `prompt.test.ts` (+ Snapshot), `camera-label.test.ts`,
  `place-info.test.ts`, `lib/pipeline/images/__tests__/generate.test.ts`

**Interfaces:**
- **Licht:** `lightFor(input: Pick<PlaceImageInput, "kind" | "town">, camera: RenderCamera | null, cfg: Pick<ImagesConfig, "light">): ImageryLight`.
  - Marina/Hafen: `byKind`.
  - Ankerplatz/Bojenfeld: `nearTown`, wenn `town` gesetzt ist und `projectGround(camera, [town])` innerhalb
    `1 − townInFrameMargin` liegt; sonst `byKind`.
  - `camera` null → `byKind`.
- **Schlüssel:** `keyFor(input, view, imageryTileIds, light, cfg)` mit dem Licht als Parameter.
- **Prompt:** `buildPlacePrompt(input, light, watermarked, cfg)` mit der Blockfolge
  `scene, preserve, <boats>, hazards, do_not_add, artefacts, [artefacts_watermark], regenerate, light_<light>`.
  - `<boats>` ist `boats_keep` für Marina/Hafen oder Abend, sonst `boats_remove`.
  - Szene je Ortsart.
- **Bezeichnung:** `compositionFor` und der Typ `Composition` entfallen. `imageTypeLabel(place)` liefert nur noch die
  Ortsart: „Ankerplatz“, „Bojenfeld“, „Marina“, „Hafen“; Aufrufer in `app/(admin)/places/[id]/image-tab.tsx` und
  `app/(admin)/review/[id]/place-image-decision.tsx` anpassen.
- **`v2.md`:** Kopie von `v1.md` mit diesen Änderungen:
  - ohne `boats_near_town` und `composition_near_town`;
  - `boats_remove`: „Remove all boats and people; where a boat was, show open water and its sea bottom.“
  - `do_not_add` ergänzt: „Nothing stands or floats on the water that the render does not show as such: no buildings,
    huts or platforms on the water.“
  - neuer Block `hazards`: „Keep fish farms (cages, rings), mussel lines, mooring buoys and navigation buoys exactly where
    the render shows them, same size, rendered as real installations: they are hazards to boats and are never removed,
    also when boats are removed.“

- [ ] **Step 1: Failing tests**
  - Licht:
    - `an anchorage with a town in frame is evening, with the town outside the frame midday`;
    - `a village does not count` (über `loadPlaceImageInput` mit `place=village` → `town` null);
    - `marina is evening without a camera` (Review Focus 4).
  - Prompt:
    - `prompt v2 contains hazards for every kind and light`;
    - `an evening anchorage keeps boats, a midday one removes them`;
    - `no near_town block exists`;
    - Snapshot neu.
  - Bezeichnung: `imageTypeLabel` nach Ortsart.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren. In `generatePlaceImage` Licht, Alt-Text und `base` erst nach der Kamera bestimmen. Ein
  Ort ohne Wasserblick (`noWaterView`) hat `light = lightFor(place, null, …)`.
- [ ] **Step 4:** `npm run typecheck && npx vitest run lib/domain/images lib/pipeline/images` grün.
- [ ] **Step 5:** Commit `feat(images): light by town in frame, prompt v2 with hazards, no near-town composition (spec 19)`.

### Task 9: Detailfenster nach Bodenabdruck

**Files:**
- Modify:
  - `lib/domain/images/window.ts`;
  - `lib/pipeline/images/generate.ts` (`atTarget`);
  - `lib/pipeline/images/imagery.ts:136`;
  - `lib/pipeline/images/render.ts:185`;
  - `config/images.json` (`window.coreMarginM` 200, `window.coreMaxSizeM` 3000), Schema.
- Test: `lib/domain/images/__tests__/window.test.ts` (neu), `lib/pipeline/images/__tests__/imagery.test.ts`

**Interfaces:**
- **Fenstergröße:** `coreSizeFor(camera: RenderCamera, cfg: Pick<ImagesConfig, "window">): number`.
  - Grundlage: die Bodenpunkte der NDC `(±1, −1)`, `(±1, −1/3)` und `(0, 0)`, ermittelt mit `groundAt`.
  - Größe = `2 · max(|Abstand zum Ziel|) + 2 · coreMarginM`, begrenzt auf `[coreSizeM, coreMaxSizeM]`.
- **Fenster:** `coreWindow(lon, lat, cfg, sizeM = cfg.coreSizeM)`.
- **Weitergabe:** `atTarget` setzt `coreSizeM` auf dem Zielobjekt. `ensureImagery` (`currentAerialTiles` ebenso) und
  `renderAndStore` lesen `place.coreSizeM ?? cfg.window.coreSizeM`.

- [ ] **Step 1: Failing tests**
  - `a camera at 365 m and 40° needs more than 1.5 km`.
  - `a camera at 100 m stays at coreSizeM`.
  - `the size never exceeds coreMaxSizeM`.
  - `imagery requests the larger window`: Kachel-Bbox im Imagery-Test.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** grün; Plan/Job-Schlüsseltest aus Task 7 bleibt grün.
- [ ] **Step 5:** Commit `feat(images): core window from the camera footprint (spec 19)`.

### Task 10: Vorschau ohne Bildmodell, Gesamtprüfung, Runbook

**Files:**
- Create: `scripts/preview-title-renders.ts` (eingecheckt, klein: Landesteil → `planView` + Render → JPEG je Ort, ohne
  Bildmodell)
- Modify: `docs/pilot/m7-runbook.md` (Bildlauf: zuerst Datensatz `harbour_structures`, dann Bilder; `camera-4` und
  Prompt v2 erzeugen alle Titelbilder neu, Kosten), Spec 19 Status

- [ ] **Step 1:** Skript schreiben. Aufruf:
  `npx tsx --env-file=.env.local scripts/preview-title-renders.ts GR-I [--out ~/Downloads/ortsbilder-vorschau]`.
  Je Ort ein JPEG mit Fußzeile: Ortsart, Name, Licht, Höhe.
- [ ] **Step 2:** Lokal: `harbour_structures` für GR-I laden (Datensatzlauf lokal), Vorschau für GR-I erzeugen.
  Christian sieht die Renderings durch (Spec 19, „Prüfung vor dem Ausrollen“). Befunde beheben, bevor es weitergeht.
- [ ] **Step 3:** `npm run lint && npm run typecheck && npm test` grün.
- [ ] **Step 4:** Commit `docs,chore: preview of title renders, runbook for camera-4 (spec 19)`.
- [ ] **Step 5:** Ein Reviewer prüft den ganzen Branch (`superpowers:requesting-code-review`). Befunde beheben.

### Task 11: Sammel-Merge und Produktion

- [ ] **Step 1:** `origin/fix/emodnet-seabed-workspace` (PR 38) und `origin/fix/convert-empty-document` (PR 39) in
  `feat/bildausschnitt` mergen; Konflikte lösen; `npm test` grün.
- [ ] **Step 2:** PR `feat/bildausschnitt` → `main` öffnen. Die Beschreibung nennt, dass PR 38 und 39 enthalten sind. CI
  abwarten (static, test 1–3, e2e).
- [ ] **Step 3:** Merge (Merge-Commit) in `main`. Das ist ein Push auf `main` und damit ein Deploy. PR 38 und 39 schließt
  GitHub als „merged“; sonst mit Verweis schließen.
- [ ] **Step 4:** Deploy prüfen: MCP `version` zeigt den Merge-SHA, die neue Migration, `camera-4` und `promptVersion` 2.
- [ ] **Step 5:** MCP `datasets_start` für GR-I, Datensatz `harbour_structures`. Erst ohne `confirm` (Umfang, Schätzung),
  Christian bestätigt, dann starten und abwarten.
- [ ] **Step 6:** MCP `images_start` für GR-I. Erst ohne `confirm`: Anzahl Orte × bis zu 2 Versuche × 0,25 € nennen,
  Christian bestätigt. Danach Lauf verfolgen (`runs`), Fehler über `job_retry`.
- [ ] **Step 7:** Stichprobe der Prüfaufgaben `place_image` (MCP `review_tasks`). Die Freigabe macht Christian in der
  Oberfläche.
