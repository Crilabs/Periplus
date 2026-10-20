import { eq, sql } from "drizzle-orm";
import { writeArrayBuffer } from "geotiff";
import sharp from "sharp";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { getConfig } from "@/lib/config";
import { MockImageModel } from "@/lib/ai/mock-image";
import { MockModel } from "@/lib/ai/mock";
import type { Db } from "@/lib/db/client";
import { geoObjects, placeRenders, places, type PlaceKind, type PlaceStatus } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import type { PlaceImageTaskContext } from "@/lib/pipeline/images/generate";
import type { renderAndStore } from "@/lib/pipeline/images/render";
import { insertComputation, insertPlace } from "@/test/consolidation";
import { insertTestSubdivision } from "@/test/text";

/*
 * Fixtures of the place image tests (spec 13): synthetic imagery answers for WMS and DEM (no network), and spots with
 * a subdivision and a fetch computation. Meant for `withRollback`; places around 19.37° E / 36.61° N (open sea west
 * of the Peloponnese, outside the pilot box).
 */

export const IMAGE_LON = 19.37;
export const IMAGE_LAT = 36.61;

/** A 16 × 16 JPEG of one colour (a WMS answer). */
export const solidJpeg = async (colour: { r: number; g: number; b: number }) =>
  new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: colour } }).jpeg().toBuffer());

/**
 * A GeoTIFF of the 1° × 1° DEM tile whose south-west corner is (`lon`, `lat`), 100 × 100 cells of `height(cellLon,
 * cellLat)` (default flat sea level).
 */
export function demTiff(lon: number, lat: number, height: (lon: number, lat: number) => number = () => 0): Uint8Array {
  const n = 100;
  const cells = new Float32Array(n * n);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) cells[row * n + col] = height(lon + (col + 0.5) / n, lat + 1 - (row + 0.5) / n);
  }
  return new Uint8Array(
    writeArrayBuffer(cells, {
      width: n,
      height: n,
      ModelPixelScale: [1 / n, 1 / n, 0],
      ModelTiepoint: [0, 0, 0, lon, lat + 1, 0],
      GeographicTypeGeoKey: 4326,
      GTModelTypeGeoKey: 2,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

/**
 * Answers per service: cadastre (white when `blankCadastre`, else green), Sentinel-2 (blue), DEM (`dem`, default a
 * flat tile under IMAGE_LON / IMAGE_LAT). Every request is pushed to `seen`.
 */
export async function syntheticImageryTransport(
  opts: { blankCadastre?: boolean; dem?: Uint8Array } = {},
  seen: HttpRequest[] = [],
): Promise<Transport> {
  const cadastre = await solidJpeg(opts.blankCadastre ? { r: 255, g: 255, b: 255 } : { r: 60, g: 120, b: 90 });
  const sentinel = await solidJpeg({ r: 20, g: 90, b: 160 });
  const dem = opts.dem ?? demTiff(Math.floor(IMAGE_LON), Math.floor(IMAGE_LAT));
  return async (req) => {
    seen.push(req);
    const body = req.service === "ktimatologio" ? cadastre : req.service === "sentinel2" ? sentinel : dem;
    return makeResponse(200, body);
  };
}

/** A transport that fails every request: the code under test must not reach the network. */
export const refusingTransport: Transport = async (req) => {
  throw new Error(`unexpected request ${req.service} ${req.url}`);
};

/** A test subdivision (`XT-<uuid>`) of `country` (default GR) over the box around IMAGE_LON / IMAGE_LAT. */
export async function insertImageSubdivision(tx: Db, country = "GR"): Promise<{ id: string; key: string }> {
  const key = `XT-${newId()}`;
  const { id } = await insertTestSubdivision(tx, key, [IMAGE_LON - 0.3, IMAGE_LAT - 0.3, IMAGE_LON + 0.3, IMAGE_LAT + 0.3], { country });
  return { id, key };
}

/**
 * A spot in subdivision `subdivisionId`: geo object and place (`kind`, default anchorage; `status`, default
 * confirmed) at (`lon`, `lat`), with a fetch computation whose rays are longest towards the south unless `fetch` is
 * false.
 */
export async function insertSpot(
  tx: Db,
  subdivisionId: string,
  o: { lon?: number; lat?: number; kind?: PlaceKind; status?: PlaceStatus; fetch?: boolean; name?: string } = {},
): Promise<{ objectId: string; placeId: string }> {
  const spot = await insertPlace(tx, { lon: o.lon ?? IMAGE_LON, lat: o.lat ?? IMAGE_LAT, status: o.status, name: o.name });
  if (o.kind) await tx.update(places).set({ kind: o.kind }).where(eq(places.id, spot.placeId));
  await tx.update(geoObjects).set({ subdivisionId }).where(eq(geoObjects.id, spot.objectId));
  if (o.fetch !== false) {
    const rays = Array.from({ length: 72 }, (_, i) => (i === 36 ? 9000 : 400));
    await insertComputation(tx, spot.objectId, "fetch", { "fetch.n": 400 }, { outputs: { rays } });
  }
  return spot;
}

const MASK_W = 96;
const MASK_H = 64;

async function rgbPng(pixel: (x: number, y: number) => [number, number, number]): Promise<Uint8Array> {
  const data = Buffer.alloc(MASK_W * MASK_H * 3);
  for (let y = 0; y < MASK_H; y++) {
    for (let x = 0; x < MASK_W; x++) data.set(pixel(x, y), (y * MASK_W + x) * 3);
  }
  return new Uint8Array(await sharp(data, { raw: { width: MASK_W, height: MASK_H, channels: 3 } }).png().toBuffer());
}

/** The stub render's mask: top quarter sky (128), below it the left half land (0) and the right half water (255). */
export async function stubMask(): Promise<Uint8Array> {
  const rgb = await rgbPng((x, y) => (y < MASK_H / 4 ? [128, 128, 128] : x < MASK_W / 2 ? [0, 0, 0] : [255, 255, 255]));
  return new Uint8Array(await sharp(rgb).extractChannel(0).toColourspace("b-w").png().toBuffer());
}

/** An AI image matching `stubMask` (water IoU 1). */
export const GOOD = rgbPng((x, y) => (y < MASK_H / 4 ? [230, 230, 240] : x < MASK_W / 2 ? [40, 150, 60] : [20, 90, 200]));
/** An AI image without any water (water IoU 0 against `stubMask`). */
export const DRY = rgbPng(() => [40, 150, 60]);

/**
 * Stand-in for `renderAndStore` (no browser): archives `stubMask` and a photo and records the render like the real one
 * (with the configured renderer version, so a retried job finds it as `existingRender` does).
 */
export const stubRender: typeof renderAndStore = async (db, archive, place, camera, imagery, ctx) => {
  const renderId = newId();
  const photoKey = `imagery/renders/${place.geoObjectId}/${renderId}/photo.png`;
  const maskKey = `imagery/renders/${place.geoObjectId}/${renderId}/mask.png`;
  await archive.put(photoKey, await GOOD, "image/png");
  await archive.put(maskKey, await stubMask(), "image/png");
  await db.insert(placeRenders).values({
    id: renderId,
    geoObjectId: place.geoObjectId,
    camera,
    zoom: camera.zoom,
    imageryTileIds: [...imagery.core, ...imagery.wide].map((t) => t.id),
    demTileIds: imagery.dem.map((t) => t.id),
    photoKey,
    maskKey,
    rendererVersion: (ctx.cfg ?? getConfig().images).render.rendererVersion,
    generationKey: ctx.generationKey,
    runId: ctx.runId,
  });
  return { renderId, photoKey, maskKey };
};

/** An image model answering with `answers` in turn (the last one repeats; an `Error` is thrown). */
export async function imageModel(...answers: Array<Promise<Uint8Array> | Uint8Array | Error>): Promise<MockImageModel> {
  const resolved = await Promise.all(answers.map(async (a) => (a instanceof Error ? a : await a)));
  let i = 0;
  return new MockImageModel(() => resolved[Math.min(i++, resolved.length - 1)]!);
}

/** The watermark check answering `visible` in turn (the last one repeats). */
export function checker(...visible: boolean[]): MockModel {
  let i = 0;
  return new MockModel({ "check-place-image": () => ({ watermarkVisible: visible[Math.min(i++, visible.length - 1)]!, note: "" }) });
}

/** The `place_image` tasks on `subjectId` with `status` (default open). */
export async function imageTasksOf(tx: Db, subjectId: string, status = "open") {
  const { rows } = await tx.execute<{ id: string; context: PlaceImageTaskContext; subject_type: string }>(
    sql`select id, context, subject_type from review_tasks where kind = 'place_image' and subject_id = ${subjectId} and status = ${status}`,
  );
  return rows;
}
