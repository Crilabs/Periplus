import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { bufferBbox } from "@/lib/domain/gazetteer/land";
import type { Bbox } from "@/lib/domain/tiles";

/** Vertex limit of a sea piece; IHO sea polygons have up to ~200,000 points, too many for a per-point distance. */
const SEA_PART_VERTICES = 128;
/**
 * Sea pieces compared exactly per point: the nearest by the index (`<->`), as in `setSubdivisions`. The preselection
 * is planar (degrees), fine at Mediterranean latitudes for the 20 km threshold.
 */
const NEAREST_SEA_PARTS = 10;

/**
 * Keys of the `points` that lie within `km` of an IHO sea (`geo_objects` type `sea`, origin `marine_regions`, valid).
 * The sea polygons are cut into small pieces in a temp table with a gist index; per point only the nearest pieces
 * are measured exactly (`ST_DWithin` on the geography). Measuring whole sea polygons takes far too long.
 */
export async function nearSea(
  db: Db,
  points: Array<{ key: string; lon: number; lat: number }>,
  km: number,
): Promise<Set<string>> {
  if (points.length === 0) return new Set();
  return db.transaction(async (tx) => {
    await tx.execute(sql`drop table if exists pg_temp.poi_sea_parts`);
    await tx.execute(sql`
      create temp table poi_sea_parts on commit drop as
      select ST_Subdivide(s.geom, ${SEA_PART_VERTICES}) as geom
      from geo_objects s
      where s.type = 'sea' and s.origin = 'marine_regions' and s.valid_to is null and s.geom is not null`);
    await tx.execute(sql`create index on poi_sea_parts using gist (geom)`);
    await tx.execute(sql`analyze poi_sea_parts`);
    const { rows } = await tx.execute<{ key: string }>(sql`
      select q.key
      from jsonb_to_recordset(${JSON.stringify(points)}::jsonb) as q(key text, lon double precision, lat double precision)
      cross join lateral (select ST_SetSRID(ST_MakePoint(q.lon, q.lat), 4326) as g) pt
      where exists (
        select 1 from (
          select p.geom from poi_sea_parts p order by p.geom <-> pt.g limit ${NEAREST_SEA_PARTS}) n
        where ST_DWithin(n.geom::geography, pt.g::geography, ${km * 1000}))`);
    return new Set(rows.map((r) => r.key));
  });
}

/**
 * Throws when no valid IHO sea (`type` `sea`, origin `marine_regions`) intersects `bbox` plus `km`: `nearSea` would
 * silently drop every POI. Run it before an import that filters POIs by the sea distance.
 */
export async function assertSeasPresent(db: Db, bbox: Bbox, km: number, key: string): Promise<void> {
  const [w, s, e, n] = bufferBbox(bbox, km);
  const { rows } = await db.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from geo_objects g
      where g.type = 'sea' and g.origin = 'marine_regions' and g.valid_to is null
        and g.geom && ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)) as found`);
  if (!rows[0]!.found) throw new Error(`IHO seas missing for ${key} – run „Landesteile neu bilden“ (gazetteer.coarse) first`);
}
