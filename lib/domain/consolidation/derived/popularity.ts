import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

/*
 * `popularity` 0–1 (spec 07): independent sources with a mention, log-normalized within the area (the area's maximum
 * = 1). Read-time value: it depends on the other places of the area, so it is not part of a stored profile.
 */

/** `log(1 + n) / log(1 + max)`; `max = 0` → 0. */
export function popularity(n: number, maxInArea: number): number {
  if (maxInArea <= 0) return 0;
  return Math.log(1 + n) / Math.log(1 + maxInArea);
}

/**
 * Geo object id → popularity for the places of the area (`tiles.area_id`, the area's geo object id) that have a
 * profile, over the `sources_count` of each one's newest profile version. Valid, unmerged, not rejected places only.
 */
export async function popularityForArea(db: Db, areaId: string): Promise<Map<string, number>> {
  const { rows } = await db.execute<{ geo_object_id: string; sources_count: number }>(sql`
    select distinct on (pr.geo_object_id) pr.geo_object_id, pr.sources_count
    from places p
    join tiles t on t.id = p.tile_id
    join profiles pr on pr.geo_object_id = p.geo_object_id
    where t.area_id = ${areaId} and p.valid_to is null and p.merged_into_id is null and p.status <> 'rejected'
    order by pr.geo_object_id, pr.version desc
  `);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.sources_count)), 0);
  return new Map(rows.map((r) => [r.geo_object_id, popularity(Number(r.sources_count), max)]));
}
