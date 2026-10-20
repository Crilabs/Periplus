import { sql } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { GeoObjectType } from "@/lib/db/schema";
import { jsonTexts, jsonUuids } from "@/lib/domain/mentions/scope";

/*
 * Polygon of an area (spec 14, „Finden“ step 6): a gulf member covering the other members is the polygon; otherwise
 * the concave hull of the members' geometries, buffered on the sphere and cut back to the water and the coast (land
 * more than `inlandCutM` inland is removed). The model never produces coordinates.
 */

const NM_M = 1852;
/** Member types whose polygon may stand for the whole area. */
const GULF_TYPES: readonly GeoObjectType[] = ["gulf", "bay"];

export type AreaPolygon = {
  /** MultiPolygon, SRID 4326, as hex EWKB (`geometry::text`), so it round-trips exactly for `ST_Equals`. */
  geom: string;
  origin: "computed" | "gulf";
};

/**
 * The polygon of an area with the given members; null when fewer than `minMembers` of them are valid objects with a
 * non-empty geometry (or the cut leaves nothing).
 * - Gulf rule: a `gulf`/`bay` member with an area whose polygon covers (the point on surface of) at least
 *   `gulfCoverShare` of the other members; among several, the one covering most, then the largest.
 * - Else `ST_ConcaveHull(ST_Collect(geoms), concaveRatio)` (a point or line for single or collinear members),
 *   buffered by `bufferNm` nautical miles as geography, minus the land polygons meeting the buffer's box shrunk by
 *   `inlandCutM` (geography), made valid and reduced to its polygons.
 */
export async function computeAreaPolygon(db: Db, memberIds: string[], cfg: AppConfig): Promise<AreaPolygon | null> {
  const ids = [...new Set(memberIds)];
  if (ids.length === 0) return null;
  const p = cfg.areas.polygon;
  const { rows } = await db.execute<{ n: number; gulf: string | null; hull: string | null }>(sql`
    with m as (
      select o.id, o.type, o.geom, o.centroid from geo_objects o
      where o.id in ${jsonUuids(ids)} and o.merged_into_id is null
        and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
        and not ST_IsEmpty(o.geom)
    ),
    n as (select count(*)::int as n from m),
    gulf as (
      select g.geom, c.covered from m g
      cross join lateral (
        select count(*)::int as covered from m o where o.id <> g.id and ST_Covers(g.geom, o.centroid)
      ) c
      where g.type::text in ${jsonTexts(GULF_TYPES)} and ST_Dimension(g.geom) = 2
        and c.covered >= ${p.gulfCoverShare}::float8 * ((select n from n) - 1)
      order by c.covered desc, ST_Area(g.geom::geography) desc, g.id
      limit 1
    ),
    buf as (
      select ST_Buffer(ST_ConcaveHull(ST_Collect(m.geom order by m.id), ${p.concaveRatio}::float8)::geography,
                       ${p.bufferNm * NM_M}::float8)::geometry as b
      from m
    ),
    inland as (
      select ST_Buffer(ST_Union(l.geom)::geography, ${-p.inlandCutM}::float8)::geometry as g
      from land_polygons l, buf where l.geom && buf.b
    ),
    hull as (
      select ST_Multi(ST_CollectionExtract(ST_MakeValid(
               case when inland.g is null or ST_IsEmpty(inland.g) then buf.b else ST_Difference(buf.b, inland.g) end
             ), 3)) as h
      from buf, inland
    )
    select (select n from n) as n,
           (select ST_Multi(geom)::text from gulf) as gulf,
           (select case when ST_IsEmpty(h) then null else h::text end from hull) as hull`);
  const row = rows[0]!;
  if (row.n < cfg.areas.minMembers) return null;
  if (row.gulf) return { geom: row.gulf, origin: "gulf" };
  return row.hull ? { geom: row.hull, origin: "computed" } : null;
}
