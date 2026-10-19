import { sql } from "drizzle-orm";
import type { LineString } from "geojson";
import type { Db } from "@/lib/db/client";
import type { Bbox } from "@/lib/domain/tiles";

export type RoadFeature = { osmId: string; highway: string; geometry: LineString };

/**
 * Replaces the roads of one import box in one transaction: roads intersecting `box` that the import no
 * longer contains are deleted, every imported road is inserted or updated by `osm_id` (a way reaching
 * into several boxes stays one row). Every `osmId` must be unique.
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
  const rows = JSON.stringify(input.roads.map((r) => ({ osm_id: r.osmId, highway: r.highway, geometry: r.geometry })));

  return db.transaction(async (tx) => {
    const { rows: removed } = await tx.execute<{ id: string }>(sql`
      delete from roads
      where roads.geom && ${box} and ST_Intersects(roads.geom, ${box})
        and roads.osm_id not in (select f->>'osm_id' from jsonb_array_elements(${rows}::jsonb) f)
      returning roads.id`);
    if (input.roads.length === 0) return { stored: 0, removed: removed.length };
    const { rows: stored } = await tx.execute<{ id: string }>(sql`
      insert into roads (id, osm_id, highway, geom, dataset_version)
      select gen_random_uuid(), f->>'osm_id', f->>'highway',
             ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(f->'geometry'), 4326)), ${input.datasetVersion}
      from jsonb_array_elements(${rows}::jsonb) f
      on conflict (osm_id) do update
        set highway = excluded.highway, geom = excluded.geom, dataset_version = excluded.dataset_version
      returning roads.id`);
    return { stored: stored.length, removed: removed.length };
  });
}
