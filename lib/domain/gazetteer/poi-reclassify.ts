import { sql } from "drizzle-orm";
import type { CategoriesConfig } from "@/lib/config";
import { consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import type { Db } from "@/lib/db/client";
import type { PoiCategory } from "@/lib/db/schema";
import { validAtAlias } from "@/lib/domain/timeline";
import { categoryForTags } from "./osm-classify";

export type ReclassifyResult = { cleared: number; changed: number; geoObjectIds: string[] };

type PoiRow = { id: string; category: PoiCategory | null; tags: Record<string, string> };

/**
 * Re-applies `categories.osm` to the stored OSM POIs (spec 16 A): valid, unmerged `poi` rows of origin `osm` with
 * tags (Wikidata and review POIs carry none and keep their category). A POI whose category differs gets the new one,
 * or none (delivery then drops it). Returns the ids of the geo objects with a place within `poiRadiusM` of a changed
 * POI: their profiles are stale and need a new consolidation. `dryRun` counts only and writes nothing.
 */
export async function reclassifyPois(
  db: Db,
  categories: CategoriesConfig,
  opts: { dryRun?: boolean; radiusM?: number } = {},
): Promise<ReclassifyResult> {
  const radiusM = opts.radiusM ?? (await consolidationConfigFor(db)).rules.highlight.poiRadiusM;
  const { rows } = await db.execute<PoiRow>(sql`
    select o.id, o.category::text as category, o.tags
    from geo_objects o
    where o.type = 'poi' and o.origin = 'osm' and o.merged_into_id is null and o.valid_to is null
      and o.tags <> '{}'::jsonb
  `);
  const changedIds: string[] = [];
  let cleared = 0;
  let changed = 0;
  for (const row of rows) {
    const next = categoryForTags(row.tags, categories);
    if (next === row.category) continue;
    changedIds.push(row.id);
    if (next === null) cleared++;
    else changed++;
    if (!opts.dryRun) await db.execute(sql`update geo_objects set category = ${next}::poi_category where id = ${row.id}`);
  }
  if (changedIds.length === 0) return { cleared, changed, geoObjectIds: [] };

  const ids = sql.join(changedIds.map((id) => sql`${id}::uuid`), sql`, `);
  const { rows: near } = await db.execute<{ id: string }>(sql`
    select distinct p.geo_object_id as id
    from geo_objects o
    join places p
      on ${validAtAlias("p", sql`current_date`)} and p.merged_into_id is null and p.status <> 'rejected'
     and p.position && ST_Expand(o.geom, ${radiusM}::float8 / (111320 * cos(radians(ST_Y(o.geom)))))
     and ST_DWithin(o.geom::geography, p.position::geography, ${radiusM}::float8)
    where o.id in (${ids})
    order by 1
  `);
  return { cleared, changed, geoObjectIds: near.map((r) => r.id) };
}
