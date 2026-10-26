import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { jsonTexts } from "@/lib/db/json-texts";
import { tileNeighbours } from "@/lib/domain/tiles";

const validNow = (alias: string) =>
  sql.raw(`${alias}.valid_from <= current_date and (${alias}.valid_to is null or ${alias}.valid_to > current_date)`);

/** The tiles plus `ring` rings of neighbours (1 = the 8 neighbours, 2 = the 24 tiles around). */
export function withNeighbours(tiles: Iterable<string>, ring: number): string[] {
  let current = new Set(tiles);
  for (let r = 0; r < ring; r++) {
    const next = new Set(current);
    for (const id of current) for (const n of tileNeighbours(id)) next.add(n);
    current = next;
  }
  return [...current].sort();
}

/**
 * The valid objects of the tiles (`tile_geo_objects`, areas included) and all their valid ancestors (an island named in
 * a text about one of its bays), in id order.
 */
export async function candidateObjects(db: Db, tiles: string[]): Promise<string[]> {
  if (tiles.length === 0) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    with recursive base as (
      select tgo.geo_object_id as id from tile_geo_objects tgo where tgo.tile_id in ${jsonTexts(tiles)}
    ),
    up as (
      select o.id, o.parent_id from geo_objects o join base on base.id = o.id
      where ${validNow("o")} and o.merged_into_id is null
      union
      select p.id, p.parent_id from geo_objects p join up on p.id = up.parent_id
      where ${validNow("p")} and p.merged_into_id is null
    )
    select distinct id from up order by id
  `);
  return rows.map((r) => r.id);
}
