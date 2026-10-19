import type { GeometryConfig } from "@/lib/config";
import { SECTORS, SECTOR_CENTER_DEG, type Sector } from "@/lib/domain/facts/schema-types";

/** Half the width of a compass sector (8 sectors of 45°). */
const SECTOR_HALF_WIDTH_DEG = 22.5;

const round = (value: number, places: number) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

const toRad = (deg: number) => (deg * Math.PI) / 180;

function checkRays(rays: number[], cfg: GeometryConfig): void {
  if (rays.length !== cfg.fetch.rayCount) {
    throw new Error(`Expected ${cfg.fetch.rayCount} rays, got ${rays.length}`);
  }
}

function bySector(fn: (sector: Sector) => number): Record<Sector, number> {
  return Object.fromEntries(SECTORS.map((s) => [s, fn(s)])) as Record<Sector, number>;
}

/** Shelter of one ray, 0–1: 1 up to `fMinM` of fetch, 0 from `fMaxM`, log-scaled in between. */
export function rayShelter(fetchM: number, cfg: GeometryConfig["shelter"]): number {
  const value = 1 - Math.log10(fetchM / cfg.fMinM) / Math.log10(cfg.fMaxM / cfg.fMinM);
  return Math.min(1, Math.max(0, value));
}

/** Indices of the rays within ±22.5° of the sector centre (ray 0 = bearing 0°, clockwise), from west to east. */
export function sectorRayIndices(sector: Sector, cfg: GeometryConfig["fetch"]): number[] {
  const center = SECTOR_CENTER_DEG[sector] / cfg.rayStepDeg;
  const half = Math.floor(SECTOR_HALF_WIDTH_DEG / cfg.rayStepDeg);
  return Array.from({ length: 2 * half + 1 }, (_, i) => (((center - half + i) % cfg.rayCount) + cfg.rayCount) % cfg.rayCount);
}

/** Shelter per sector, 0–1 (3 places): `meanWeight × mean + minWeight × minimum` of its rays' shelter. */
export function shelterFromFetch(rays: number[], cfg: GeometryConfig): Record<Sector, number> {
  checkRays(rays, cfg);
  return bySector((sector) => {
    const values = sectorRayIndices(sector, cfg.fetch).map((i) => rayShelter(rays[i]!, cfg.shelter));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return round(cfg.shelter.meanWeight * mean + cfg.shelter.minWeight * Math.min(...values), 3);
  });
}

/** Fetch per sector: mean of its rays, whole metres. */
export function sectorFetch(rays: number[], cfg: GeometryConfig): Record<Sector, number> {
  checkRays(rays, cfg);
  return bySector((sector) => {
    const indices = sectorRayIndices(sector, cfg.fetch);
    return Math.round(indices.reduce((sum, i) => sum + rays[i]!, 0) / indices.length);
  });
}

/**
 * Opening to the sea: the rays with fetch above `openFetchM`. `widthDeg` = their count × ray step;
 * `bearingDeg` = vector mean of their bearings (whole degrees), `null` when none is open or the
 * normalised resultant is below `minResultant` (open rays pointing in opposing directions).
 */
export function opening(rays: number[], cfg: GeometryConfig): { bearingDeg: number | null; widthDeg: number } {
  checkRays(rays, cfg);
  const open = rays.flatMap((fetchM, i) => (fetchM > cfg.opening.openFetchM ? [i * cfg.fetch.rayStepDeg] : []));
  const widthDeg = open.length * cfg.fetch.rayStepDeg;
  if (open.length === 0) return { bearingDeg: null, widthDeg };
  const x = open.reduce((sum, deg) => sum + Math.sin(toRad(deg)), 0);
  const y = open.reduce((sum, deg) => sum + Math.cos(toRad(deg)), 0);
  if (Math.hypot(x, y) / open.length < cfg.opening.minResultant) return { bearingDeg: null, widthDeg };
  const deg = Math.round((Math.atan2(x, y) * 180) / Math.PI);
  return { bearingDeg: ((deg % 360) + 360) % 360, widthDeg };
}

/**
 * Swell protection, 0–1 (3 places). Sector fetch here is the sector's longest ray. When no ray
 * exceeds `longFetchM` there is no swell source: `noSourceValue`. Otherwise the least shelter among
 * the sectors reaching the longest fetch, multiplied by `wideOpeningFactor` when the rays with fetch
 * above `swell.openFetchM` together span more than `maxOpeningDeg`.
 */
export function swellProtection(rays: number[], sectors: Record<Sector, number>, cfg: GeometryConfig): number {
  checkRays(rays, cfg);
  const longest = bySector((sector) => Math.max(...sectorRayIndices(sector, cfg.fetch).map((i) => rays[i]!)));
  const max = Math.max(...SECTORS.map((s) => longest[s]));
  if (max <= cfg.swell.longFetchM) return cfg.swell.noSourceValue;
  const shelter = Math.min(...SECTORS.filter((s) => longest[s] === max).map((s) => sectors[s]));
  const openDeg = rays.filter((fetchM) => fetchM > cfg.swell.openFetchM).length * cfg.fetch.rayStepDeg;
  return round(openDeg > cfg.swell.maxOpeningDeg ? shelter * cfg.swell.wideOpeningFactor : shelter, 3);
}
