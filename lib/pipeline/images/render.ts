import type { Browser } from "playwright";
import sharp, { type OverlayOptions } from "sharp";
import { chromiumLaunchOptions } from "@/lib/adapters/fetch/browser";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig, type ImagesConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { placeRenders } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import type { PlaceImageInput } from "@/lib/domain/images/place-input";
import type { RenderCamera } from "@/lib/domain/images/render-plan";
import { sampleDem, type HeightGrid } from "@/lib/domain/images/terrain";
import { coreWindow, wideWindow, type Bbox } from "@/lib/domain/images/window";
import type { ImagerySet, ImageryTileRef } from "./imagery";
import { SCENE_JS } from "./scene/scene.bundle";
import type { SceneGrid, SceneInput, SceneOutput } from "./scene/types";

export type RenderInput = {
  camera: RenderCamera;
  wide: HeightGrid;
  core: HeightGrid;
  /** Satellite image (PNG or JPEG) covering exactly `wide.bbox`. */
  wideTexture: Uint8Array;
  /** Aerial tiles of the core window; white no-data touching the border shows the satellite image instead. */
  coreTextures: Array<{ bbox: Bbox; bytes: Uint8Array }>;
  whiteThreshold: number;
  sinkM: number;
};

export type RenderDeps = {
  /** Starts the browser (default: Playwright's Chromium, headless, SwiftShader WebGL, all traffic to the dead proxy). */
  launchBrowser?: () => Promise<Browser>;
  /** Longest render (default `images.render.timeoutSeconds`). */
  timeoutMs?: number;
};

export type RenderedImages = { photo: Uint8Array; mask: Uint8Array };

/** A render that did not finish within its time limit. */
export class RenderTimeout extends Error {
  constructor(ms: number) {
    super(`render took longer than ${ms} ms`);
    this.name = "RenderTimeout";
  }
}

/** Biggest side of the satellite mosaic of the wide window. */
const MAX_WIDE_TEXTURE_PX = 8192;

/**
 * Chromium for renders: the fetch renderer's options (headless, every connection to the dead proxy; the scene loads
 * no URLs) plus WebGL on SwiftShader, so a machine without GPU (the worker container) renders, and every machine
 * renders the same pixels.
 */
async function launchRenderBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  const options = chromiumLaunchOptions();
  return chromium.launch({
    ...options,
    args: [...(options.args ?? []), "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

const sceneGrid = (g: HeightGrid): SceneGrid => ({ bbox: g.bbox, cols: g.cols, rows: g.rows, heightsBase64: base64(new Uint8Array(g.heights.buffer, g.heights.byteOffset, g.heights.byteLength)) });

const dataUrlBytes = (url: string) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RenderTimeout(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Renders the terrain of a place in headless Chromium (three.js scene of `scene/scene.ts`, see there for the scene
 * rules): the photo (RGB PNG) and the land/water mask (grey PNG: water 255, land 0, sky 128), both
 * `camera.width` × `camera.height`. A fresh browser per render, closed afterwards.
 */
export async function renderPlace(input: RenderInput, deps: RenderDeps = {}): Promise<RenderedImages> {
  const timeoutMs = deps.timeoutMs ?? getConfig().images.render.timeoutSeconds * 1000;
  const c = input.camera;
  const scene: SceneInput = {
    camera: { target: c.target, azimuthDeg: c.azimuthDeg, distanceM: c.distanceM, heightM: c.heightM, tiltDeg: c.tiltDeg, fovDeg: c.fovDeg, width: c.width, height: c.height },
    wide: sceneGrid(input.wide),
    core: sceneGrid(input.core),
    wideTextureBase64: base64(input.wideTexture),
    coreTextures: input.coreTextures.map((t) => ({ bbox: t.bbox, base64: base64(t.bytes) })),
    whiteThreshold: input.whiteThreshold,
    sinkM: input.sinkM,
  };

  const browser = await (deps.launchBrowser ?? launchRenderBrowser)();
  try {
    const out = await withTimeout(
      (async (): Promise<SceneOutput> => {
        const page = await browser.newPage();
        await page.setContent("<!doctype html><html><head></head><body></body></html>");
        await page.addScriptTag({ content: SCENE_JS });
        return page.evaluate((arg) => window.periplusRender!(arg), scene);
      })(),
      timeoutMs,
    );
    const [photo, mask] = await Promise.all([
      sharp(dataUrlBytes(out.photo)).removeAlpha().png().toBuffer(),
      sharp(dataUrlBytes(out.mask)).extractChannel(0).toColourspace("b-w").png().toBuffer(),
    ]);
    return { photo: new Uint8Array(photo), mask: new Uint8Array(mask) };
  } finally {
    await browser.close();
  }
}

/**
 * The satellite tiles cropped and mosaicked to exactly `bbox`, at the resolution of the first tile (capped). Areas
 * no tile covers stay white.
 */
async function wideMosaic(tiles: Array<{ bbox: Bbox; bytes: Uint8Array }>, bbox: Bbox): Promise<Uint8Array> {
  if (tiles.length === 0) throw new Error("no satellite tile for the wide window");
  const [west, south, east, north] = bbox;
  const first = await sharp(tiles[0]!.bytes).metadata();
  const pxPerLon = first.width! / (tiles[0]!.bbox[2] - tiles[0]!.bbox[0]);
  const pxPerLat = first.height! / (tiles[0]!.bbox[3] - tiles[0]!.bbox[1]);
  const width = Math.max(1, Math.min(MAX_WIDE_TEXTURE_PX, Math.round((east - west) * pxPerLon)));
  const height = Math.max(1, Math.min(MAX_WIDE_TEXTURE_PX, Math.round((north - south) * pxPerLat)));
  const sx = width / (east - west);
  const sy = height / (north - south);

  const layers: OverlayOptions[] = [];
  for (const t of tiles) {
    const left = Math.round((t.bbox[0] - west) * sx);
    const top = Math.round((north - t.bbox[3]) * sy);
    const w = Math.max(1, Math.round((t.bbox[2] - t.bbox[0]) * sx));
    const h = Math.max(1, Math.round((t.bbox[3] - t.bbox[1]) * sy));
    const x0 = Math.max(0, left);
    const y0 = Math.max(0, top);
    const x1 = Math.min(width, left + w);
    const y1 = Math.min(height, top + h);
    if (x1 <= x0 || y1 <= y0) continue;
    const input = await sharp(t.bytes)
      .resize(w, h, { fit: "fill" })
      .extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
      .png()
      .toBuffer();
    layers.push({ input, left: x0, top: y0 });
  }
  const png = await sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(layers)
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

export type RenderStoreContext = {
  runId: string;
  /** The generation key of the title image this render is for (computed by the caller). */
  generationKey: string;
  cfg?: ImagesConfig;
  deps?: RenderDeps;
};

/**
 * Renders a place from its archived imagery and records it: heights from the DEM tiles over the wide window (every
 * `wideGridM`) and the core window (every `coreGridM`), the satellite mosaic of the wide window, the non-blank aerial
 * tiles of the core window. Photo and mask go to `imagery/renders/<geoObjectId>/<renderId>/{photo,mask}.png`, the
 * render to `place_renders` (append-only) with the ids of every imagery tile it was made from.
 */
export async function renderAndStore(
  db: Db,
  archive: Archive,
  place: PlaceImageInput,
  camera: RenderCamera,
  imagery: ImagerySet,
  ctx: RenderStoreContext,
): Promise<{ renderId: string; photoKey: string; maskKey: string }> {
  const cfg = ctx.cfg ?? getConfig().images;
  const read = async (tile: ImageryTileRef) => {
    const bytes = await archive.get(tile.fileKey);
    if (!bytes) throw new Error(`archived imagery ${tile.fileKey} is missing`);
    return { bbox: tile.bbox, bytes };
  };

  const coreBox = coreWindow(place.lon, place.lat, cfg.window, place.coreSizeM);
  const wideBox = wideWindow(place.lon, place.lat, cfg.window);
  const dem = (await Promise.all(imagery.dem.map(read))).map((t) => t.bytes);
  const [wide, core] = await Promise.all([sampleDem(dem, wideBox, cfg.window.wideGridM), sampleDem(dem, coreBox, cfg.window.coreGridM)]);
  const coreTextures = await Promise.all(imagery.core.filter((t) => !t.blank).map(read));
  const wideTexture = await wideMosaic(await Promise.all(imagery.wide.map(read)), wideBox);

  const { photo, mask } = await renderPlace(
    { camera, wide, core, wideTexture, coreTextures, whiteThreshold: cfg.window.whiteThreshold, sinkM: cfg.window.wideSinkM },
    { timeoutMs: cfg.render.timeoutSeconds * 1000, ...ctx.deps },
  );

  const renderId = newId();
  const photoKey = `imagery/renders/${place.geoObjectId}/${renderId}/photo.png`;
  const maskKey = `imagery/renders/${place.geoObjectId}/${renderId}/mask.png`;
  await archive.put(photoKey, photo, "image/png");
  await archive.put(maskKey, mask, "image/png");
  await db.insert(placeRenders).values({
    id: renderId,
    geoObjectId: place.geoObjectId,
    camera,
    zoom: camera.zoom,
    imageryTileIds: [...imagery.core, ...imagery.wide].map((t) => t.id),
    demTileIds: imagery.dem.map((t) => t.id),
    photoKey,
    maskKey,
    rendererVersion: cfg.render.rendererVersion,
    generationKey: ctx.generationKey,
    runId: ctx.runId,
  });
  return { renderId, photoKey, maskKey };
}
