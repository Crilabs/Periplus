import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getConfig, type GazetteerConfig, type RestrictionsConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoNames, geoObjects, places, type GeoObjectType, type PlaceKind } from "@/lib/db/schema";
import { assignParentOf } from "@/lib/domain/gazetteer/hierarchy";
import { addNames } from "@/lib/domain/gazetteer/names";
import { exclusionFor, exclusionReason, restrictionHits } from "@/lib/domain/geometry/restrictions";
import { createReviewTask } from "@/lib/domain/review";
import { validAt, validAtAlias } from "@/lib/db/valid-at";

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
  /** Beaches (`seedBeaches`): new places (also in `created`) and unnamed places that took a beach's names. */
  beaches: { created: number; named: number };
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
    const result: SeedResult = { created: 0, existing: 0, skippedOtherTile: 0, noAnchoring: 0, beaches: { created: 0, named: 0 } };
    const candidates = await candidatesOf(tx, tileId);
    const inTile = candidates.filter((c) => c.positionTileId === tileId);
    result.skippedOtherTile = candidates.length - inTile.length;
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
    // After the other candidates, so a beach in front of a bay finds the bay's place.
    await seedBeaches(tx, tileId, cfg, banConfig, opts.minShare, result);
    return result;
  });
}

type BeachSpot = {
  id: string;
  /** EWKB hex of the point `offshoreM` off the shore in front of the beach. */
  position: string;
  lon: number;
  lat: number;
  positionTileId: string;
  /** The nearest place within `mergeM` of the position and whether its geo object has a valid name; null without one. */
  nearPlaceObjectId: string | null;
  nearPlaceNamed: boolean;
};

/**
 * The named beaches linked to `tileId` (poi of category `beach`) within `coastM` of the coast, each with the point in the
 * water in front of it: the point of the water at least `offshoreM` from land (within `coastM` + 2 × `offshoreM` of
 * the beach) nearest to the beach. A beach without such water (inland, or the coast too far) is left out.
 */
async function beachSpotsOf(db: Db, tileId: string, cfg: GazetteerConfig["beachCandidates"]): Promise<BeachSpot[]> {
  const { coastM, mergeM, offshoreM } = cfg;
  const { rows } = await db.execute<BeachSpot>(sql`
    with beaches as (
      select g.id, g.geom,
        ST_Buffer(g.geom::geography, ${coastM + 2 * offshoreM}::float8)::geometry as reach
      from tile_geo_objects l
      join geo_objects g on g.id = l.geo_object_id
      where l.tile_id = ${tileId}
        and g.type = 'poi' and g.category = 'beach'
        and g.merged_into_id is null
        and ${validAtAlias("g")}
        and exists (select 1 from geo_names n where n.geo_object_id = g.id and n.valid_to is null)
    ),
    shore as (
      select b.id, b.geom, b.reach,
        (select ST_Union(ST_Intersection(lp.geom, b.reach)) from land_polygons lp
         where lp.geom && b.reach and ST_Intersects(lp.geom, b.reach)) as land
      from beaches b
    ),
    water as (
      select s.id, s.geom,
        case when s.land is null then null
          else ST_Difference(s.reach, ST_Buffer(s.land::geography, ${offshoreM}::float8)::geometry) end as open_water,
        s.land is not null
          and not ST_IsEmpty(ST_Difference(ST_Buffer(s.geom::geography, ${coastM}::float8)::geometry, s.land)) as coastal
      from shore s
    ),
    spots as (
      select w.id, ST_ClosestPoint(w.open_water, ST_Centroid(w.geom)) as position
      from water w
      where w.coastal and w.open_water is not null and not ST_IsEmpty(w.open_water)
    )
    select sp.id, sp.position::text as position, ST_X(sp.position) as lon, ST_Y(sp.position) as lat,
      tile_id_for(sp.position) as "positionTileId",
      near.geo_object_id as "nearPlaceObjectId",
      coalesce(near.named, false) as "nearPlaceNamed"
    from spots sp
    left join lateral (
      select p.geo_object_id,
        exists (select 1 from geo_names n where n.geo_object_id = p.geo_object_id and n.valid_to is null) as named
      from places p
      where ST_DWithin(p.position::geography, sp.position::geography, ${mergeM}::float8)
      order by p.position::geography <-> sp.position::geography
      limit 1
    ) near on true
    order by sp.id`);
  return rows;
}

/** The valid names of a geo object as drafts (without transliterations and fallbacks, which `addNames` derives). */
async function namesOf(db: Db, geoObjectId: string) {
  return db
    .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin, isPreferred: geoNames.isPreferred })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, geoObjectId), validAt(geoNames), sql`${geoNames.origin} not in ('transliteration', 'fallback')`));
}

/**
 * Beaches as anchorage candidates (Attika 2, B28: anchorages in front of beaches on open coast had no candidate). Per
 * named coastal beach of the tile (`beachSpotsOf`), whose point in front of it lies in this tile: with a place within
 * `mergeM` the beach adds nothing, except that an unnamed place takes the beach's names (it is searched under them);
 * otherwise a new candidate like a detected bay (geo object of type `bay`, origin `computed`, the point, the beach's
 * names, its parent, its tile link) with a place (`anchorage`, `candidate`, or `no_anchoring` in a restricted area
 * like `seedTile`) and a `place_candidate` review task. A rerun creates nothing: the place lies within `mergeM`.
 */
async function seedBeaches(
  db: Db,
  tileId: string,
  cfg: GazetteerConfig,
  banConfig: Parameters<typeof restrictionHits>[2],
  minShare: number,
  result: SeedResult,
): Promise<void> {
  for (const b of await beachSpotsOf(db, tileId, cfg.beachCandidates)) {
    if (b.positionTileId !== tileId) continue;
    const names = await namesOf(db, b.id);
    if (b.nearPlaceObjectId) {
      if (!b.nearPlaceNamed && (await addNames(db, b.nearPlaceObjectId, names.map((n) => ({ ...n })))) > 0) result.beaches.named++;
      continue;
    }
    const [object] = await db
      .insert(geoObjects)
      .values({ type: "bay", origin: "computed", geom: sql`${b.position}::geometry` })
      .returning({ id: geoObjects.id });
    await addNames(db, object!.id, names.map((n) => ({ ...n })));
    await assignParentOf(db, object!.id);
    const hits = await restrictionHits(db, { area: null, position: { lon: Number(b.lon), lat: Number(b.lat) } }, banConfig);
    const exclusion = exclusionFor(hits, minShare);
    const restriction = exclusion ? exclusionReason(exclusion) : null;
    const [place] = await db
      .insert(places)
      .values({
        geoObjectId: object!.id,
        kind: "anchorage",
        status: restriction ? "no_anchoring" : "candidate",
        statusReason: restriction,
        position: sql`${b.position}::geometry`,
      })
      .returning({ id: places.id });
    await db.execute(sql`
      insert into tile_geo_objects (tile_id, geo_object_id)
      select t.id, ${object!.id}::uuid from tiles t where t.id = ${tileId} and t.valid_to is null
      on conflict do nothing`);
    result.created++;
    result.beaches.created++;
    if (restriction) {
      result.noAnchoring++;
      continue;
    }
    await createReviewTask(db, {
      kind: "place_candidate",
      subjectType: "place",
      subjectId: place!.id,
      context: { geoObjectId: object!.id, kind: "anchorage", tileId, name: await displayName(db, object!.id), beachId: b.id },
    });
  }
}
