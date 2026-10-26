import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, type GeoObjectType } from "@/lib/db/schema";
import type { Bbox } from "@/lib/domain/tiles";
import { bufferBbox } from "./land";
import { subdivisionTileIds } from "./tiles-ensure";

/** Types whose parent is the island or coast section around them, else their subdivision (Spec 03, step 6; spec 14). */
const LOCAL_TYPES: GeoObjectType[] = ["bay", "harbour", "settlement", "poi", "cape", "strait", "channel"];
const ISLANDS: GeoObjectType[] = ["island", "islet"];
/** Local types that take the nearest island within `islandParentNearestM` when none is within the buffer (B10). */
const NEAREST_ISLAND_TYPES: GeoObjectType[] = ["bay", "cape"];
/** Types that belong to a subdivision and lie in a sea (`subdivision_id`, `sea_id`). */
const PLACED_TYPES: GeoObjectType[] = [...LOCAL_TYPES, ...ISLANDS, "archipelago", "gulf", "coast_section"];
/** Large water bodies whose centroid may lie far offshore: they take the nearest land without the radius limit. */
const FAR_TYPES: GeoObjectType[] = ["gulf", "archipelago", "strait", "channel"];
/** Vertices per piece of a subdivision's land, and how many pieces nearest by plain distance get the exact one. */
const LAND_PART_VERTICES = 128;
const NEAREST_LAND_PARTS = 10;
/** Polygons of these types are no tile content: a mention reaches their tiles through the hierarchy and the sea. */
const UNTILED_TYPES: GeoObjectType[] = ["country", "admin_region", "sea"];

function envelope([west, south, east, north]: Bbox): SQL {
  return sql`ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)`;
}

/** Valid, unmerged polygon `p` other than the child `c`. */
const CANDIDATE = sql`p.valid_to is null and p.merged_into_id is null and p.id <> c.id and ST_Dimension(p.geom) = 2`;

/** The smallest (by geodesic area) candidate `p` of the types whose polygon covers the child's centroid. */
function smallestCovering(types: GeoObjectType[], extra: SQL = sql``): SQL {
  return sql`(select p.id from geo_objects p
    where ${CANDIDATE} and p.type in ${types} and ST_Covers(p.geom, c.centroid) ${extra}
    order by ST_Area(p.geom::geography), p.id limit 1)`;
}

/**
 * The smallest island or islet whose polygon lies within `bufferM` of the child's centroid, or configured coast
 * section (`config_key`) covering it. A coast section without `config_key` is no parent (N7 4.3, B6): OSM
 * peninsulas are no longer imported, and an older one such as the Peloponnese is no useful parent. The bbox prefilter
 * (`bufferM / 50 km` per degree over-covers longitude up to ~60°) keeps the GiST index in play.
 */
function smallestIslandOrSection(bufferM: number): SQL {
  return sql`(select p.id from geo_objects p
    where ${CANDIDATE} and (
      (p.type in ${ISLANDS} and p.geom && ST_Expand(c.centroid, ${bufferM / 50_000})
        and ST_DWithin(p.geom::geography, c.centroid::geography, ${bufferM}))
      or (p.type = 'coast_section' and p.config_key is not null and ST_Covers(p.geom, c.centroid))
    )
    order by ST_Area(p.geom::geography), p.id limit 1)`;
}

/**
 * The nearest polygon `p` of `islandTypes` within `maxM` of the child's centroid (B10), an `island` before any
 * `islet` (a rock between a bay and its island is no parent), unless mainland lies as near as that polygon or
 * nearer: a land polygon whose point on surface no island or islet polygon covers (an island's own land is covered
 * by its polygon; the land under a point islet, its rock without polygon, is its own and no mainland either). An
 * object between an island and the nearer mainland stays with the mainland; without land polygons nothing is
 * mainland. With `mainlandCheck` false the nearest island alone. Bbox prefilters (`maxM / 50 km` per degree, as
 * above) keep the GiST indexes in play; the point on surface is computed once per land polygon and looked up in the
 * islands' index.
 */
function nearestIsland(islandTypes: GeoObjectType[], maxM: number, mainlandCheck = true): SQL {
  const near = (g: SQL) => sql`${g} && ST_Expand(c.centroid, ${maxM / 50_000})`;
  const noMainlandNearer = sql`not exists (
    select 1 from land_polygons l cross join lateral (select ST_PointOnSurface(l.geom) as pt) s
    where ${near(sql`l.geom`)} and ST_DWithin(l.geom::geography, c.centroid::geography, i.distance_m)
      and not (c.type in ${ISLANDS} and ST_Covers(l.geom, c.centroid))
      and not exists (
        select 1 from geo_objects q
        where q.type in ${ISLANDS} and q.valid_to is null and q.merged_into_id is null and ST_Dimension(q.geom) = 2
          and q.geom && s.pt and ST_Covers(q.geom, s.pt)))`;
  return sql`(select i.id from (
      select p.id, ST_Distance(p.geom::geography, c.centroid::geography) as distance_m from geo_objects p
      where ${CANDIDATE} and p.type in ${islandTypes} and ${near(sql`p.geom`)}
        and ST_DWithin(p.geom::geography, c.centroid::geography, ${maxM})
      order by p.type = 'islet', distance_m, p.id limit 1) i
    ${mainlandCheck ? sql`where ${noMainlandNearer}` : sql``})`;
}

/** Sets `parent_id = <parent>` for the valid objects `c` of `types` that pass `filter`; only changed rows. */
async function setParents(db: Db, types: GeoObjectType[], filter: SQL, parent: SQL): Promise<number> {
  const res = await db.execute(sql`
    with target as (
      select c.id, ${parent} as parent_id
      from geo_objects c
      where c.valid_to is null and c.merged_into_id is null and c.type in ${types} and ${filter}
    )
    update geo_objects o set parent_id = t.parent_id, updated_at = now()
    from target t
    where o.id = t.id and o.parent_id is distinct from t.parent_id`);
  return res.rowCount ?? 0;
}

/** The geo object (`country` / `admin_region`) of the subdivision the child `c` belongs to; null without subdivision. */
const SUBDIVISION_OBJECT = sql`(select s.geo_object_id from subdivisions s where s.id = c.subdivision_id)`;

/**
 * The valid `country` object of the child's `tags.country`: the country's own relation (`ISO3166-1` = the code) first,
 * so that another level-2 row stored under the country (an `extra` relation) never wins by id.
 */
const COUNTRY_OBJECT = sql`(select p.id from geo_objects p
  where p.type = 'country' and p.valid_to is null and p.merged_into_id is null and p.tags->>'country' = c.tags->>'country'
  order by (p.tags->>'ISO3166-1' is not distinct from c.tags->>'country') desc, p.id limit 1)`;

/** The `admin_region` `a` is a first-level unit of its country (`firstLevel` is a number), by country and level. */
function firstLevelUnits(a: string): SQL {
  const pairs = Object.entries(getConfig().subdivisions.countries).flatMap(([iso, c]) =>
    typeof c.firstLevel === "number" ? [sql`(${iso}, ${c.firstLevel})`] : [],
  );
  if (pairs.length === 0) return sql`false`;
  return sql`(${sql.raw(a)}.tags->>'country', ${sql.raw(a)}.admin_level) in (${sql.join(pairs, sql`, `)})`;
}

/** The `admin_region` `a` is a unit above the second level: split group (`config_key`), subdivision object or first level. */
function isUnitRegion(a: string): SQL {
  return sql`(${sql.raw(a)}.config_key is not null
    or exists (select 1 from subdivisions u where u.valid_to is null and u.geo_object_id = ${sql.raw(a)}.id)
    or ${firstLevelUnits(a)})`;
}

/**
 * The hierarchy rule (Spec 03, step 6, over subdivisions: spec 14), in the order it is applied; each step's `parent` is
 * an expression on the child `c`:
 * 1. `area` → none (a Revier has no parents).
 * 2. `admin_region` that is a split group (`config_key`), a subdivision's geo object (also an `extra` unit) or of the
 *    first level of its country → its `country` (the country's own `ISO3166-1` relation).
 *    Any other (second-level) `admin_region` → the smallest such unit of its country covering its point on surface,
 *    else the country.
 * 3. `coast_section` → the geo object of its subdivision (from `config_key`, else from `subdivision_id`).
 * 4. `archipelago`, `gulf` → the geo object of its subdivision.
 * 5. `island` → smallest containing `archipelago`, else the geo object of its subdivision. `islet` → the nearest
 *    island polygon within `islandParentBufferM`, else the nearest within `islandParentNearestM` with no nearer
 *    mainland (`nearestIsland`, B10), else as an island.
 * 6. bay, harbour, settlement, poi, cape, strait, channel → smallest island/islet polygon within
 *    `islandParentBufferM` or configured coast section (`config_key`) containing the centroid; a bay or cape else
 *    the nearest island polygon, else islet polygon, within `islandParentNearestM` with no nearer mainland (B10);
 *    else the geo object of its subdivision.
 * The sea is no parent; `assignSeas` sets `sea_id` beside it.
 */
function parentRules(): { types: GeoObjectType[]; parent: SQL; filter?: SQL }[] {
  const { gazetteer } = getConfig();
  return [
    { types: ["area"], parent: sql`NULL::uuid` },
    { types: ["admin_region"], filter: isUnitRegion("c"), parent: COUNTRY_OBJECT },
    {
      types: ["admin_region"],
      filter: sql`not ${isUnitRegion("c")}`,
      parent: sql`coalesce(
        (select p.id from geo_objects p
          where ${CANDIDATE} and p.type = 'admin_region' and p.tags->>'country' = c.tags->>'country' and ${isUnitRegion("p")}
            and ST_Covers(p.geom, ST_PointOnSurface(c.geom))
          order by ST_Area(p.geom::geography), p.id limit 1),
        ${COUNTRY_OBJECT})`,
    },
    {
      types: ["coast_section"],
      parent: sql`coalesce(
        (select s.geo_object_id from subdivisions s where s.valid_to is null and s.key = split_part(c.config_key, '/', 1)),
        ${SUBDIVISION_OBJECT})`,
    },
    { types: ["archipelago", "gulf"], parent: SUBDIVISION_OBJECT },
    { types: ["island"], parent: sql`coalesce(${smallestCovering(["archipelago"])}, ${SUBDIVISION_OBJECT})` },
    {
      types: ["islet"],
      parent: sql`coalesce(
        ${nearestIsland(["island"], gazetteer.islandParentBufferM, false)},
        ${nearestIsland(["island"], gazetteer.islandParentNearestM)},
        ${smallestCovering(["archipelago"])},
        ${SUBDIVISION_OBJECT})`,
    },
    {
      types: NEAREST_ISLAND_TYPES,
      parent: sql`coalesce(
        ${smallestIslandOrSection(gazetteer.islandParentBufferM)},
        ${nearestIsland(ISLANDS, gazetteer.islandParentNearestM)},
        ${SUBDIVISION_OBJECT})`,
    },
    {
      types: LOCAL_TYPES.filter((t) => !NEAREST_ISLAND_TYPES.includes(t)),
      parent: sql`coalesce(${smallestIslandOrSection(gazetteer.islandParentBufferM)}, ${SUBDIVISION_OBJECT})`,
    },
  ];
}

/**
 * Sets `geo_objects.subdivision_id` of the valid objects `c` that pass `filter` to the subdivision whose land
 * (`land_geom`) is nearest to the centroid, within `gazetteer.subdivisionRadiusM` (ties by key; gulfs, archipelagos,
 * straits and channels take the nearest land at any distance); null when no land is that near. Only changed rows are
 * written. The land is cut into small indexed pieces first: a geography distance to whole coastlines (85,000 points
 * for Attica) took over an hour for one subdivision; the exact distance is computed for the nearest pieces only.
 */
async function setSubdivisions(db: Db, filter: SQL): Promise<number> {
  const radiusM = getConfig().gazetteer.subdivisionRadiusM;
  return db.transaction(async (tx) => {
    await tx.execute(sql`drop table if exists pg_temp.subdivision_land_parts`);
    await tx.execute(sql`
      create temp table subdivision_land_parts on commit drop as
      select s.id, s.key, ST_Subdivide(s.land_geom, ${LAND_PART_VERTICES}) as geom
      from subdivisions s where s.valid_to is null and s.land_geom is not null`);
    await tx.execute(sql`create index on subdivision_land_parts using gist (geom)`);
    await tx.execute(sql`analyze subdivision_land_parts`);
    const res = await tx.execute(sql`
      with target as (
        select c.id, (
          select q.id from (
            select p.id, p.key, p.geom from subdivision_land_parts p
            order by p.geom <-> c.centroid limit ${NEAREST_LAND_PARTS}) q
          where c.type in ${FAR_TYPES} or ST_DWithin(q.geom::geography, c.centroid::geography, ${radiusM})
          order by ST_Distance(q.geom::geography, c.centroid::geography), q.key limit 1) as subdivision_id
        from geo_objects c
        where c.valid_to is null and c.merged_into_id is null and c.type in ${PLACED_TYPES} and ${filter}
      )
      update geo_objects o set subdivision_id = t.subdivision_id, updated_at = now()
      from target t
      where o.id = t.id and o.subdivision_id is distinct from t.subdivision_id`);
    return res.rowCount ?? 0;
  });
}

/** Sets `sea_id` of the valid objects `c` that pass `filter`: the smallest sea polygon covering the centroid, else the nearest. */
async function setSeas(db: Db, filter: SQL): Promise<number> {
  const sea = sql`p.type = 'sea' and p.valid_to is null and p.merged_into_id is null and ST_Dimension(p.geom) = 2`;
  const res = await db.execute(sql`
    with target as (
      select c.id, coalesce(
        (select p.id from geo_objects p where ${sea} and ST_Covers(p.geom, c.centroid) order by ST_Area(p.geom), p.id limit 1),
        (select p.id from geo_objects p where ${sea} order by ST_Distance(p.geom, c.centroid), p.id limit 1)) as sea_id
      from geo_objects c
      where c.valid_to is null and c.merged_into_id is null and c.type in ${PLACED_TYPES} and ${filter}
    )
    update geo_objects o set sea_id = t.sea_id, updated_at = now()
    from target t
    where o.id = t.id and o.sea_id is distinct from t.sea_id`);
  return res.rowCount ?? 0;
}

/**
 * Assigns the valid objects whose centroid lies in `bbox` to the subdivision of the nearest land (spec 14, "Zuordnung").
 * Sea borders play no role: an island off a foreign coast belongs to the subdivision of its own land. Only changed
 * rows are written. Returns the number of updates.
 */
export async function assignSubdivisions(db: Db, bbox: Bbox): Promise<number> {
  return setSubdivisions(db, sql`c.centroid && ${envelope(bbox)}`);
}

/** Sets `sea_id` of the valid objects whose centroid lies in `bbox`: the sea covering it, else the nearest. Returns the updates. */
export async function assignSeas(db: Db, bbox: Bbox): Promise<number> {
  return setSeas(db, sql`c.centroid && ${envelope(bbox)}`);
}

/**
 * Sets the parent of every valid object whose centroid lies in `bbox` plus `bboxBufferKm` by the hierarchy rule
 * (`parentRules`). Only changed `parent_id`s are written (the history trigger records each). Returns the number of
 * updates. Run `assignSubdivisions` first: the rules read `subdivision_id`.
 */
export async function assignParents(db: Db, bbox: Bbox): Promise<{ updated: number }> {
  const { gazetteer } = getConfig();
  const box = envelope(bufferBbox(bbox, gazetteer.bboxBufferKm));
  let updated = 0;
  for (const rule of parentRules()) {
    updated += await setParents(db, rule.types, sql`c.centroid && ${box} and ${rule.filter ?? sql`true`}`, rule.parent);
  }
  return { updated };
}

/**
 * The hierarchy for exactly the objects `ids` (the stage `gazetteer.land`, N7 4.4): subdivision, sea and parent of each
 * by the same rules as `assignSubdivisions`, `assignSeas` and `assignParents`, then tile links into every valid tile
 * the object intersects (added, never removed: other tiles' links stay as they are). No other object is touched.
 * Returns the updates of each step and the new links.
 */
export async function assignObjects(
  db: Db,
  ids: string[],
): Promise<{ subdivisions: number; seas: number; updated: number; links: number }> {
  if (ids.length === 0) return { subdivisions: 0, seas: 0, updated: 0, links: 0 };
  // one array parameter: a list of ids would bind one parameter each (Postgres allows 65,535 per statement)
  const idArray = sql`${sql.param(ids)}::uuid[]`;
  const only = sql`c.id = any(${idArray})`;
  const subdivisions = await setSubdivisions(db, only);
  const seas = await setSeas(db, only);
  let updated = 0;
  for (const rule of parentRules()) {
    updated += await setParents(db, rule.types, sql`${only} and ${rule.filter ?? sql`true`}`, rule.parent);
  }
  const res = await db.execute(sql`
    insert into tile_geo_objects (tile_id, geo_object_id)
    select t.id, o.id
    from geo_objects o
    join tiles t on t.bbox && o.geom and ST_Intersects(t.bbox, o.geom)
    where o.id = any(${idArray}) and t.valid_to is null and o.valid_to is null and o.merged_into_id is null
      and o.type not in ${UNTILED_TYPES}
    on conflict do nothing`);
  return { subdivisions, seas, updated, links: res.rowCount ?? 0 };
}

/**
 * Sets the parent of the one valid object `objectId` by the same hierarchy rule as `assignParents`, after its
 * subdivision and sea (for an object created outside a gazetteer run, such as a new name from texts). Returns its
 * parent id (null for none, or when the object is not valid).
 */
export async function assignParentOf(db: Db, objectId: string): Promise<string | null> {
  const [object] = await db
    .select({ type: geoObjects.type })
    .from(geoObjects)
    .where(and(eq(geoObjects.id, objectId), isNull(geoObjects.validTo), isNull(geoObjects.mergedIntoId)));
  if (!object) return null;
  const only = sql`c.id = ${objectId}`;
  await setSubdivisions(db, only);
  await setSeas(db, only);
  const rule = parentRules().find((r) => r.types.includes(object.type));
  if (rule) await setParents(db, rule.types, sql`${only} and ${rule.filter ?? sql`true`}`, rule.parent);
  const [row] = await db.select({ parentId: geoObjects.parentId }).from(geoObjects).where(eq(geoObjects.id, objectId));
  return row?.parentId ?? null;
}

/**
 * Rewrites `tile_geo_objects` for `tileIds`: every valid, unmerged object whose geometry intersects the tile box,
 * except country, admin_region and sea polygons (they would link to every tile of their extent).
 * Returns the number of links written. A tile shared by two scopes is rebuilt completely, including objects only the
 * other scope imported: the links depend on the geometries alone, so the result is the same whichever run writes it.
 */
export async function assignTiles(db: Db, tileIds: string[]): Promise<{ links: number }> {
  if (tileIds.length === 0) return { links: 0 };
  await db.execute(sql`delete from tile_geo_objects where tile_id in ${tileIds}`);
  const res = await db.execute(sql`
    insert into tile_geo_objects (tile_id, geo_object_id)
    select t.id, o.id
    from tiles t
    join geo_objects o on o.geom && t.bbox and ST_Intersects(t.bbox, o.geom)
    where t.id in ${tileIds} and t.valid_to is null and o.valid_to is null and o.merged_into_id is null
      and o.type not in ${UNTILED_TYPES}`);
  return { links: res.rowCount ?? 0 };
}

/** `assignTiles` for the run scope of a subdivision (`subdivisionTileIds`). */
export async function assignSubdivisionTiles(db: Db, subdivisionId: string): Promise<{ links: number }> {
  return assignTiles(db, await subdivisionTileIds(db, subdivisionId));
}
