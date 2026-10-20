import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { subdivisionTilesSql } from "@/lib/domain/gazetteer/tiles-ensure";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";

/**
 * The subdivision's geo objects as `verifyRevisit` and the scenario draft scope them: the subdivision's own geo object,
 * every object of its scope tiles (`subdivisionTilesSql`, `tile_geo_objects`: places, POIs, regions) and the places on
 * those tiles. Ordered by id. Throws for an unknown or excluded subdivision and for a leftover area key.
 */
export async function subdivisionObjectIds(db: Db, subdivisionKey: string): Promise<string[]> {
  const sub = await requireSubdivision(db, subdivisionKey);
  const { rows } = await db.execute<{ id: string }>(sql`
    with scope_tiles as (${subdivisionTilesSql(sql`${sub.id}::uuid`)})
    select s.geo_object_id as id from subdivisions s where s.id = ${sub.id}::uuid
    union select tgo.geo_object_id from tile_geo_objects tgo where tgo.tile_id in (select id from scope_tiles)
    union select p.geo_object_id from places p where p.tile_id in (select id from scope_tiles)
    order by 1
  `);
  return rows.map((r) => r.id);
}
