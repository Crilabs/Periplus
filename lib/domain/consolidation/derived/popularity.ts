import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

/*
 * `popularity` 0–1 (spec 07, spec 14): independent sources with a mention, log-normalized within a fixed neighbourhood across
 * subdivisions (spec 18; its maximum = 1). Read-time value: it depends on the other places nearby, so it is not part of a stored profile.
 */

const METRES_PER_NM = 1852;

/** `log(1 + n) / log(1 + max)`; `max = 0` → 0. */
export function popularity(n: number, maxInNeighbourhood: number): number {
  if (maxInNeighbourhood <= 0) return 0;
  return Math.log(1 + n) / Math.log(1 + maxInNeighbourhood);
}

/**
 * Geo object id → popularity for the given places (spec 18): `popularity(n, max)` over the `sources_count` of each
 * one's newest profile version, `max` over all valid places of every subdivision within `neighbourhoodNm` of the
 * place's `geo_objects.centroid` (geography distance), the place itself included. On the run date `today` (ruling
 * M5-E-R2): confirmed, unmerged places valid on that date, whose geo object is valid and unmerged and whose tile is
 * valid. Other places neither get a value nor count towards a maximum.
 */
export async function popularityForPlaces(
  db: Db,
  geoObjectIds: string[],
  today: string,
  neighbourhoodNm: number,
): Promise<Map<string, number>> {
  if (geoObjectIds.length === 0) return new Map();
  const { rows } = await db.execute<{ geo_object_id: string; sources_count: number; max_count: number }>(sql`
    with valid as (
      select distinct on (pr.geo_object_id) pr.geo_object_id, pr.sources_count, o.centroid
      from places p
      join tiles t on t.id = p.tile_id
       and t.valid_from <= ${today}::date and (t.valid_to is null or t.valid_to > ${today}::date)
      join geo_objects o on o.id = p.geo_object_id and o.merged_into_id is null
       and o.valid_from <= ${today}::date and (o.valid_to is null or o.valid_to > ${today}::date)
      join profiles pr on pr.geo_object_id = p.geo_object_id
      where p.status = 'confirmed' and p.merged_into_id is null
        and p.valid_from <= ${today}::date and (p.valid_to is null or p.valid_to > ${today}::date)
      order by pr.geo_object_id, pr.version desc
    )
    select a.geo_object_id, a.sources_count, max(b.sources_count) as max_count
    from valid a
    join valid b on ST_DWithin(a.centroid::geography, b.centroid::geography, ${neighbourhoodNm * METRES_PER_NM})
    where a.geo_object_id = any(${sql.param(geoObjectIds)}::uuid[])
    group by a.geo_object_id, a.sources_count
  `);
  return new Map(rows.map((r) => [r.geo_object_id, popularity(Number(r.sources_count), Number(r.max_count))]));
}
