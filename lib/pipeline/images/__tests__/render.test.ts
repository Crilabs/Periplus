import { readFile, writeFile, mkdir } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { writeArrayBuffer } from "geotiff";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { placeRenders } from "@/lib/db/schema";
import { cameraFor } from "@/lib/domain/images/render-plan";
import type { PlaceImageInput } from "@/lib/domain/images/place-input";
import type { HeightGrid } from "@/lib/domain/images/terrain";
import type { Bbox } from "@/lib/domain/images/window";
import { createRun } from "@/lib/domain/runs";
import { renderAndStore, renderPlace } from "@/lib/pipeline/images/render";
import type { ImagerySet, ImageryTileRef } from "@/lib/pipeline/images/imagery";
import { buildSceneBundle, SCENE_BUNDLE_PATH } from "@/scripts/build-render-scene";
import { chromiumInstalled } from "@/test/browser";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertTestGeoObject } from "@/test/text";

/*
 * Synthetic scenes around 19.37° E / 36.61° N (open sea west of the Peloponnese, outside the pilot box). Every render
 * runs the real scene in headless Chromium (SwiftShader WebGL); the photo and mask of the first test are written to
 * PERIPLUS_RENDER_OUT when set, for a look by eye.
 */
const cfg = getConfig().images;
const LON = 19.37;
const LAT = 36.61;
const KX = 111_320 * Math.cos((LAT * Math.PI) / 180);
const KY = 110_540;
const WIDTH = cfg.camera.width;
const HEIGHT = cfg.camera.height;
const RENDER_TIMEOUT_MS = 120_000;

/** The box ± `halfM` metres around (`lon`, `lat`). */
const boxAround = (lon: number, lat: number, halfM: number): Bbox => [lon - halfM / KX, lat - halfM / KY, lon + halfM / KX, lat + halfM / KY];

/** A height grid over `bbox` with `step` metres between nodes; `height(lon, lat)` per node, row 0 south. */
function grid(bbox: Bbox, stepM: number, height: (lon: number, lat: number) => number): HeightGrid {
  const cols = Math.ceil(((bbox[2] - bbox[0]) * KX) / stepM) + 1;
  const rows = Math.ceil(((bbox[3] - bbox[1]) * KY) / stepM) + 1;
  const heights = new Float32Array(cols * rows);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const lon = bbox[0] + ((bbox[2] - bbox[0]) * j) / (cols - 1);
      const lat = bbox[1] + ((bbox[3] - bbox[1]) * i) / (rows - 1);
      heights[i * cols + j] = height(lon, lat);
    }
  }
  return { bbox, cols, rows, heights };
}

const solid = async (r: number, g: number, b: number, size = 64) =>
  new Uint8Array(await sharp({ create: { width: size, height: size, channels: 3, background: { r, g, b } } }).png().toBuffer());

/** A `size` × `size` PNG of `inner` with a white band of `border` pixels along every edge (cadastre no-data). */
async function framed(inner: { r: number; g: number; b: number }, size: number, border: number): Promise<Uint8Array> {
  const px = Buffer.alloc(size * size * 3, 255);
  for (let y = border; y < size - border; y++) {
    for (let x = border; x < size - border; x++) {
      const o = (y * size + x) * 3;
      px[o] = inner.r;
      px[o + 1] = inner.g;
      px[o + 2] = inner.b;
    }
  }
  return new Uint8Array(await sharp(px, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer());
}

/** Pixels of a PNG with its stored channel count (sharp's raw output would turn grey into RGB). */
async function raw(png: Uint8Array): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { channels } = await sharp(png).metadata();
  const image = channels === 1 ? sharp(png).extractChannel(0) : sharp(png);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: channels! };
}

async function keep(name: string, bytes: Uint8Array): Promise<void> {
  const dir = process.env.PERIPLUS_RENDER_OUT;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${name}`, bytes);
}

describe("render scene bundle", () => {
  it("the committed scene bundle matches scene.ts (run `npm run images:scene` after changing it)", async () => {
    // compared as booleans: a diff of two half-megabyte one-liners helps nobody
    expect((await buildSceneBundle()) === (await readFile(SCENE_BUNDLE_PATH, "utf8"))).toBe(true);
  });
});

describe.skipIf(!chromiumInstalled())("renderPlace", () => {
  it(
    "fixture terrain renders a deterministic mask",
    async () => {
      // 2 × 2 km core and 8 × 8 km wide grid: west of the target 50 m of land, east of it sea level.
      const height = (lon: number) => (lon < LON ? 50 : 0);
      const input = {
        camera: cameraFor([LON, LAT], 180, "z1", cfg), // camera south of the target, looking north
        wide: grid(boxAround(LON, LAT, 4000), 100, height),
        core: grid(boxAround(LON, LAT, 1000), 20, height),
        wideTexture: await solid(90, 140, 70),
        coreTextures: [],
        whiteThreshold: cfg.window.whiteThreshold,
        sinkM: cfg.window.wideSinkM,
      };
      const first = await renderPlace(input);
      await keep("fixture-photo.png", first.photo);
      await keep("fixture-mask.png", first.mask);

      const mask = await raw(first.mask);
      expect([mask.width, mask.height, mask.channels]).toEqual([WIDTH, HEIGHT, 1]);
      const photo = await raw(first.photo);
      expect([photo.width, photo.height, photo.channels]).toEqual([WIDTH, HEIGHT, 3]);

      // Against the ideal mask (right half water, left half land) at most 2 % of the pixels differ: the visible
      // cliff face (50 m over one grid cell) lies left of the centre line and is half water by interpolation.
      let leftWater = 0;
      let rightLand = 0;
      const values = new Set<number>();
      let lowestSkyRow = -1;
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const v = mask.data[y * WIDTH + x]!;
          values.add(v);
          if (v === 255 && x < WIDTH / 2) leftWater++;
          if (v !== 255 && x >= WIDTH / 2) rightLand++;
          if (v === 128) lowestSkyRow = y;
        }
      }
      expect([...values].every((v) => v === 0 || v === 128 || v === 255)).toBe(true);
      expect((leftWater + rightLand) / (WIDTH * HEIGHT)).toBeLessThan(0.02);
      expect(lowestSkyRow).toBeLessThan(HEIGHT * 0.05);

      const second = await renderPlace(input);
      expect(Buffer.from(second.mask).equals(Buffer.from(first.mask))).toBe(true);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "white border of the core texture shows Sentinel-2",
    async () => {
      // Flat ground; the core is one cadastre tile, green with a white no-data band of 150 m along its edges.
      const coreBox = boxAround(LON, LAT, 750);
      const corner: [number, number] = [coreBox[0] + 50 / KX, coreBox[1] + 50 / KY]; // inside the white band
      const sentinel = { r: 170, g: 80, b: 60 };
      const green = { r: 40, g: 150, b: 60 };
      const result = await renderPlace({
        camera: cameraFor(corner, 225, "z1", cfg), // from the south-west, outside the core, looking at its corner
        wide: grid(boxAround(LON, LAT, 4000), 100, () => 0),
        core: grid(coreBox, 20, () => 0),
        wideTexture: await solid(sentinel.r, sentinel.g, sentinel.b),
        coreTextures: [{ bbox: coreBox, bytes: await framed(green, 200, 20) }],
        whiteThreshold: cfg.window.whiteThreshold,
        sinkM: cfg.window.wideSinkM,
      });
      const photo = await raw(result.photo);
      const at = (x: number, y: number) => {
        const o = (y * WIDTH + x) * photo.channels;
        return [photo.data[o]!, photo.data[o + 1]!, photo.data[o + 2]!];
      };
      // The image centre is the look-at point (the core corner); the bottom edge lies outside the core, on the
      // wide mesh with the same lighting: both show the Sentinel-2 colour.
      const centre = at(WIDTH / 2, HEIGHT / 2);
      const outside = at(WIDTH / 2, HEIGHT - 10);
      for (let c = 0; c < 3; c++) expect(Math.abs(centre[c]! - outside[c]!)).toBeLessThanOrEqual(8);
      expect(centre[0]!).toBeGreaterThan(centre[1]! + 40); // reddish, not white and not green
      // 400 m further along the view, 333 m inside both core edges: the cadastre's green.
      const inside = at(WIDTH / 2, 259);
      expect(inside[1]!).toBeGreaterThan(inside[0]! + 40);
    },
    RENDER_TIMEOUT_MS,
  );
});

describe.skipIf(!chromiumInstalled())("renderAndStore", () => {
  it(
    "renders from the archived imagery and records place_renders",
    async () => {
      await withRollback(async (tx) => {
        const archive = memoryArchive();
        const geoObjectId = await insertTestGeoObject(tx);
        const run = await createRun(tx, { kind: "system", scope: { type: "system", id: "test" }, stages: [], triggeredBy: "test" });

        const ref = (source: ImageryTileRef["source"], bbox: Bbox, fileKey: string, blank = false): ImageryTileRef => ({
          id: crypto.randomUUID(),
          source,
          bbox,
          fileKey,
          resolutionM: source === "ktimatologio" ? 0.5 : source === "sentinel2" ? 10 : 30,
          acquiredAt: null,
          blank,
        });
        const coreBox = boxAround(LON, LAT, 750);
        const wideBox = boxAround(LON, LAT, 6000);
        // One DEM tile 19–20° E × 36–37° N: land above 36.62° N.
        const dem = new Float32Array(100 * 100);
        for (let row = 0; row < 100; row++) for (let col = 0; col < 100; col++) dem[row * 100 + col] = 37 - (row + 0.5) * 0.01 > 36.62 ? 40 : 0;
        await archive.put("imagery/copernicus_dem/t.tif", new Uint8Array(writeArrayBuffer(dem, { width: 100, height: 100, ModelPixelScale: [0.01, 0.01, 0], ModelTiepoint: [0, 0, 0, 19, 37, 0], GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1 })), "image/tiff");
        await archive.put("imagery/sentinel2/w.jpg", await solid(30, 90, 140), "image/jpeg");
        await archive.put("imagery/ktimatologio/c.jpg", await framed({ r: 40, g: 150, b: 60 }, 200, 10), "image/jpeg");
        await archive.put("imagery/ktimatologio/blank.jpg", await solid(255, 255, 255), "image/jpeg");
        const imagery: ImagerySet = {
          core: [ref("ktimatologio", coreBox, "imagery/ktimatologio/c.jpg"), ref("ktimatologio", coreBox, "imagery/ktimatologio/blank.jpg", true)],
          wide: [ref("sentinel2", wideBox, "imagery/sentinel2/w.jpg")],
          dem: [ref("copernicus_dem", [19, 36, 20, 37], "imagery/copernicus_dem/t.tif")],
          coreSource: "ktimatologio",
        };
        const place: PlaceImageInput = {
          geoObjectId,
          publicId: null,
          kind: "anchorage",
          lon: LON,
          lat: LAT,
          country: "GR",
          subdivisionKey: null,
          openingBearing: 180,
          rays: null,
          town: null,
        };
        // A near-town view: 800 m out, the tilt from the geometry (18°, not 30°), the horizon in the picture.
        const camera = { ...cameraFor([LON, LAT], 180, "z1", cfg), distanceM: 800, tiltDeg: (Math.atan(260 / 800) * 180) / Math.PI };

        const out = await renderAndStore(tx, archive, place, camera, imagery, { runId: run.id, generationKey: "gen-test" });
        expect(out.photoKey).toBe(`imagery/renders/${geoObjectId}/${out.renderId}/photo.png`);
        expect(out.maskKey).toBe(`imagery/renders/${geoObjectId}/${out.renderId}/mask.png`);
        expect(archive.contentType(out.photoKey)).toBe("image/png");
        expect(archive.contentType(out.maskKey)).toBe("image/png");
        const mask = await raw((await archive.get(out.maskKey))!);
        expect([mask.width, mask.height, mask.channels]).toEqual([WIDTH, HEIGHT, 1]);
        expect(mask.data[WIDTH / 2]).toBe(128); // sky above the horizon
        expect(mask.data[(HEIGHT - 10) * WIDTH + WIDTH / 2]).toBe(255); // water in front
        // The water in front of the camera (0 m, inside the core) shows the cadastre's green, not the sea plane
        // under it: with the horizon in view the plane once won the depth test over all water.
        const photo = await raw((await archive.get(out.photoKey))!);
        const o = ((HEIGHT - 10) * WIDTH + WIDTH / 2) * photo.channels;
        expect(photo.data[o + 1]!).toBeGreaterThan(photo.data[o]! + 40);
        expect(photo.data[o + 1]!).toBeGreaterThan(photo.data[o + 2]! + 40);

        const [row] = await tx.select().from(placeRenders).where(eq(placeRenders.id, out.renderId));
        expect(row).toMatchObject({
          geoObjectId,
          zoom: "z1",
          photoKey: out.photoKey,
          maskKey: out.maskKey,
          depthKey: null,
          rendererVersion: cfg.render.rendererVersion,
          generationKey: "gen-test",
          runId: run.id,
          // the blank cadastre tile is no texture, but it decided where Sentinel-2 shows: recorded too
          imageryTileIds: [...imagery.core.map((t) => t.id), imagery.wide[0]!.id],
          demTileIds: [imagery.dem[0]!.id],
        });
        expect(row!.camera).toEqual(camera);
      });
    },
    RENDER_TIMEOUT_MS,
  );
});
