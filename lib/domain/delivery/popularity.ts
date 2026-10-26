import { sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { decideBerth, loadEvidence } from "@/lib/domain/research/confirmation";
import type { PlaceKind } from "@/lib/db/schema/geo";

/*
 * `score.popularity` 0-1 (spec 14, spec 18): the independent sources behind a place's confirmation, log-normalised within a
 * fixed neighbourhood across subdivisions (its maximum = 1). The per-place count is the one of the confirmation rule
 * (`decideBerth(...).independentSources`, design 7.3, ruling N6), not a profile's `sources_count`. A read-time value: it
 * depends on the other places nearby, so the same place has the same value in every package.
 */

const METRES_PER_NM = 1852;

/** `log(1 + n) / log(1 + max)`; `max = 0` gives 0. */
export function popularity(n: number, maxInNeighbourhood: number): number {
  if (maxInNeighbourhood <= 0) return 0;
  return Math.log(1 + n) / Math.log(1 + maxInNeighbourhood);
}

/** A confirmed place and the confirmed places within the neighbourhood distance of it (itself included). */
export type Neighbourhood = { geoObjectId: string; placeId: string; members: Array<{ placeId: string; kind: PlaceKind }> };

/**
 * Pure: popularity by geo object id from each place's neighbourhood and the independent-source count per place (a
 * member without a count counts 0).
 */
export function popularityFromCounts(neighbourhoods: Neighbourhood[], counts: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const nb of neighbourhoods) {
    const own = counts.get(nb.placeId) ?? 0;
    const max = Math.max(own, ...nb.members.map((m) => counts.get(m.placeId) ?? 0));
    out.set(nb.geoObjectId, popularity(own, max));
  }
  return out;
}

/**
 * For the places of the given geo objects: each one's neighbourhood, i.e. all valid places of every subdivision within
 * `neighbourhoodNm` of the place's `geo_objects.centroid` (geography distance), the place itself included. On the build
 * date `today`: confirmed, unmerged places valid on that date, whose geo object is valid and unmerged and whose tile is
 * valid. Other places neither get a neighbourhood nor count as a member.
 */
export async function loadNeighbourhoods(db: Db, geoObjectIds: string[], today: string, neighbourhoodNm: number): Promise<Neighbourhood[]> {
  if (geoObjectIds.length === 0) return [];
  // Cheap geometry box before the geography distance (which casts and cannot use a geometry index). The box is a superset
  // of the geography circle: latitude degrees from nm/60 with a 1 % margin (a degree of latitude spans at least 110.57 km
  // on the spheroid against the 111.12 km the nm/60 rule assumes); longitude degrees widen with 1/cos(latitude), taken at
  // the box's far edge and capped at 89 degrees so the divisor never vanishes. It ignores the antimeridian. The exact
  // ST_DWithin on geography below is the final filter, so the box only has to be generous, never tight.
  const dLat = (neighbourhoodNm / 60) * 1.01;
  const { rows } = await db.execute<{ geo_object_id: string; place_id: string; members: Array<{ id: string; kind: PlaceKind }> }>(sql`
    select a.geo_object_id, a.place_id, nb.members
    from (
      select p.id as place_id, p.geo_object_id, o.centroid
      from places p
      join tiles t on t.id = p.tile_id
       and t.valid_from <= ${today}::date and (t.valid_to is null or t.valid_to > ${today}::date)
      join geo_objects o on o.id = p.geo_object_id and o.merged_into_id is null
       and o.valid_from <= ${today}::date and (o.valid_to is null or o.valid_to > ${today}::date)
      where p.geo_object_id = any(${sql.param(geoObjectIds)}::uuid[])
        and p.status = 'confirmed' and p.merged_into_id is null
        and p.valid_from <= ${today}::date and (p.valid_to is null or p.valid_to > ${today}::date)
    ) a
    cross join lateral (
      select coalesce(json_agg(json_build_object('id', p.id, 'kind', p.kind)), '[]'::json) as members
      from places p
      join geo_objects o on o.id = p.geo_object_id and o.merged_into_id is null
       and o.valid_from <= ${today}::date and (o.valid_to is null or o.valid_to > ${today}::date)
      join tiles t on t.id = p.tile_id
       and t.valid_from <= ${today}::date and (t.valid_to is null or t.valid_to > ${today}::date)
      where p.status = 'confirmed' and p.merged_into_id is null
        and p.valid_from <= ${today}::date and (p.valid_to is null or p.valid_to > ${today}::date)
        and o.centroid && ST_Expand(
          a.centroid,
          ${dLat} / greatest(cos(radians(least(abs(ST_Y(a.centroid)) + ${dLat}, 89))), 0.0175),
          ${dLat})
        and ST_DWithin(a.centroid::geography, o.centroid::geography, ${neighbourhoodNm * METRES_PER_NM})
    ) nb
  `);
  return rows.map((r) => ({ geoObjectId: r.geo_object_id, placeId: r.place_id, members: r.members.map((m) => ({ placeId: m.id, kind: m.kind })) }));
}

/**
 * Geo object id to popularity for the given places (spec 18): `popularity(n, max)` over the independent sources of each
 * place's confirmation (`decideBerth`), `max` over the neighbourhood. One batched evidence load for every place of every
 * neighbourhood; `known` seeds counts the caller already has (place id to count), which are not loaded again. A place
 * that is not confirmed gets no value; a confirmed place without evidence counts 0.
 */
export async function popularityForPlaces(
  db: Db,
  geoObjectIds: string[],
  today: string,
  neighbourhoodNm: number,
  known: Map<string, number> = new Map(),
): Promise<Map<string, number>> {
  const neighbourhoods = await loadNeighbourhoods(db, geoObjectIds, today, neighbourhoodNm);
  const members = new Map<string, PlaceKind>();
  for (const nb of neighbourhoods) for (const m of nb.members) members.set(m.placeId, m.kind);
  const missing = [...members.keys()].filter((id) => !known.has(id));
  const config = getConfig();
  const evidence = await loadEvidence(db, missing, config);
  const counts = new Map(known);
  for (const id of missing) counts.set(id, decideBerth(members.get(id)!, evidence.get(id) ?? [], config.research.confirmation).independentSources.length);
  return popularityFromCounts(neighbourhoods, counts);
}
