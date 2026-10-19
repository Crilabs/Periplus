import { sql } from "drizzle-orm";
import type { GeometryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { utmSridFor } from "./projection";
import type { LonLat } from "./water";

/** Margin on the index box around the ray circle, so edge curvature after the transform to WGS84 cannot cut it. */
const BOX_MARGIN = 1.02;

/**
 * Fetch per ray in whole metres: `rayCount` rays every `rayStepDeg` from `origin` (ray 0 = grid north,
 * clockwise) in the place's UTM zone, each the distance to its first intersection with land, `maxRayM`
 * without one. `landVersions` = sorted dataset versions of the land polygons within `maxRayM`.
 */
export async function computeFetch(
  db: Db,
  origin: LonLat,
  cfg: GeometryConfig,
): Promise<{ rays: number[]; srid: number; landVersions: string[] }> {
  const srid = utmSridFor(origin.lon, origin.lat);
  const { rayCount, rayStepDeg, maxRayM } = cfg.fetch;
  const { rows } = await db.execute<{ rays: number[]; versions: string[] | null }>(sql`
    with o as (
      select g, ST_Transform(g, ${srid}::int) as p
      from (select ST_SetSRID(ST_MakePoint(${origin.lon}::float8, ${origin.lat}::float8), 4326) as g) t
    ),
    land as (
      select ST_Transform(l.geom, ${srid}::int) as geom, l.dataset_version
      from land_polygons l, o
      where l.geom && ST_Transform(ST_Expand(o.p, ${maxRayM * BOX_MARGIN}::float8), 4326)
        and ST_DWithin(l.geom::geography, o.g::geography, ${maxRayM}::float8)
    ),
    rays as (
      select i, ST_MakeLine(o.p, ST_Translate(o.p,
               ${maxRayM}::float8 * sin(radians(i * ${rayStepDeg}::float8)),
               ${maxRayM}::float8 * cos(radians(i * ${rayStepDeg}::float8)))) as line
      from o, generate_series(0, ${rayCount}::int - 1) as i
    ),
    hits as (
      select r.i, round(coalesce(min(ST_Distance(o.p, ST_Intersection(r.line, land.geom))), ${maxRayM}::float8))::int as m
      from o, rays r left join land on ST_Intersects(r.line, land.geom)
      group by r.i
    )
    select (select json_agg(m order by i) from hits) as rays,
           (select array_agg(distinct dataset_version order by dataset_version) from land) as versions`);
  const row = rows[0]!;
  return { rays: row.rays.map(Number), srid, landVersions: row.versions ?? [] };
}
