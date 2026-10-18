import { sql, type SQL } from "drizzle-orm";
import { areaByKey, getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { GeoObjectType } from "@/lib/db/schema";
import type { Bbox } from "@/lib/domain/tiles";
import { areaBbox } from "./areas";
import { bufferBbox } from "./land";
import { areaTileIds } from "./tiles-ensure";

/** Types whose parent is the island, coast section, area or sea around them (Spec 03, step 6). */
const LOCAL_TYPES: GeoObjectType[] = ["bay", "harbour", "settlement", "poi", "cape", "strait", "channel"];
const SEAS: GeoObjectType[] = ["sea", "gulf"];
const ISLANDS: GeoObjectType[] = ["island", "islet"];

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
 * area/sea rule. The bbox prefilter (`bufferM / 50 km` per degree over-covers longitude up to ~60°) keeps
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

/** Sets `parent_id = <parent>` for the valid objects of `types` whose centroid lies in `box`; only changed rows. */
async function setParents(db: Db, types: GeoObjectType[], box: SQL, parent: SQL): Promise<number> {
  const res = await db.execute(sql`
    with target as (
      select c.id, ${parent} as parent_id
      from geo_objects c
      where c.valid_to is null and c.merged_into_id is null and c.type in ${types} and c.centroid && ${box}
    )
    update geo_objects o set parent_id = t.parent_id, updated_at = now()
    from target t
    where o.id = t.id and o.parent_id is distinct from t.parent_id`);
  return res.rowCount ?? 0;
}

/**
 * Sets the parent of every valid object whose centroid lies in the area box plus `bboxBufferKm`, in this
 * order (Spec 03, step 6):
 * 1. `area` → smallest `sea`/`gulf` polygon containing its centroid, else none.
 * 2. `coast_section` → its area (from `config_key`).
 * 3. `archipelago`, `gulf` → smallest containing `area` (an area whose parent is this gulf is skipped, so
 *    a gulf and an area never become each other's parent).
 * 4. `island`, `islet` → smallest containing `archipelago`, else smallest `area`.
 * 5. bay, harbour, settlement, poi, cape, strait, channel → smallest island/islet polygon within
 *    `islandParentBufferM` or coast section containing the centroid (without `config_key` only up to
 *    `coastSectionMaxAreaKm2`); else smallest `area`; else smallest `sea`/`gulf`.
 * Only changed `parent_id`s are written (the history trigger records each). Returns the number of updates.
 */
export async function assignParents(db: Db, areaKey: string): Promise<{ updated: number }> {
  const { gazetteer } = getConfig();
  const box = envelope(bufferBbox(areaBbox(areaByKey(areaKey)), gazetteer.bboxBufferKm));
  const area = smallestCovering(["area"]);
  let updated = 0;
  updated += await setParents(db, ["area"], box, smallestCovering(SEAS));
  updated += await setParents(
    db,
    ["coast_section"],
    box,
    sql`(select p.id from geo_objects p
      where p.valid_to is null and p.merged_into_id is null and p.type = 'area' and p.config_key = split_part(c.config_key, '/', 1)
      order by p.id limit 1)`,
  );
  updated += await setParents(
    db,
    ["archipelago", "gulf"],
    box,
    smallestCovering(["area"], sql`and p.parent_id is distinct from c.id`),
  );
  updated += await setParents(db, ISLANDS, box, sql`coalesce(${smallestCovering(["archipelago"])}, ${area})`);
  updated += await setParents(
    db,
    LOCAL_TYPES,
    box,
    sql`coalesce(${smallestIslandOrSection(gazetteer.islandParentBufferM, gazetteer.coastSectionMaxAreaKm2)}, ${area}, ${smallestCovering(SEAS)})`,
  );
  return { updated };
}

/**
 * Rewrites `tile_geo_objects` for the existing tiles of the area: every valid, unmerged object whose
 * geometry intersects the tile box. Returns the number of links written. A tile shared with another area
 * is rebuilt completely, including objects that only that other area imported: the links depend on the
 * geometries alone, so the result is the same whichever area's run writes it.
 */
export async function assignTiles(db: Db, areaKey: string): Promise<{ links: number }> {
  const tileIds = areaTileIds(areaByKey(areaKey));
  await db.execute(sql`delete from tile_geo_objects where tile_id in ${tileIds}`);
  const res = await db.execute(sql`
    insert into tile_geo_objects (tile_id, geo_object_id)
    select t.id, o.id
    from tiles t
    join geo_objects o on o.geom && t.bbox and ST_Intersects(t.bbox, o.geom)
    where t.id in ${tileIds} and t.valid_to is null and o.valid_to is null and o.merged_into_id is null`);
  return { links: res.rowCount ?? 0 };
}
