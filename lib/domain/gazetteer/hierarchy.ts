import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getConfig, type AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, type GeoObjectType } from "@/lib/db/schema";
import type { Bbox } from "@/lib/domain/tiles";
import { bufferBbox } from "./land";
import { areaTileIds, subdivisionTileIds } from "./tiles-ensure";

/** Types whose parent is the island or coast section around them, else their subdivision (Spec 03, step 6; spec 14). */
const LOCAL_TYPES: GeoObjectType[] = ["bay", "harbour", "settlement", "poi", "cape", "strait", "channel"];
const ISLANDS: GeoObjectType[] = ["island", "islet"];
/** Types that belong to a subdivision and lie in a sea (`subdivision_id`, `sea_id`). */
const PLACED_TYPES = sql`('bay', 'harbour', 'settlement', 'poi', 'cape', 'strait', 'channel', 'island', 'islet', 'archipelago', 'gulf', 'coast_section')`;

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
 * The smallest island or islet whose polygon lies within `bufferM` of the child's centroid, or coast
 * section covering it. A coast section without `config_key` (an OSM peninsula) counts only up to
 * `maxSectionKm2`: the Peloponnese or the Balkans are no useful parent; objects there fall through to the
 * subdivision rule. The bbox prefilter (`bufferM / 50 km` per degree over-covers longitude up to ~60°) keeps
 * the GiST index in play.
 */
function smallestIslandOrSection(bufferM: number, maxSectionKm2: number): SQL {
  return sql`(select p.id from geo_objects p
    where ${CANDIDATE} and (
      (p.type in ${ISLANDS} and p.geom && ST_Expand(c.centroid, ${bufferM / 50_000})
        and ST_DWithin(p.geom::geography, c.centroid::geography, ${bufferM}))
      or (p.type = 'coast_section' and ST_Covers(p.geom, c.centroid)
        and (p.config_key is not null or ST_Area(p.geom::geography) <= ${maxSectionKm2 * 1e6}))
    )
    order by ST_Area(p.geom::geography), p.id limit 1)`;
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

/** The valid `country` object of the child's `tags.country`. */
const COUNTRY_OBJECT = sql`(select p.id from geo_objects p
  where p.type = 'country' and p.valid_to is null and p.merged_into_id is null and p.tags->>'country' = c.tags->>'country'
  order by p.id limit 1)`;

/** First-level `admin_region`s of the configured countries (`firstLevel` is a number), by country and level. */
function firstLevelUnits(): SQL {
  const pairs = Object.entries(getConfig().subdivisions.countries).flatMap(([iso, c]) =>
    typeof c.firstLevel === "number" ? [sql`(${iso}, ${c.firstLevel})`] : [],
  );
  if (pairs.length === 0) return sql`false`;
  return sql`(c.tags->>'country', c.admin_level) in (${sql.join(pairs, sql`, `)})`;
}

/**
 * The hierarchy rule (Spec 03, step 6, over subdivisions: spec 14), in the order it is applied; each step's `parent` is
 * an expression on the child `c`:
 * 1. `area` → none (a Revier has no parents).
 * 2. `admin_region` of a split group (`config_key`) or of the first level of its country → its `country`.
 * 3. `coast_section` → the geo object of its subdivision (from `config_key`, else from `subdivision_id`).
 * 4. `archipelago`, `gulf` → the geo object of its subdivision.
 * 5. `island`, `islet` → smallest containing `archipelago`, else the geo object of its subdivision.
 * 6. bay, harbour, settlement, poi, cape, strait, channel → smallest island/islet polygon within
 *    `islandParentBufferM` or coast section containing the centroid (without `config_key` only up to
 *    `coastSectionMaxAreaKm2`); else the geo object of its subdivision.
 * The sea is no parent; `assignSeas` sets `sea_id` beside it.
 */
function parentRules(): { types: GeoObjectType[]; parent: SQL; filter?: SQL }[] {
  const { gazetteer } = getConfig();
  return [
    { types: ["area"], parent: sql`NULL::uuid` },
    { types: ["admin_region"], filter: sql`(c.config_key is not null or ${firstLevelUnits()})`, parent: COUNTRY_OBJECT },
    {
      types: ["coast_section"],
      parent: sql`coalesce(
        (select s.geo_object_id from subdivisions s where s.valid_to is null and s.key = split_part(c.config_key, '/', 1)),
        ${SUBDIVISION_OBJECT})`,
    },
    { types: ["archipelago", "gulf"], parent: SUBDIVISION_OBJECT },
    { types: ISLANDS, parent: sql`coalesce(${smallestCovering(["archipelago"])}, ${SUBDIVISION_OBJECT})` },
    {
      types: LOCAL_TYPES,
      parent: sql`coalesce(${smallestIslandOrSection(gazetteer.islandParentBufferM, gazetteer.coastSectionMaxAreaKm2)}, ${SUBDIVISION_OBJECT})`,
    },
  ];
}

/** Radius around a centroid within which a subdivision's land counts for the assignment. */
const SUBDIVISION_RADIUS_M = 30_000;

/**
 * Sets `geo_objects.subdivision_id` of the valid objects `c` that pass `filter` to the subdivision whose land
 * (`land_geom`) is nearest to the centroid, within `SUBDIVISION_RADIUS_M` (bbox prefilter, then distance; ties by
 * key); null when no land is that near. Only changed rows are written.
 */
async function setSubdivisions(db: Db, filter: SQL): Promise<number> {
  const res = await db.execute(sql`
    with target as (
      select c.id, (
        select s.id from subdivisions s
        where s.valid_to is null and s.land_geom is not null
          and s.land_geom && ST_Expand(c.centroid, ${SUBDIVISION_RADIUS_M / 50_000})
          and ST_DWithin(s.land_geom::geography, c.centroid::geography, ${SUBDIVISION_RADIUS_M})
        order by ST_Distance(s.land_geom::geography, c.centroid::geography), s.key limit 1) as subdivision_id
      from geo_objects c
      where c.valid_to is null and c.merged_into_id is null and c.type in ${PLACED_TYPES} and ${filter}
    )
    update geo_objects o set subdivision_id = t.subdivision_id, updated_at = now()
    from target t
    where o.id = t.id and o.subdivision_id is distinct from t.subdivision_id`);
  return res.rowCount ?? 0;
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
 * Rewrites `tile_geo_objects` for `tileIds`: every valid, unmerged object whose geometry intersects the tile box.
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
    where t.id in ${tileIds} and t.valid_to is null and o.valid_to is null and o.merged_into_id is null`);
  return { links: res.rowCount ?? 0 };
}

/** `assignTiles` for the run scope of a subdivision (`subdivisionTileIds`). */
export async function assignSubdivisionTiles(db: Db, subdivisionId: string): Promise<{ links: number }> {
  return assignTiles(db, await subdivisionTileIds(db, subdivisionId));
}

// TODO(plan 14a task 7): remove with the area run path
/** `assignTiles` for an area given as configuration. */
export async function assignAreaTiles(db: Db, area: AreaConfig): Promise<{ links: number }> {
  return assignTiles(db, areaTileIds(area));
}
