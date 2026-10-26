import type { ImagesConfig } from "@/lib/config";
import type { Bbox } from "@/lib/domain/tiles";
import { groundAt } from "./projection";
import type { RenderCamera } from "./render-plan";

export type { Bbox };

/** Metres per degree of latitude (and of longitude at the equator), spherical approximation. */
export const METRES_PER_DEGREE = 111_320;

/** Metres per degree of longitude at `lat`. */
export function metresPerDegreeLon(lat: number): number {
  return METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
}

/** Square of `sizeM` (default `coreSizeM`) around the place: the area the aerial image of the render must cover in detail. */
export function coreWindow(lon: number, lat: number, cfg: Pick<ImagesConfig["window"], "coreSizeM">, sizeM: number = cfg.coreSizeM): Bbox {
  const half = sizeM / 2;
  const dLat = half / METRES_PER_DEGREE;
  const dLon = half / metresPerDegreeLon(lat);
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/**
 * The surroundings for the horizon of the render: ± `wideMarginDeg` in longitude, ± `wideMarginDeg * 0.75` in latitude
 * (roughly square in metres at Mediterranean latitudes).
 */
export function wideWindow(lon: number, lat: number, cfg: Pick<ImagesConfig["window"], "wideMarginDeg">): Bbox {
  const dLon = cfg.wideMarginDeg;
  const dLat = cfg.wideMarginDeg * 0.75;
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/** Image points (NDC) whose ground the core window must cover: the corners and middle of the lower two thirds. */
const FOOTPRINT: Array<[number, number]> = [-1, 0, 1].flatMap((x) => [-1, 0, 1 / 3].map((y) => [x, y] as [number, number]));

/**
 * Side of the core window for `camera` (spec 19): twice the farthest ground point of the lower two thirds of the
 * image from the target plus `coreMarginM` on each side, at least `coreSizeM`, at most `coreMaxSizeM` (also when a
 * point lies beyond the horizon).
 */
export function coreSizeFor(camera: RenderCamera, cfg: Pick<ImagesConfig, "window">): number {
  const w = cfg.window;
  let farthest = 0;
  for (const ndc of FOOTPRINT) {
    const p = groundAt(camera, ndc, w.coreMaxSizeM * 4);
    if (!p) return w.coreMaxSizeM;
    const east = (p[0] - camera.target[0]) * metresPerDegreeLon(camera.target[1]);
    const north = (p[1] - camera.target[1]) * METRES_PER_DEGREE;
    farthest = Math.max(farthest, Math.abs(east), Math.abs(north));
  }
  return Math.min(w.coreMaxSizeM, Math.max(w.coreSizeM, Math.ceil(2 * farthest + 2 * w.coreMarginM)));
}
