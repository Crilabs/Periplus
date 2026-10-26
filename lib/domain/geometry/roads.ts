import { sql } from "drizzle-orm";
import type { LineString } from "geojson";
import type { Db } from "@/lib/db/client";
import type { Bbox } from "@/lib/domain/tiles";

export type RoadFeature = { osmId: string; highway: string; geometry: LineString };

/**
 * Roads per insert statement. The roads of Attica (Athens) are a 268 MB Overpass answer; one statement carrying every
 * feature as jsonb, and the stale-row delete expanding that jsonb inside `NOT IN`, killed the 2 GB database (N7 check).
 */
export const ROADS_PER_STATEMENT = 1000;

/**
 * Replaces the roads of one import box in one transaction: roads intersecting `box` that the import no
 * longer contains are deleted, every imported road is inserted or updated by `osm_id` (a way reaching
 * into several boxes stays one row). Every `osmId` must be unique. The delete compares against the plain list of
 * ids (an anti-join over the id list), the inserts carry `ROADS_PER_STATEMENT` features each, so no statement holds
 * the whole answer.
 */
export async function replaceRoads(
  db: Db,
  input: { box: Bbox; datasetVersion: string; roads: RoadFeature[] },
): Promise<{ stored: number; removed: number }> {
  const seen = new Set<string>();
  for (const road of input.roads) {
    if (seen.has(road.osmId)) throw new Error(`duplicate road ${road.osmId}`);
    seen.add(road.osmId);
  }
  const [west, south, east, north] = input.box;
  const box = sql`ST_MakeEnvelope(${west}::float8, ${south}::float8, ${east}::float8, ${north}::float8, 4326)`;
  // the ids alone (a few MB for Attica), as a JSON list: the driver would spread a JS array into a row of parameters
  const ids = JSON.stringify(input.roads.map((r) => r.osmId));

  return db.transaction(async (tx) => {
    const { rows: removed } = await tx.execute<{ id: string }>(sql`
      delete from roads
      where roads.geom && ${box} and ST_Intersects(roads.geom, ${box})
        and not exists (select 1 from jsonb_array_elements_text(${ids}::jsonb) u(osm_id) where u.osm_id = roads.osm_id)
      returning roads.id`);
    let stored = 0;
    for (let i = 0; i < input.roads.length; i += ROADS_PER_STATEMENT) {
      const rows = JSON.stringify(
        input.roads.slice(i, i + ROADS_PER_STATEMENT).map((r) => ({ osm_id: r.osmId, highway: r.highway, geometry: r.geometry })),
      );
      const { rows: inserted } = await tx.execute<{ id: string }>(sql`
        insert into roads (id, osm_id, highway, geom, dataset_version)
        select gen_random_uuid(), f->>'osm_id', f->>'highway',
               ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(f->'geometry'), 4326)), ${input.datasetVersion}
        from jsonb_array_elements(${rows}::jsonb) f
        on conflict (osm_id) do update
          set highway = excluded.highway, geom = excluded.geom, dataset_version = excluded.dataset_version
        returning roads.id`);
      stored += inserted.length;
    }
    return { stored, removed: removed.length };
  });
}
