import type { ImagesConfig } from "@/lib/config";
import type { Bbox } from "@/lib/domain/tiles";

export type { Bbox };

/** Metres per degree of latitude (and of longitude at the equator), spherical approximation. */
export const METRES_PER_DEGREE = 111_320;

/** Metres per degree of longitude at `lat`. */
export function metresPerDegreeLon(lat: number): number {
  return METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
}

/** Square of `coreSizeM` around the place: the area the aerial image of the render must cover in detail. */
export function coreWindow(lon: number, lat: number, cfg: Pick<ImagesConfig["window"], "coreSizeM">): Bbox {
  const half = cfg.coreSizeM / 2;
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
