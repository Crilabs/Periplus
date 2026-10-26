import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getConfig, type GazetteerConfig, type RestrictionsConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoNames, geoObjects, places, type GeoObjectType, type PlaceKind } from "@/lib/db/schema";
import { exclusionFor, exclusionReason, restrictionHits } from "@/lib/domain/geometry/restrictions";
import { createReviewTask } from "@/lib/domain/review";
import { validAt } from "@/lib/db/valid-at";

/** Geo object types that are always place candidates. */
const CANDIDATE_TYPES: GeoObjectType[] = ["bay", "harbour"];
/** `seamark:type` values that make any geo object a place candidate. */
const CANDIDATE_SEAMARK_TYPES = ["harbour", "anchorage", "mooring", "small_craft_facility"];

/**
 * The kind of a place from its geo object: `leisure=marina` or `seamark:type=small_craft_facility` → marina;
 * `seamark:type=mooring` or any `mooring` tag → mooring_field; type `harbour` or `seamark:type=harbour` → port;
 * else anchorage.
 */
export function placeKindFromTags(type: GeoObjectType, tags: Record<string, string>): PlaceKind {
  const seamark = tags["seamark:type"];
  if (tags.leisure === "marina" || seamark === "small_craft_facility") return "marina";
  if (seamark === "mooring" || tags.mooring !== undefined) return "mooring_field";
  if (type === "harbour" || seamark === "harbour") return "port";
  return "anchorage";
}

export type SeedResult = {
  /** New places (including those that start as `no_anchoring`). */
  created: number;
  /** Candidates whose place already existed; left untouched. */
  existing: number;
  /** Candidates whose position lies in another tile; that tile's run seeds them. */
  skippedOtherTile: number;
  /** Of `created`: places that start as `no_anchoring` because they lie in a restricted area. */
  noAnchoring: number;
};

type Candidate = {
  id: string;
  type: GeoObjectType;
  tags: Record<string, string>;
  /** EWKB hex of the position. */
  position: string;
  lon: number;
  lat: number;
  positionTileId: string;
};

/**
 * The place candidates linked to `tileId` with their position. Candidates: valid, unmerged objects of type
 * bay/harbour, or with a candidate `seamark:type`, or `leisure=marina`. Position: a point stays itself; for a
 * polygon it is the centroid of its water (the polygon minus the land polygons intersecting it), or a point on
 * that water's surface when the centroid is not in the water (concave bays), or a point on the polygon's surface
 * when it has no water; any other geometry yields a point on its surface.
 */
async function candidatesOf(db: Db, tileId: string): Promise<Candidate[]> {
  const { rows } = await db.execute<Candidate>(sql`
    with candidates as (
      select geo_objects.id, geo_objects.type, geo_objects.tags, geo_objects.geom
      from tile_geo_objects l
      join geo_objects on geo_objects.id = l.geo_object_id
      where l.tile_id = ${tileId}
        and geo_objects.merged_into_id is null
        and ${validAt(geoObjects)}
        and (geo_objects.type in ${CANDIDATE_TYPES}
          or geo_objects.tags->>'seamark:type' in ${CANDIDATE_SEAMARK_TYPES}
          or geo_objects.tags->>'leisure' = 'marina')
    ),
    positioned as (
      select c.id, c.type, c.tags,
        case
          when ST_Dimension(c.geom) < 2 then ST_PointOnSurface(c.geom)
          when ST_IsEmpty(w.water) then ST_PointOnSurface(c.geom)
          when ST_Within(ST_Centroid(w.water), w.water) then ST_Centroid(w.water)
          else ST_PointOnSurface(w.water)
        end as position
      from candidates c
      cross join lateral (
        select ST_Union(ST_Intersection(lp.geom, c.geom)) as land
        from land_polygons lp
        where ST_Dimension(c.geom) = 2 and lp.geom && c.geom and ST_Intersects(lp.geom, c.geom)
      ) land
      cross join lateral (
        select case when land.land is null then c.geom else ST_Difference(c.geom, land.land) end as water
      ) w
    )
    select id, type, tags, position::text as position, ST_X(position) as lon, ST_Y(position) as lat,
      tile_id_for(position) as "positionTileId"
    from positioned
    order by id`);
  return rows;
}

/** The display name of a geo object for the review list: German, else English, else any valid name. */
async function displayName(db: Db, geoObjectId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: geoNames.name })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, geoObjectId), validAt(geoNames)))
    .orderBy(
      sql`case ${geoNames.language} when 'de' then 0 when 'en' then 1 else 2 end`,
      sql`${geoNames.isPreferred} desc`,
      asc(geoNames.name),
    )
    .limit(1);
  return row?.name ?? null;
}

/**
 * Stage `seed.tile`, in one transaction: creates a place for every candidate of the tile whose position lies in
 * this tile (a candidate spanning several tiles is seeded once, by the tile of its position). A new place whose
 * position lies in a valid restricted area that bans anchoring (`exclusionFor` over `restrictionHits` of the
 * position, share 1) starts as `no_anchoring` with reason `restricted:<kind>:<id>`; any other new place starts as
 * `candidate` with a `place_candidate` review task. Existing places (any status) stay untouched, so a rerun
 * creates nothing. Serialised against the bay detection by its advisory lock (shared here).
 */
export async function seedTile(
  db: Db,
  tileId: string,
  cfg: GazetteerConfig,
  opts: { restrictions: RestrictionsConfig; minShare: number } = {
    restrictions: getConfig().restrictions,
    minShare: getConfig().geometry.restriction.minShare,
  },
): Promise<SeedResult> {
  const banConfig = {
    noAnchoringKinds: cfg.noAnchoringKinds,
    protectedAreaAnchoringBan: opts.restrictions.protectedAreaAnchoringBan,
  };
  return db.transaction(async (tx) => {
    const result: SeedResult = { created: 0, existing: 0, skippedOtherTile: 0, noAnchoring: 0 };
    const candidates = await candidatesOf(tx, tileId);
    const inTile = candidates.filter((c) => c.positionTileId === tileId);
    result.skippedOtherTile = candidates.length - inTile.length;
    if (inTile.length === 0) return result;
    // Shared with every other seed, exclusive against `geometry.detect_bays` (which takes it exclusively): a bay
    // detection running beside a seed then sees the places the seed creates, never a second candidate for the same
    // anchorage (CON-4).
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('geometry.detect_bays'))`);

    const existing = await tx
      .select({ geoObjectId: places.geoObjectId })
      .from(places)
      .where(inArray(places.geoObjectId, inTile.map((c) => c.id)));
    const existingIds = new Set(existing.map((p) => p.geoObjectId));

    for (const c of inTile) {
      if (existingIds.has(c.id)) {
        result.existing++;
        continue;
      }
      const kind = placeKindFromTags(c.type, c.tags);
      const hits = await restrictionHits(tx, { area: null, position: { lon: Number(c.lon), lat: Number(c.lat) } }, banConfig);
      const exclusion = exclusionFor(hits, opts.minShare);
      const restriction = exclusion ? exclusionReason(exclusion) : null;
      const [place] = await tx
        .insert(places)
        .values({
          geoObjectId: c.id,
          kind,
          status: restriction ? "no_anchoring" : "candidate",
          statusReason: restriction,
          position: sql`${c.position}::geometry`,
        })
        .onConflictDoNothing({ target: places.geoObjectId })
        .returning({ id: places.id });
      if (!place) {
        result.existing++; // created concurrently by another run
        continue;
      }
      result.created++;
      if (restriction) {
        result.noAnchoring++;
        continue;
      }
      await createReviewTask(tx, {
        kind: "place_candidate",
        subjectType: "place",
        subjectId: place.id,
        context: { geoObjectId: c.id, kind, tileId, name: await displayName(tx, c.id) },
      });
    }
    return result;
  });
}
