import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

/*
 * `popularity` 0–1 (spec 07, spec 14): independent sources with a mention, log-normalized within the subdivision (its
 * maximum = 1). Read-time value: it depends on the other places of the subdivision, so it is not part of a stored profile.
 */

/** `log(1 + n) / log(1 + max)`; `max = 0` → 0. */
export function popularity(n: number, maxInSubdivision: number): number {
  if (maxInSubdivision <= 0) return 0;
  return Math.log(1 + n) / Math.log(1 + maxInSubdivision);
}

/**
 * Geo object id → popularity for the places of the subdivision (`geo_objects.subdivision_id`, the nearest land; never the
 * tile label `tiles.subdivision_id`) that have a profile, over the `sources_count` of each one's newest profile version.
 * On the run date `today` (ruling M5-E-R2): confirmed, unmerged places valid on that date, whose geo object is valid and
 * unmerged and whose tile is valid; other places neither get a value nor count towards the subdivision maximum.
 */
export async function popularityForSubdivision(db: Db, subdivisionId: string, today: string): Promise<Map<string, number>> {
  const { rows } = await db.execute<{ geo_object_id: string; sources_count: number }>(sql`
    select distinct on (pr.geo_object_id) pr.geo_object_id, pr.sources_count
    from places p
    join tiles t on t.id = p.tile_id
     and t.valid_from <= ${today}::date and (t.valid_to is null or t.valid_to > ${today}::date)
    join geo_objects o on o.id = p.geo_object_id and o.merged_into_id is null
     and o.valid_from <= ${today}::date and (o.valid_to is null or o.valid_to > ${today}::date)
    join profiles pr on pr.geo_object_id = p.geo_object_id
    where o.subdivision_id = ${subdivisionId} and p.status = 'confirmed' and p.merged_into_id is null
      and p.valid_from <= ${today}::date and (p.valid_to is null or p.valid_to > ${today}::date)
    order by pr.geo_object_id, pr.version desc
  `);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.sources_count)), 0);
  return new Map(rows.map((r) => [r.geo_object_id, popularity(Number(r.sources_count), max)]));
}
