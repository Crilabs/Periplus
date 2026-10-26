import { sql } from "drizzle-orm";
import type { LineString, Polygon } from "geojson";
import type { Db } from "@/lib/db/client";
import type { Bbox } from "@/lib/domain/tiles";

export type HarbourStructure = { osmId: string; manMade: string; geometry: LineString | Polygon };

/**
 * Replaces the harbour structures of one import box in one transaction, as `replaceRoads`: structures intersecting
 * `box` that the import no longer contains are deleted, every imported one is inserted or updated by `osm_id`. Every
 * `osmId` must be unique; an invalid OSM polygon is stored made valid (`ST_MakeValid`), so buffering it never fails.
 * A subdivision has a few thousand, so one statement carries them all.
 */
export async function replaceHarbourStructures(
  db: Db,
  input: { box: Bbox; datasetVersion: string; structures: HarbourStructure[] },
): Promise<{ stored: number; removed: number }> {
  const seen = new Set<string>();
  for (const s of input.structures) {
    if (seen.has(s.osmId)) throw new Error(`duplicate harbour structure ${s.osmId}`);
    seen.add(s.osmId);
  }
  const [west, south, east, north] = input.box;
  const box = sql`ST_MakeEnvelope(${west}::float8, ${south}::float8, ${east}::float8, ${north}::float8, 4326)`;
  const ids = JSON.stringify(input.structures.map((s) => s.osmId));
  const rows = JSON.stringify(input.structures.map((s) => ({ osm_id: s.osmId, man_made: s.manMade, geometry: s.geometry })));
  return db.transaction(async (tx) => {
    const { rows: removed } = await tx.execute<{ id: string }>(sql`
      delete from harbour_structures h
      where h.geom && ${box} and ST_Intersects(h.geom, ${box})
        and not exists (select 1 from jsonb_array_elements_text(${ids}::jsonb) u(osm_id) where u.osm_id = h.osm_id)
      returning h.id`);
    if (input.structures.length === 0) return { stored: 0, removed: removed.length };
    const { rows: stored } = await tx.execute<{ id: string }>(sql`
      insert into harbour_structures (id, osm_id, man_made, geom, dataset_version)
      select gen_random_uuid(), f->>'osm_id', f->>'man_made',
             ST_MakeValid(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(f->'geometry'), 4326))), ${input.datasetVersion}
      from jsonb_array_elements(${rows}::jsonb) f
      on conflict (osm_id) do update
        set man_made = excluded.man_made, geom = excluded.geom, dataset_version = excluded.dataset_version
      returning harbour_structures.id`);
    return { stored: stored.length, removed: removed.length };
  });
}
