# Periplus 13 – Ortsbilder (Stufe 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every settled Greek spot gets a reviewed title image. The pipeline drapes the open cadastre orthophoto (Sentinel-2 around it) on the Copernicus DEM, renders a 30° oblique view from the water, has GPT Image turn the render into a catalogue photo, checks the geometry, and delivers the approved image as optional `image` in contract 2.1.

**Architecture:** Imagery adapters fill `imagery_tiles` (archive first, S3 `imagery/<source>/<tile>`). A pure render plan in `lib/domain/images/` picks the camera, zoom and light. A three.js scene runs in the worker's headless Chromium and writes photo and mask (`place_renders`). An OpenAI image adapter produces the illustration. The water IoU and a watermark check decide whether to retry, and a `place_image` review task carries the candidate. Approval writes `place_images`, and the delivery build copies the JPEG into the package. All of it is one stage `images.place` that runs after consolidation and through its own starter.

**Tech Stack:** Next.js 16 (App Router, server actions), TypeScript, Drizzle + hand-written SQL migrations, Postgres/PostGIS, pg-boss, zod 4, vitest against `periplus_test`, Playwright Chromium (runtime), new deps `three`, `geotiff`, `sharp`.

**Spec:** `docs/superpowers/specs/2026-10-20-periplus-13-ortsbilder-design.md`, Stufe 1 only (Teil A for Greece, B, C, D, contract, data model, config, pipeline, UI). Not in this plan: Teil E (photos, appearance facts), UP42/Vantor, adapters for other countries, edge-based geometry check (open point).

**Prerequisite:** `feat/raumgliederung` (Plan 14a) is merged into `main`. This plan uses `subdivisions` (`country`, `key`), contract 2.0, `geo_objects.subdivision_id` and the page `/subdivisions/[key]` from 14a. Work happens in the worktree branch `feat/ortsbilder` cut from that `main`.

## Global Constraints

- Code, identifiers, tables, API, contract, prompts: English. UI copy: German („Titelbild“, „KI-Illustration“, „Luftbild“, „Rendering“, „Maske“, „Licht: Mittag | Abend“).
- Domain logic only in `lib/domain/images/` and `lib/pipeline/images/`; job handler, pages and routes stay thin. External services only through adapters in `lib/adapters/`.
- Thresholds, camera, light rules, sources, prompts and budgets live in `config/`, not in code.
- Tests never call the network. Use recorded HTTP fixtures (`fixtureTransport`) for WMS/DEM, `MockModel` for Anthropic and `MockImageModel` for OpenAI. Tests run against real Postgres in `withRollback`, and committed geo rows lie outside 23.0–23.75 E × 37.0–38.0 N.
- Stable tables reject DELETE and record history (pattern `drizzle/0054_subdivisions_triggers.sql`). Append-only tables use `forbid_mutation('')` plus `_no_truncate`.
- Stufe 1: only Greece (`images.sources.ktimatologio.countries = ["GR"]`), only free data, and `images.delivery.ktimatologio = false` until the cadastre confirms the licence in writing. Images are generated and reviewed, but none is delivered.
- Camera: tilt 30°, vertical field of view 50°, 1536 × 1024. Zoom heights are z1 260 m, z2 160 m and z3 100 m, and the horizontal distance is `height / tan(30°)`. Rotation step is 10°, and `render.maxSourcePixelOnScreen = 5`.
- Model: `gpt-image-2.5-sunburst` via `v1/images/edits`, size `1536x1024`, quality `high`, task `generate-place-image`.
- Water IoU thresholds are midday 0.80 and evening 0.60. Generation runs at most twice (one retry), then the task goes to review.
- `kind = "ai_illustration"`, and alt text starts with „KI-Illustration:“. A new image is generated only when the aerial image, prompt version, model or place kind changes, never per run.
- Before touching routes, `proxy.ts` or `next.config.ts`, read the Next 16 docs in `node_modules/next/dist/docs/`.
- Finish each task with `npx vitest run <touched test files>`, `npm run typecheck` and `npm run lint` before the commit.

## Review Focus

1. **No open water to look from.** Some places have no camera position over water: an enclosed harbour basin whose `opening_bearing` is null, or a position where every 10° step up to 360° stays over land. The expected behaviour is a fallback to the bearing of the longest fetch ray. If that also fails, the place gets a `place_image` task without a candidate (reason `no_water_view`, only „Kein Bild“/„Neu erzeugen“) and the stage does not crash. Tests are in Task 4 and Task 8.
2. **Window across tile boundaries.** The 1.5 km window or the ±0.06° wide area crosses a 1° DEM tile boundary (e.g. a place at 22.99° E). Both DEM tiles are loaded and merged, with no seam of height 0. Tests are in Task 3 and Task 5.
3. **Broken orthophoto responses.** The WMS returns a `ServiceException` XML with status 200, or an all-white image outside the cadastre's coverage. XML is a `HttpError` with the exception text, and nothing goes into the archive. An all-white image counts as no coverage: the place renders with Sentinel-2 only, and the render records `imageryTileIds` without a cadastre tile. Tests are in Task 3.
4. **Stale approval.** A reviewer approves a candidate after a newer generation has replaced the task context (new prompt version, regeneration from another tab). The expected result is `TaskContextChanged`, and `place_images` stays unchanged. The test is in Task 9.
5. **Delivery switch.** With `images.delivery.ktimatologio = false`, an approved image whose render used a cadastre tile is not delivered, and the spot's `profileVersion` does not change. After the switch is flipped, the next package delivers it without regenerating, and `profileVersion` rises once. Tests are in Task 10.

---

### Task 1: Configuration, dependencies, environment

**Files:**
- Create: `config/images.json`, `config/prompts/generate-place-image/v1.md`, `config/prompts/check-place-image/v1.md`
- Modify: `lib/config/schemas.ts` (`imagesSchema`, `ImagesConfig`, `AppConfig.images`, `BUDGET_SERVICES` + `"openai"`, `modelsSchema` + `imageTasks` + `pricesEurPerImage`), `lib/config/index.ts`, `config/models.json`, `config/budgets.json`, `lib/env.ts` (`OPENAI_API_KEY` optional), `.env.example` if present, `package.json` (`three`, `@types/three`, `geotiff`, `sharp`)
- Test: `lib/config/__tests__/images.test.ts`

**Interfaces:**
- Produces: `getConfig().images: ImagesConfig`; `ImagesConfig["sources"][S]` with `S = "ktimatologio" | "sentinel2" | "copernicus_dem"`; `ImageryLight = "midday" | "evening"`; `ZoomLevel = "z1" | "z2" | "z3"`; `getConfig().models.imageTasks["generate-place-image"]: { model: string; promptVersion: number; size: "1536x1024"; quality: "low"|"medium"|"high" }`; `getConfig().models.pricesEurPerImage[model]: { high: number; medium: number; low: number }`; `BudgetService` includes `"openai"`.

`config/images.json`. The values come from the spec and the tests of 20.10.2026:

```json
{
  "sources": {
    "ktimatologio": { "kind": "wms", "countries": ["GR"], "url": "http://gis.ktimanet.gr/wms/wmsopen/wmsserver.aspx", "layer": "BASEMAP", "format": "image/jpeg", "resolutionM": 0.5, "maxRequestPx": 2048, "watermarked": true, "license": "CC-BY-3.0", "attribution": "Luftbild © Hellenic Cadastre (CC BY 3.0)", "acquiredAt": null, "timeoutSeconds": 60, "ratePerMinute": 30 },
    "sentinel2": { "kind": "wms", "countries": "*", "url": "https://tiles.maps.eox.at/wms", "layer": "s2cloudless", "format": "image/jpeg", "resolutionM": 10, "maxRequestPx": 2048, "watermarked": false, "license": "CC-BY-4.0", "attribution": "Sentinel-2 cloudless 2016 © EOX (CC BY 4.0)", "acquiredAt": "2016-07-01", "timeoutSeconds": 60, "ratePerMinute": 30 },
    "copernicus_dem": { "kind": "cog", "countries": "*", "urlTemplate": "https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif", "resolutionM": 30, "license": "Copernicus-DEM", "attribution": "Gelände © DLR/Airbus, Copernicus", "acquiredAt": null, "timeoutSeconds": 300, "ratePerMinute": 10, "maxBytes": 120000000 }
  },
  "delivery": { "ktimatologio": false, "sentinel2": true, "copernicus_dem": true },
  "window": { "coreSizeM": 1500, "wideMarginDeg": 0.06, "coreGridM": 4, "wideGridM": 15, "wideSinkM": 3, "whiteThreshold": 245 },
  "camera": { "tiltDeg": 30, "fovDeg": 50, "width": 1536, "height": 1024, "rotateStepDeg": 10, "defaultZoom": "z1",
              "zooms": { "z1": { "heightM": 260 }, "z2": { "heightM": 160 }, "z3": { "heightM": 100 } } },
  "render": { "maxSourcePixelOnScreen": 5, "rendererVersion": "render-1", "timeoutSeconds": 120 },
  "light": { "townRadiusM": 1000, "townPlaces": ["town", "village"],
             "byKind": { "anchorage": "midday", "mooring_field": "midday", "marina": "evening", "port": "evening" } },
  "scene": {
    "anchorage": { "en": "a sheltered bay with its shore, beach or rocks and the slopes behind", "de": "Bucht mit Ufer und Hängen" },
    "mooring_field": { "en": "a bay with a mooring buoy field, its shore and the slopes behind", "de": "Bucht mit Bojenfeld" },
    "marina": { "en": "a marina with harbour basins, breakwaters and floating pontoons", "de": "Marina mit Becken und Stegen" },
    "port": { "en": "a harbour town with its quay, waterfront promenade and houses", "de": "Hafenort mit Kai und Promenade" }
  },
  "check": { "minWaterIoU": { "midday": 0.8, "evening": 0.6 }, "maxAttempts": 2, "waterColour": { "blueOverRedMin": 25, "greenTolerance": 10 } },
  "pipeline": { "maxGenerationsPerRun": 50 },
  "output": { "jpegQuality": 85, "license": "periplus", "credit": "Illustration: Periplus", "altPrefix": "KI-Illustration:" }
}
```

`config/models.json` gets `"imageTasks": { "generate-place-image": { "model": "gpt-image-2.5-sunburst", "promptVersion": 1, "size": "1536x1024", "quality": "high" } }` and `"pricesEurPerImage": { "gpt-image-2.5-sunburst": { "low": 0.02, "medium": 0.07, "high": 0.25 } }`. It also gets the text task `"check-place-image": { "model": "claude-haiku-5-5", "promptVersion": 1, "effort": "low", "maxTokens": 512 }` with its token price. `config/budgets.json` gets `"openai": { "dailyEur": 10 }`.

`config/prompts/generate-place-image/v1.md` uses one `## <block>` section per block. The wording was tested on 20.10.2026; keep it verbatim. `{{scene}}` is filled by code.

```markdown
## scene
Turn this 3D terrain render of a real Greek place - {{scene}} - into a high-end travel catalogue drone photograph.

## preserve
Preserve exactly:
- camera position, 30° downward angle, field of view and framing; the edges of the image show exactly the same content as the render
  (do not zoom out, do not reveal more sky or horizon);
- the shape and position of the coastline, breakwaters, moles, piers and quays, streets, buildings and hills;
- which areas are forest, open ground, built-up, beach and water;
- the existing small structures: keep them, same size and place, rendered as real buildings.

## boats_remove
Remove all boats and people.

## boats_keep
The boats: wherever the render shows boats or yachts, keep them in the same places, same sizes and density, and render them as real
boats; moored boats stay moored along their pontoons and quays. No additional boats in places where the render shows none.

## do_not_add
Do not add anything that is not in the render: no new buildings, piers, breakwaters, roads, islands or rocks.

## artefacts
The render is low resolution and partly pixelated or smeared - this is only an artefact of the source data. Do not reproduce square
blocks, grids or smearing; use the render only for layout, shapes and colours.

## artefacts_watermark
Remove the semi-transparent overlay band and any logo. No text, no watermark.

## regenerate
Regenerate every surface as a real photograph at full detail - do not soften or upscale the render: individual trees, rocks, pebbles,
buildings with roofs and windows, boat hulls, clear water showing the sandy bottom and dark seagrass meadows.
Colours vivid but true to life, like a professional photo with a polarising filter - not oversaturated, no HDR halos.

## light_midday
Light: perfect late morning in high summer, sun high and slightly from behind the camera, crisp short shadows, brilliant turquoise
shallows over sand, deep sapphire open sea with fine sparkles, saturated blue sky.

## light_evening
Light: late evening, about twenty minutes after sunset. The sun is gone; the sky glows from warm orange and pink near the western
horizon to deep blue above. Soft, even light without hard shadows. The first lights are on: warm windows in the houses, street lamps
along the promenades and roads, small lights on the piers and pontoons, their reflections shimmering on the calm, dark-blue water.
A few people strolling on the promenades. Rich but believable colours, no long-exposure light trails.
```

`config/prompts/check-place-image/v1.md` has `## system` and `## user` sections. It asks whether the attached image shows any text, logo or semi-transparent band, and the answer is JSON `{ "watermarkVisible": boolean, "note": string }`.

- [ ] **Step 1: Write the failing tests** `images config loads with spec values` (asserts `camera.tiltDeg === 30`, `camera.zooms.z1.heightM === 260`, `check.minWaterIoU.midday === 0.8`, `delivery.ktimatologio === false`), `delivery switch needs every source`, which rejects an `images.delivery` object missing a key of `sources`, and `image task needs a per-image price`, which rejects an `imageTasks` model missing from `pricesEurPerImage`.
- [ ] **Step 2: Run** `npx vitest run lib/config/__tests__/images.test.ts`. Expected: FAIL (`images` missing).
- [ ] **Step 3: Implement** the schemas as `z.strictObject` (sources as a record over the three keys, `countries: z.array(z.string().length(2)).or(z.literal("*"))`, `light.byKind` over `placeKindEnum.enumValues`, `scene` over the same). Load and re-export them, then install the deps with `npm i three geotiff sharp && npm i -D @types/three`.
- [ ] **Step 4: Run** the test, `npm run typecheck` and `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(config): images.json, generate-place-image prompt blocks, OpenAI image task and budget (spec 13)`

### Task 2: Schema – `imagery_tiles`, `place_renders`, `place_images`, review kind

**Files:**
- Create: `lib/db/schema/images.ts`, `drizzle/00NN_images_schema.sql` (generated), `drizzle/00NN+1_images_triggers.sql` (custom). Use the next free numbers after 14a.
- Modify: `lib/db/schema/index.ts`, `lib/db/schema/review.ts` (`reviewKindEnum` + `"place_image"`), `app/(admin)/review/kinds.ts` (`REVIEW_KIND_HELP.place_image`), `app/(admin)/_components/labels.ts` (`REVIEW_KIND_LABELS.place_image = "Titelbild"`), `lib/domain/review-view.ts` (`reviewCounts`)
- Test: `lib/db/__tests__/images-schema.test.ts`

**Interfaces:**
- Produces: the tables `imageryTiles`, `placeRenders` and `placeImages`, plus the enums `imagerySourceEnum` (`ktimatologio`, `sentinel2`, `copernicus_dem`, `pnoa`, `ign_fr`, `dgu_hr`, `vantor`), `placeImageKindEnum` (`photo`, `ai_illustration`) and `imageLightEnum` (`midday`, `evening`). The columns are those of the spec section „Datenmodell“, with these additions and precisions:
  - `imagery_tiles`: `bbox geometry(Polygon,4326)`, `tile_key text`, unique `(source, tile_key) where valid_to is null`, `bytes int`, `blank bool` (all-white WMS answer), `valid_from`/`valid_to`, history on `valid_to,file_key,blank`.
  - `place_renders`: `camera jsonb` = `RenderCamera` (Task 4), `zoom text`, `imagery_tile_ids uuid[]`, `dem_tile_ids uuid[]`, `photo_key`, `mask_key`, `depth_key null`, `renderer_version`, `generation_key text`, `run_id`, `created_at`.
  - `place_images`: unique `(geo_object_id, kind) where valid_to is null`, `alt text` (German), `file_key`, `width`, `height`, `generation_key`, history on `valid_to`.

- [ ] **Step 1: Write the failing tests:**
  - `place_renders is append-only` (UPDATE raises `is append-only`)
  - `imagery_tiles and place_images refuse delete` (`rows are never deleted`)
  - `one current image per object and kind` (a second current row violates the unique index; ending the first with `valid_to` allows it)
  - `review kind place_image exists` (`createReviewTask` with kind `place_image` succeeds)
- [ ] **Step 2: Run** → FAIL. **Step 3:** write the schema, then `npm run db:generate`. Write the trigger migration with `drizzle-kit generate --custom --name images_triggers`, following `0054_subdivisions_triggers.sql`. Add `ALTER TYPE "public"."review_kind" ADD VALUE 'place_image'` to the generated migration (precedent `0053`). Then run `npm run db:migrate` and migrate the test DB.
- [ ] **Step 4: Run** → PASS. Typecheck forces the `Record<ReviewKind, …>` maps to be completed.
- [ ] **Step 5: Commit** `feat(db): imagery_tiles, place_renders, place_images and review kind place_image (spec 13)`

### Task 3: Imagery adapters and `ensureImagery`

**Files:**
- Create: `lib/adapters/wms.ts`, `lib/adapters/copernicus-dem.ts`, `lib/pipeline/images/imagery.ts`, `lib/domain/images/window.ts`
- Modify: `scripts/fixtures-record.ts` (mode `--imagery <lon> <lat>`)
- Test: `lib/adapters/__tests__/wms.test.ts`, `lib/adapters/__tests__/copernicus-dem.test.ts`, `lib/pipeline/images/__tests__/imagery.test.ts`; fixtures in `test/fixtures/http/ktimatologio/`, `…/sentinel2/`, `…/copernicus_dem/` recorded for one place outside the pilot box (e.g. Poros, 23.4535 E 37.4985 N) and one place near 22.99 E (Review Focus 2). Crop the DEM fixture to a small COG with `gdal_translate`, outside the repo code, and commit only the result.

**Interfaces:**
- Produces:
  - `type Bbox = [west: number, south: number, east: number, north: number]`
  - `coreWindow(lon, lat, cfg): Bbox` (square of `coreSizeM`) and `wideWindow(lon, lat, cfg): Bbox` (± `wideMarginDeg` in lon, ± `wideMarginDeg * 0.75` in lat, as in the tests), both in `window.ts`
  - `wmsGrid(bbox, resolutionM, maxRequestPx): Array<{ bbox: Bbox; width: number; height: number; tileKey: string }>`: splits into n×n requests of at most `maxRequestPx`. `tileKey` = `<z>/<west>_<south>` rounded to 1e-5, so it is stable for the same place.
  - `fetchWmsImage(transport, req: { url; layer; format; bbox; width; height }, ctx: CallContext, service: string): Promise<Uint8Array>`: WMS 1.1.1, `srs=EPSG:4326`, `styles=`. It throws `HttpError` with the exception text when the body is not JPEG/PNG (magic bytes).
  - `isBlankImage(bytes, whiteThreshold): Promise<boolean>`: true when every pixel's min channel ≥ threshold (sharp `stats`)
  - `demTileNames(bbox): string[]`: `Copernicus_DSM_COG_10_N37_00_E023_00_DEM`. Negative coordinates use `S`/`W` and floor.
  - `fetchDemTile(transport, name, ctx, cfg): Promise<Uint8Array>`: TIFF magic check, `maxBodyBytes = cfg.maxBytes`
  - `ensureImagery(db, archive, transport, place: { geoObjectId; lon; lat; country }, ctx): Promise<ImagerySet>` with `ImagerySet = { core: ImageryTileRef[]; wide: ImageryTileRef[]; dem: ImageryTileRef[]; coreSource: "ktimatologio" | null }` and `ImageryTileRef = { id; source; bbox: Bbox; fileKey; resolutionM; acquiredAt: string | null; blank: boolean }`

Archive-first: a current `imagery_tiles` row with the same `(source, tile_key)` and an existing archive key is reused without a request. Keys are `imagery/<source>/<tileKey>.<jpg|tif>`, cost is 0 €, and `external_calls` are recorded by `httpCall`. `coreSource` is null when the country has no source or every core tile is blank.

- [ ] **Step 1: Write the failing tests:**
  - `wmsGrid splits 1500 m at 0.5 m into 2×2 requests of 1500 px`
  - `demTileNames covers both tiles for a window across 23° E`
  - `demTileNames handles south and west`
  - `fetchWmsImage turns ServiceException XML into HttpError` (Review Focus 3)
  - `blank cadastre tile is stored with blank=true and coreSource is null` (Review Focus 3)
  - `ensureImagery reuses archived tiles without a request` (a transport that throws on use)
  - `country without source gets Sentinel-2 and DEM only`
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Pass `budget` only for paid sources (none in Stufe 1).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(images): WMS and Copernicus DEM adapters, imagery window and archive-first ensureImagery (spec 13)`

### Task 4: Render plan and light rule

**Files:**
- Create: `lib/domain/images/render-plan.ts`, `lib/domain/images/light.ts`, `lib/domain/images/place-input.ts`
- Test: `lib/domain/images/__tests__/render-plan.test.ts`, `lib/domain/images/__tests__/light.test.ts`, `lib/domain/images/__tests__/place-input.test.ts`

**Interfaces:**
- Consumes: `opening_bearing` fact (`{ bearingDeg: number | null; widthDeg }`) and the latest `fetch` computation `outputs.rays: number[72]` (ray i = bearing `i * 5°`), `land_polygons`.
- Produces:
  - `type RenderCamera = { target: [lon, lat]; azimuthDeg: number; heightM: number; distanceM: number; tiltDeg: number; fovDeg: number; width: number; height: number; zoom: ZoomLevel }`. `azimuthDeg` is the bearing from the target to the camera, and the view direction is `azimuthDeg + 180`.
  - `baseAzimuth(openingBearing: number | null, rays: number[] | null, rayStepDeg: number): number | null`: the opening bearing, else the bearing of the longest ray, else null
  - `candidateAzimuths(base: number, stepDeg: number): number[]`: `base, base+10, base−10, base+20, …` up to ±180, normalised to [0, 360)
  - `cameraFor(target, azimuthDeg, zoom, cfg): RenderCamera`, with `distanceM = heightM / tan(tiltDeg)`
  - `foregroundPixelSize(resolutionM, zoom, cfg): number`: `resolutionM * f / d` with `f = (height/2) / tan(fov/2)` and `d = heightM / sin(tilt + fov/2)`
  - `allowedZooms(resolutionM, cfg): ZoomLevel[]`: the levels with `foregroundPixelSize ≤ maxSourcePixelOnScreen`; z1 is always included
  - `planRender(db, input: PlaceImageInput, zoom: ZoomLevel, cfg): Promise<{ ok: true; camera: RenderCamera } | { ok: false; reason: "no_water_view" }>`: tries `candidateAzimuths` in order and takes the first whose camera ground point is not in `land_polygons` (one SQL query over all candidates; `ST_Project` from the target)
  - `lightFor(input: PlaceImageInput, cfg): ImageryLight`: `byKind[kind]`, except that an anchorage or mooring field with `nearTown` gets `evening`
  - `type PlaceImageInput = { geoObjectId; publicId; kind: PlaceKind; lon; lat; country; subdivisionKey; openingBearing: number | null; rays: number[] | null; nearTown: boolean }`
  - `loadPlaceImageInput(db, geoObjectId, cfg): Promise<PlaceImageInput | null>`: anchor position (`anchor_position` if set, else `position`), latest facts, `nearTown`. `nearTown` is true when a current `settlement` with `tags->>'place'` in `townPlaces` lies within `townRadiusM` and inside the ground footprint of the default camera (the four image corners projected to height 0). The footprint polygon comes from `cameraFootprint(camera): Array<[lon, lat]>` in `render-plan.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `distance for z1 is 450 m and z2 277 m` (±1 m)
  - `0.5 m allows z1–z3; 10 m allows only z1`
  - `candidate azimuths alternate around the base in 10° steps`
  - `null opening falls back to the longest ray`
  - `rotates until the camera is over water` (fixture land polygon covering the first two candidates)
  - `enclosed place yields no_water_view` (land on all sides; Review Focus 1)
  - `anchorage → midday; marina → evening; anchorage with village in footprint within 1000 m → evening; hamlet does not count; village behind the camera does not count`
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (pure functions without DB except `planRender`/`loadPlaceImageInput`). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(images): render plan with camera over water, zoom limit from resolution and light rule (spec 13)`

### Task 5: Renderer in headless Chromium

**Files:**
- Create: `lib/pipeline/images/render.ts`, `lib/pipeline/images/scene/scene.ts` (browser code, bundled as a string at build time via `esbuild` in `scripts/build-render-scene.ts` → `lib/pipeline/images/scene/scene.bundle.ts` exporting `SCENE_JS: string`; add `npm run images:scene` and call it from `prebuild` and `pretest`), `lib/domain/images/terrain.ts`
- Modify: `lib/adapters/fetch/browser.ts` (export `chromiumLaunchOptions` if not exported; the scene loads no URLs, so the dead proxy stays)
- Test: `lib/domain/images/__tests__/terrain.test.ts`, `lib/pipeline/images/__tests__/render.test.ts` (skipped unless `chromiumInstalled()`)

**Interfaces:**
- Consumes: `ImagerySet` (Task 3), `RenderCamera` (Task 4).
- Produces:
  - `sampleDem(tiffs: Uint8Array[], bbox: Bbox, stepM: number): Promise<HeightGrid>` in `terrain.ts` with `HeightGrid = { bbox; cols; rows; heights: Float32Array }` (row 0 = south). It reads every DEM tile overlapping the bbox (geotiff `readRasters` window, bilinear), clips heights below 0 to 0 and sets values < 0.5 to 0, as in the tests.
  - `renderPlace(input: { camera: RenderCamera; wide: HeightGrid; core: HeightGrid; wideTexture: Uint8Array; coreTextures: Array<{ bbox; bytes }>; whiteThreshold: number; sinkM: number }, deps?: { launchBrowser? }): Promise<{ photo: Uint8Array; mask: Uint8Array }>`: both PNG, 1536 × 1024.
  - `renderAndStore(db, archive, place: PlaceImageInput, camera, imagery: ImagerySet, ctx): Promise<{ renderId: string; photoKey: string; maskKey: string }>`: inserts `place_renders` with keys `imagery/renders/<geoObjectId>/<renderId>/{photo,mask}.png`.

Scene rules (in `scene.ts`, as in the tests):
- local metres around the target (`kx = 111320 cos(lat)`, `ky = 110540`)
- the wide mesh is sunk by `sinkM` under the core window
- the core texture is a mosaic of the core tiles; white no-data pixels touching the edge (min channel ≥ `whiteThreshold`, flood fill from the border) show the Sentinel-2 texture
- a sea plane at −0.4 m, sky gradient `#a9cbe8 → #5b97d3`, sea colour `#245f8c`, ambient 0.6 / diffuse 0.5
- `PerspectiveCamera(fov=50)`, up = z, near 1, far 80 000
- **mask** pass: water (height ≤ 0 and sea plane) = 255, land = 0, sky = 128, no lighting, no antialiasing
- `preserveDrawingBuffer: true`, `canvas.toDataURL("image/png")`

- [ ] **Step 1: Write the failing tests:**
  - `sampleDem merges two tiles without a zero seam` (Review Focus 2; synthetic two-tile GeoTIFFs written with geotiff `writeArrayBuffer`)
  - `negative heights clip to 0`
  - `fixture terrain renders a deterministic mask`: a 2 × 2 km fixture grid, west half 50 m and east half 0. With the camera looking north, the mask has water on the right half (±2 % pixels), sky only in the top rows or none, and two runs give byte-identical masks.
  - `white border of the core texture shows Sentinel-2` (photo pixel at the core corner equals the wide texture colour within ±8)
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, also in the worker Docker image (`docker build -f docker/worker.Dockerfile .`, then run the render test inside it once; SwiftShader WebGL must work headless).
- [ ] **Step 5: Commit** `feat(images): three.js terrain renderer in headless Chromium with photo and land/water mask (spec 13)`

### Task 6: Image model adapter, prompt and alt text

**Files:**
- Create: `lib/adapters/openai-image.ts`, `lib/ai/mock-image.ts`, `lib/domain/images/prompt.ts`
- Modify: `lib/adapters/http.ts` (`body?: string | Uint8Array`; `fixtureKey` hashes bytes), `lib/adapters/http-fixtures.ts`, `scripts/fixtures-record.ts` (mode `--image`)
- Test: `lib/adapters/__tests__/openai-image.test.ts`, `lib/domain/images/__tests__/prompt.test.ts` (+ snapshot files)

**Interfaces:**
- Produces:
  - `interface ImageModel { edit(req: ImageEditRequest, ctx: CallContext): Promise<ImageEditResult> }`
  - `type ImageEditRequest = { task: "generate-place-image"; image: Uint8Array; prompt: string }`
  - `type ImageEditResult = { image: Uint8Array; model: string; promptVersion: number; costEur: number }`
  - `createOpenAiImageModel(transport, config = getConfig()): ImageModel`: multipart body built by hand with the fixed boundary `----periplus-image`, fields `model`, `prompt`, `size`, `quality`, `n=1`, `image` (`render.png`, `image/png`). The response is `data[0].b64_json`. The call uses `budget: "openai"` and `costOf` = `pricesEurPerImage[model][quality]`, and calls `assertNotSimulated("openai","images.edit")`. A missing `b64_json` or a different size throws `ImageOutputInvalid` (exported).
  - `class MockImageModel implements ImageModel`: `constructor(respond: (req) => Uint8Array | Error)`, `calls: ImageEditRequest[]`
  - `buildPlacePrompt(input: PlaceImageInput, light: ImageryLight, watermarked: boolean, cfg): { text: string; promptVersion: number }`: blocks in order `scene, preserve, boats_remove|boats_keep, do_not_add, artefacts, [artefacts_watermark], regenerate, light_<light>`, joined by a blank line. `boats_keep` applies when the kind is `marina`/`port`, or the light is `evening` because of `nearTown`.
  - `loadPromptBlocks(task: string, version: number, dir?): Record<string, string>` in `prompt.ts`. It parses `## <name>` sections and throws for a missing block name.
  - `altText(input, light, cfg): string`: `"KI-Illustration: " + scene[kind].de + ", Blick vom Wasser" + (light === "evening" ? ", am Abend" : "")`. Keep it at ≤ 15 words.

- [ ] **Step 1: Write the failing tests:**
  - `prompt for anchorage removes boats` (snapshot)
  - `prompt for marina keeps boats in evening light` (snapshot)
  - `anchorage near a town keeps boats and uses evening light`
  - `watermark block only for watermarked core imagery`
  - `missing block throws with its name`
  - `alt text starts with KI-Illustration:`
  - `adapter posts multipart with fixed boundary and decodes b64_json` (fixture transport with a recorded 1536×1024 PNG; record once with `fixtures:record --image`)
  - `wrong output size throws ImageOutputInvalid`
  - `budget exceeded stops before the request`
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(images): OpenAI image edit adapter, mock, prompt blocks and alt text (spec 13)`

### Task 7: Checks – water IoU and watermark

**Files:**
- Create: `lib/domain/images/checks.ts`, `lib/ai/tasks/check-place-image.ts`
- Modify: `lib/ai/types.ts` (`ModelAttachment` + `{ kind: "image"; mediaType: "image/png" | "image/jpeg"; data: Uint8Array }`), `lib/ai/anthropic.ts` (send as `image` block)
- Test: `lib/domain/images/__tests__/checks.test.ts`, `lib/ai/__tests__/anthropic.test.ts` (attachment mapping)

**Interfaces:**
- Produces:
  - `waterIoU(mask: Uint8Array, image: Uint8Array, cfg): Promise<number>`: sharp decodes both to raw RGB at 1536 × 1024. A pixel counts as water in the AI image when `b > r + blueOverRedMin && b >= g − greenTolerance`. The IoU is computed only over mask pixels ≠ 128 (sky excluded).
  - `passesGeometry(iou, light, cfg): boolean`
  - `checkPlaceImageTask: ModelTask<{ image: Uint8Array }, { watermarkVisible: boolean; note: string }>`, name `check-place-image`, attachment kind `image`
  - `toJpeg(png: Uint8Array, quality: number): Promise<Uint8Array>`

- [ ] **Step 1: Write the failing tests:**
  - `identical water gives IoU 1`
  - `sky pixels are ignored`
  - `half-shifted coastline gives about 0.33`
  - `0.79 fails midday, 0.61 passes evening`
  - `image attachment is sent as an image block`
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(images): water IoU against the render mask and watermark check with image attachment (spec 13)`

### Task 8: Stage `images.place`, starter and run integration

**Files:**
- Create: `lib/pipeline/images/stage.ts`, `lib/pipeline/images/generate.ts`, `lib/pipeline/images-run.ts`, `lib/jobs/handlers/images.ts`
- Modify: `config/queues.json` (`"images.place": { "concurrency": 2, "retryLimit": 2, "retryDelaySeconds": 120, "retryBackoff": true, "expireInSeconds": 900 }`), `lib/jobs/queues.ts`, `lib/jobs/registry.ts`, `lib/jobs/stages.ts`, `lib/pipeline/consolidation/stages.ts` (append `IMAGES_STAGE` to `CONSOLIDATION_STAGES` and `GEOMETRY_CONSOLIDATION_STAGES`, so text runs, geometry runs and the consolidation run after a review decision (`consolidateAfter`) all end with it; `stagesOnly` runs such as `regenerate_summary` stay without it), `worker/index.ts` (`setImageModelFactory`)
- Create: `lib/pipeline/images/stage-name.ts` (only `export const IMAGES_STAGE = "images.place"`, imported by `consolidation/stages.ts` without an import cycle)
- Test: `lib/pipeline/images/__tests__/generate.test.ts`, `lib/pipeline/images/__tests__/stage.test.ts`

**Interfaces:**
- Consumes: Tasks 3–7.
- Produces:
  - `IMAGES_STAGE = "images.place"`
  - `generationKey(input: { imageryTileIds: string[]; promptVersion: number; model: string; kind: PlaceKind; light: ImageryLight; zoom: ZoomLevel }): string`: `valueFingerprint` of the sorted ids and the other fields
  - `imageTargets(db, run): Promise<Array<{ geoObjectId: string; zoom: ZoomLevel }>>`. In a consolidation, text or geometry run, the candidates are the geo objects this run consolidated (derived the same way `summaryTargets` derives them). In a run from `startImageRun`, they are the subdivision's places or the single place. Of those, it keeps places that are current and unmerged, have status in `delivery.spots.statuses` and a `fetch` computation (without one, the next geometry run brings the place in), and whose subdivision country has a core source. Every kind counts: anchorage, mooring_field, marina and port. It skips a place when one of the following holds for the current key:
    - a current `place_images` row has the same `generation_key`
    - an open `place_image` task has the same key
    - a decided task has the same key (`hasDecidedTask(db, "place_image", geoObjectId, { key })`)

    Results are capped at `images.pipeline.maxGenerationsPerRun`. Since the key needs the imagery tile ids, the plan computes it from the current `imagery_tiles` rows covering the windows. A missing tile means a new key.
  - `generatePlaceImage(db, input: { geoObjectId; zoom; runId? }, deps: { archive; transport; imageModel: ImageModel; model: ModelClient }): Promise<{ status: "review" | "no_water_view" | "skipped"; attempts: number; waterIoU: number | null }>`. Steps:
    1. `loadPlaceImageInput`, `ensureImagery`, `planRender` (on `no_water_view` → task without candidate, return)
    2. `renderAndStore`
    3. up to `check.maxAttempts`: `imageModel.edit`, `waterIoU`, then `checkPlaceImageTask` when the core is watermarked; `ImageOutputInvalid` or a failed check counts as an attempt
    4. store the best attempt (highest IoU, watermark-free first) as `imagery/candidates/<geoObjectId>/<renderId>-<n>.jpg`
    5. `createReviewTask(db, { kind: "place_image", subjectType: "place_image", subjectId: geoObjectId, context: PlaceImageTaskContext })`, replacing an open task's context via dismiss + create when the key differs

    Model calls run outside transactions, as in `summarizeProfile`.
  - `type PlaceImageTaskContext = { key: string; renderId: string | null; candidateKey: string | null; light: ImageryLight; zoom: ZoomLevel; model: string; promptVersion: number; waterIoU: number | null; passed: boolean; attempts: number; watermarkVisible: boolean | null; alt: string; allowedZooms: ZoomLevel[]; reason?: "no_water_view" }`
  - `startImageRun(db, boss, input: { subdivisionKey: string } | { geoObjectId: string; zoom?: ZoomLevel }, triggeredBy): Promise<{ id: string }>`: kind `stage`, stages `[IMAGES_STAGE]`
  - `setImageModelFactory(f)` / `imageModelFor(db): ImageModel`, same pattern as `modelClientFor`

- [ ] **Step 1: Write the failing tests** (MockImageModel, MockModel, fixture transport, a fixture place outside the pilot box):
  - `IoU below threshold regenerates once, then creates a review task with passed=false and attempts=2`
  - `passing first attempt creates a review task with passed=true and attempts=1`
  - `watermark visible counts as a failed attempt`
  - `no_water_view creates a task without candidate` (Review Focus 1)
  - `targets skip a place with the same generation key` for each of the three skip conditions
  - `new prompt version makes the place a target again`
  - `place outside GR is no target`
  - `targets are capped at maxGenerationsPerRun`
  - `text run, geometry run and consolidateAfter run list images.place last; regenerate_summary run does not`
  - `newly confirmed marina gets a place_image task through its consolidation run` (end to end with MockImageModel: confirm via `decideReviewTask` → `consolidateAfter` stages planned → images.place job → task)
  - `confirmed place without fetch computation is no target`
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** The handler stays thin: it calls `generatePlaceImage(ctx.db, …, { archive: getArchive(), transport: getTransport(), imageModel: imageModelFor(ctx.db), model: modelClientFor(ctx.db) })` and logs. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(images): stage images.place with retry on low water IoU, review task and image run starter (spec 13)`

### Task 9: Review `place_image` and approval into `place_images`

**Files:**
- Create: `lib/domain/images/approve.ts`, `app/(admin)/review/[id]/place-image-decision.tsx`, `app/(admin)/images/file/route.ts`
- Modify: `lib/domain/review-decisions.ts` (actions `approve_image`, `regenerate_image` `{ zoom?: ZoomLevel }`, `no_image`; `ALLOWED["place_image/place_image"]`; dispatch; `DecideResult.regenerateImage: { geoObjectId; zoom } | null`), `lib/domain/review-view.ts` (subject `place_image` with signed-off keys and metrics), `app/(admin)/review/[id]/page.tsx`, `app/(admin)/review/[id]/actions.ts` (after commit: `startImageRun` for `regenerateImage`)
- Test: `lib/domain/images/__tests__/approve.test.ts`, `app/(admin)/__tests__/review-place-image.test.ts`

**Interfaces:**
- Consumes: `PlaceImageTaskContext` (Task 8).
- Produces:
  - `approvePlaceImage(tx, task, decisionId, now): Promise<{ placeImageId: string }>`. It locks the place and reads the candidate from the archive. It ends the current `ai_illustration` row (`valid_to = today`) and inserts `place_images` with: `kind ai_illustration`, `rank 3`, `render_id`, `light`, `model`, `prompt_version`, `water_iou`, `generation_key`, `alt`, `observed_at` (= core tile `acquiredAt`, else Sentinel-2's), `license = output.license`, `attribution` and `review_decision_id`. The candidate is copied to its final `file_key` `images/places/<geoObjectId>/<placeImageId>.jpg`.
  - `attributionFor(tiles: ImageryTileRef[], cfg): string`: the distinct `attribution` of every used imagery and DEM source, in order core, wide, DEM, joined with ` · `, plus `output.credit`
  - `no_image` ends a current `ai_illustration` row and keeps the task decided with the key, so the place is not generated again for this key
  - Stale check: `decideAction` posts `taskKey = context.key`. If the context key has changed since the form was built, the result is `TaskContextChanged` (`?changed=1`).
  - Route `GET /images/file?key=…` streams archive objects for admins. It allows only keys matching `^imagery/(renders|candidates)/[0-9a-f-]{36}/[\w.-]+$` or `^images/places/[0-9a-f-]{36}/[\w.-]+$` and returns 404 otherwise. Read the Next 16 route handler docs first.
  - Panel „Titelbild prüfen“:
    - render and AI image side by side, mask in a `Disclosure`
    - Wasser-IoU with threshold and ✓/✗, Licht, Zoom, Versuche, Wasserzeichen-Prüfung
    - buttons „Freigeben“ (disabled without candidate), „Neu erzeugen“ (zoom select from `allowedZooms`, default current) and „Kein Bild“

- [ ] **Step 1: Write the failing tests:**
  - `approve writes place_images with attribution naming aerial and terrain source`
  - `approve ends the previous image`
  - `approve after context change throws TaskContextChanged and writes nothing` (Review Focus 4)
  - `no_image ends the current image and the same key is not targeted again`
  - `regenerate_image returns regenerateImage with zoom`
  - `regenerate_image refuses a zoom outside allowedZooms`
  - `file route rejects keys outside the allowed prefixes`
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. In the browser, open a seeded `place_image` task and approve it (Playwright case in `e2e/review-place-image.spec.ts`).
- [ ] **Step 5: Commit** `feat(review): place_image review with render, illustration and mask; approval into place_images (spec 13)`

### Task 10: Contract 2.1 and delivery of images

**Files:**
- Create: `contract/v2/image.ts`, `contract/schema/2.1/*` (generated)
- Modify: `contract/v2/spot.ts`, `contract/v2/highlight.ts` (`image: placeImageSchema.optional()`), `contract/v2/manifest.ts` (`schemaVersion: z.literal("2.1")`), `contract/index.ts` (`SCHEMA_VERSION = "2.1"`), `contract/schema/published.ts`, `config/delivery.json` (`schemaVersion`, licence entries for the three sources with `fields: ["spots.json#/spots/*/image"]`), `lib/domain/delivery/load.ts` (`loadPlaceImages`), `lib/domain/delivery/map-spot.ts` (`SPOT_FIELDS.image`), `lib/domain/delivery/changes.ts` (`FIELD_LABELS_DE.image = "Titelbild"`), `lib/domain/delivery/build.ts` (image files), `lib/domain/delivery/serialize.ts` (`contentTypeOf` `.jpg` → `image/jpeg`), `lib/domain/delivery/validate.ts` (`verbatim_text` also checks `image.alt.de`; new check `image_attribution` requires that `attribution` names an aerial source and a terrain source)
- Test: `contract/__tests__/contract.test.ts`, `lib/domain/delivery/__tests__/images.test.ts`

**Interfaces:**
- Produces:
  - `placeImageSchema = z.strictObject({ kind: z.enum(["photo","ai_illustration"]), file: z.string().regex(/^images\/(sp|hl)_[0-9A-Z]{26}\.jpg$/), width: z.number().int(), height: z.number().int(), alt: textDe, light: z.enum(["midday","evening"]).nullable(), observedAt: z.iso.date().nullable(), license: z.string().min(1), attribution: z.string().min(1), sourceUrl: z.string().url().nullable() })`
  - `loadPlaceImages(db, geoObjectIds, today, cfg): Promise<Map<geoObjectId, DeliverableImage>>`: the current row with the lowest `rank`. An image is deliverable only when every source of its render's tiles has `images.delivery[source] === true`.
  - Build: every delivered spot with an image writes `images/<publicId>.jpg` (bytes from `file_key`) next to the JSON files under the same `storagePrefix`, adds it to `file_hashes`, and lists it in the manifest's files. `image` is part of the spot body, so `contentHash`/`profileVersion` change only when the image object changes.
  - The v2.0 schemas stay published, and 2.1 is additive (minor).

- [ ] **Step 1: Write the failing tests:**
  - `2.1 spot validates with image and without`
  - `2.0 schema files are unchanged`
  - `approved image with ktimatologio is not delivered while the switch is off` (Review Focus 5)
  - `flipping the switch delivers the image and raises profileVersion once` (Review Focus 5, two builds after the flip: the second is `unchanged`)
  - `image file is in file_hashes with its sha256`
  - `attribution without terrain source fails validation`
  - `alt with 16 copied words fails verbatim_text`
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, then `npm run contract:generate`. **Step 4: Run** the tests plus the `delivery-fixture` project (`npx vitest run --project delivery-fixture`) → PASS.
- [ ] **Step 5: Commit** `feat(delivery): contract 2.1 with optional image on spot and highlight; image files in the package behind the source switch (spec 13)`

### Task 11: Admin – place tab, Landesteil coverage, docs

**Files:**
- Create: `app/(admin)/places/[id]/image-tab.tsx`, `lib/domain/images/view.ts`
- Modify: `app/(admin)/places/[id]/page.tsx` (`TABS.image = "Titelbild"`), `lib/domain/subdivisions/view.ts` + `app/(admin)/subdivisions/[key]/page.tsx` (coverage block, button „Titelbilder erzeugen“ → `startImageRun`), `app/(admin)/settings/page.tsx` (show `images.json`), `docs/superpowers/specs/2026-10-18-periplus-design.md` (Abschnitt 4: deviation „nach außen nur abgeleitete Fakten“ per spec 13; Abschnitt 11: plan link), `docs/superpowers/specs/2026-10-20-periplus-13-ortsbilder-design.md` (note: „Revier“ in budgets and coverage read as Landesteil after spec 14; `maxGenerationsPerRun` lives in `images.json`, not `budgets.json`)
- Test: `lib/domain/images/__tests__/view.test.ts`, one Playwright case in `e2e/`

**Interfaces:**
- Produces:
  - `placeImageView(db, geoObjectId): Promise<{ current: { kind; light; alt; attribution; observedAt; fileKey; waterIoU; approvedAt } | null; candidate: { candidateKey; waterIoU; passed; light; taskId } | null; latestRender: { photoKey; maskKey; camera } | null; deliverable: boolean; blockedBy: string[] }>`. `candidate` comes from the open `place_image` task. The tab shows it as „Entwurf, wartet auf Freigabe“ with a link to the task, so every new spot shows its generated image right away.
  - `imageCoverage(db, subdivisionId): Promise<{ spots: number; withImagery: number; withApprovedImage: number; deliverable: number; medianWaterIoU: number | null; rejectedShare: number | null; imageryCostEur: number; generationCostEur: number }>`: `withImagery` = places with a non-blank core tile; costs from `imagery_tiles.cost_eur` and `external_calls` with service `openai`
  - The place tab shows the current image with Art („KI-Illustration“), Licht, Quellen and Aufnahmedatum, and the render and mask in a „Rendering und Maske“ `Disclosure`. It says „Nicht geliefert: Freigabe Luftbildquelle ktimatologio fehlt“ when `blockedBy` is not empty.

- [ ] **Step 1: Write the failing tests:**
  - `coverage counts spots, imagery, approved and deliverable separately`
  - `blank core tile does not count as imagery`
  - `view names the blocking source`
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Read the Next 16 docs on server actions first. **Step 4: Run** → PASS. In Playwright, open a place with an approved image and see „KI-Illustration“ and the blocking note. Then `npm run build`.
- [ ] **Step 5: Commit** `feat(admin): Titelbild tab, Landesteil image coverage and image run start; design notes (spec 13)`

---

## Spec coverage

| Spec section | Task |
| --- | --- |
| Umfang Stufe 1, Liefer-Schalter | 1, 10 |
| Teil A Quellen GR, Sentinel-2, DEM, Bestand je Ort | 1, 3 |
| Teil B Kamera, Zoomstufe, Aufbau, Ausgaben | 4, 5 |
| Teil C Modell, Prompt-Blöcke, Licht je Ortsart, „bei einer Stadt“ | 1, 4, 6 |
| Teil D Geometrie, Wasserzeichen, Freigabe, Kennzeichnung, Neu-Erzeugen-Regel | 7, 8, 9 |
| Liefervertrag, Rechtliches (Namensnennung) | 9, 10 |
| Datenmodell, Konfiguration | 1, 2 |
| Pipeline | 8 |
| UI-Anteil, Kennzahlen (Abdeckung, Kosten) | 9, 11 |
| Abweichungen | 11 |
| Teil E, UP42, weitere Länder, Kantenvergleich | not in this plan |
