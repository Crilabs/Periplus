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
  // Cheap geometry box before the geography distance (which casts and cannot use a geometry index). The set is driven
  // from `places` (a few thousand confirmed rows), not from `geo_objects_centroid_gist`: nearly every geo object lies
  // in the box (measured on dev: 22960 of 29182), so the index would only feed the expensive distance. The box is
  // a superset of the geography circle: latitude degrees from nm/60 with a 1 % margin (a degree of latitude spans at
  // least 110.57 km on the spheroid against the 111.12 km the nm/60 rule assumes); longitude degrees widen with
  // 1/cos(latitude), taken at the box's far edge and capped at 89° so the divisor never vanishes (correct beyond
  // 70° latitude and far outside the Mediterranean). It ignores the antimeridian. The exact ST_DWithin on geography
  // below is the final filter, so the box only has to be generous, never tight.
  const dLat = (neighbourhoodNm / 60) * 1.01;
  const { rows } = await db.execute<{ geo_object_id: string; sources_count: number; max_count: number }>(sql`
    select a.geo_object_id, a.sources_count, nb.max_count
    from (
      select p.geo_object_id, pr.sources_count, o.centroid
      from places p
      join tiles t on t.id = p.tile_id
       and t.valid_from <= ${today}::date and (t.valid_to is null or t.valid_to > ${today}::date)
      join geo_objects o on o.id = p.geo_object_id and o.merged_into_id is null
       and o.valid_from <= ${today}::date and (o.valid_to is null or o.valid_to > ${today}::date)
      cross join lateral (select sources_count from profiles where geo_object_id = p.geo_object_id order by version desc limit 1) pr
      where p.geo_object_id = any(${sql.param(geoObjectIds)}::uuid[])
        and p.status = 'confirmed' and p.merged_into_id is null
        and p.valid_from <= ${today}::date and (p.valid_to is null or p.valid_to > ${today}::date)
    ) a
    cross join lateral (
      select max(pr.sources_count) as max_count
      from places p
      join geo_objects o on o.id = p.geo_object_id and o.merged_into_id is null
       and o.valid_from <= ${today}::date and (o.valid_to is null or o.valid_to > ${today}::date)
      join tiles t on t.id = p.tile_id
       and t.valid_from <= ${today}::date and (t.valid_to is null or t.valid_to > ${today}::date)
      cross join lateral (select sources_count from profiles where geo_object_id = o.id order by version desc limit 1) pr
      where p.status = 'confirmed' and p.merged_into_id is null
        and p.valid_from <= ${today}::date and (p.valid_to is null or p.valid_to > ${today}::date)
        and o.centroid && ST_Expand(
          a.centroid,
          ${dLat} / greatest(cos(radians(least(abs(ST_Y(a.centroid)) + ${dLat}, 89))), 0.0175),
          ${dLat})
        and ST_DWithin(a.centroid::geography, o.centroid::geography, ${neighbourhoodNm * METRES_PER_NM})
    ) nb
  `);
  return new Map(rows.map((r) => [r.geo_object_id, popularity(Number(r.sources_count), Number(r.max_count))]));
}
