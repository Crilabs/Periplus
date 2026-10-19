import { sql } from "drizzle-orm";
import type { Geometry } from "geojson";
import type { GeometryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import type { LonLat } from "./water";

export type DepthRange = {
  min: number;
  max: number;
  /** Coarsest resolution among the contributing datasets (drives `depthConfidence`). */
  resolutionM: number;
  datasets: Array<{ dataset: string; version: string; resolutionM: number }>;
};

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Depths (m, LAT, 0.1 m) at `distancesM` from `origin` along `bearingDeg`, each from the finest raster
 * covering the point. Nodata, values ≤ 0 (land/dry) and points without coverage → null.
 */
export async function sampleDepths(
  db: Db,
  origin: LonLat,
  bearingDeg: number,
  distancesM: number[],
): Promise<Array<number | null>> {
  if (distancesM.length === 0) return [];
  const { rows } = await db.execute<{ i: number; v: number | null }>(sql`
    with pts as (
      select d.i, ST_Project(
               ST_SetSRID(ST_MakePoint(${origin.lon}::float8, ${origin.lat}::float8), 4326)::geography,
               d.dist, radians(${bearingDeg}::float8))::geometry as p
      from unnest(${`{${distancesM.join(",")}}`}::float8[]) with ordinality as d(dist, i)
    )
    select pts.i, s.v
    from pts
    left join lateral (
      select ST_Value(b.rast, 1, pts.p) as v
      from bathymetry b
      where ST_ConvexHull(b.rast) && pts.p and ST_Intersects(b.rast, pts.p)
      order by b.resolution_m asc, ST_Value(b.rast, 1, pts.p) is null
      limit 1
    ) s on true
    order by pts.i`);
  return rows.map((r) => (r.v !== null && Number(r.v) > 0 ? round1(Number(r.v)) : null));
}

/**
 * Minimum and maximum depth (m, LAT, 0.1 m) of the raster pixels inside `area` (ST_Clip: pixel centre
 * inside), only values > 0, over every raster intersecting the area. `null` without such pixels.
 */
export async function depthRange(db: Db, area: Geometry): Promise<DepthRange | null> {
  const { rows } = await db.execute<{ dataset: string; version: string; resolution_m: number; min: number; max: number }>(sql`
    with a as (select ${geomFromGeoJson(area)} as geom),
    px as (
      select b.dataset, b.dataset_version, b.resolution_m, (ST_PixelAsCentroids(ST_Clip(b.rast, 1, a.geom, true), 1)).val
      from bathymetry b, a
      where ST_ConvexHull(b.rast) && a.geom and ST_Intersects(b.rast, a.geom)
    )
    select dataset, dataset_version as version, resolution_m, min(val) as min, max(val) as max
    from px
    where val > 0
    group by dataset, dataset_version, resolution_m
    order by resolution_m, dataset, dataset_version`);
  if (rows.length === 0) return null;
  return {
    min: round1(Math.min(...rows.map((r) => Number(r.min)))),
    max: round1(Math.max(...rows.map((r) => Number(r.max)))),
    resolutionM: Math.max(...rows.map((r) => Number(r.resolution_m))),
    datasets: rows.map((r) => ({ dataset: r.dataset, version: r.version, resolutionM: Number(r.resolution_m) })),
  };
}

/**
 * Confidence of a depth value: high-resolution DTM (≤ `hrResolutionM`) `confidenceHr`; a coarser raster
 * `confidenceCoarseWide` for bays at least `minBayWidthM` wide, else `confidenceCoarseNarrow`.
 */
export function depthConfidence(resolutionM: number, bayWidthM: number, cfg: GeometryConfig["depth"]): number {
  if (resolutionM <= cfg.hrResolutionM) return cfg.confidenceHr;
  return bayWidthM >= cfg.minBayWidthM ? cfg.confidenceCoarseWide : cfg.confidenceCoarseNarrow;
}
