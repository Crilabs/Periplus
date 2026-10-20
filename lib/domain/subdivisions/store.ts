import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geoObjects, subdivisions, type SubdivisionStatus } from "@/lib/db/schema";
import type { Bbox } from "@/lib/domain/tiles";
import { addNames } from "@/lib/domain/gazetteer/names";
import { newPublicId } from "@/lib/domain/ids";
import type { AdminUnit, PlannedSubdivision } from "./plan";

/** 12 nautical miles in metres, the water kept around a subdivision's land. */
export const TERRITORIAL_WATER_M = 22_224;

/** The coarse gazetteer's countries and admin regions as plan input; `touchesMediterranean` within 2 km of a configured sea. */
export async function loadAdminUnits(db: Db, mrgids: number[]): Promise<AdminUnit[]> {
  const { rows } = await db.execute<{
    id: string;
    country: string | null;
    admin_level: number;
    iso: string | null;
    osm_id: string | null;
    wikidata: string | null;
    touches: boolean;
  }>(sql`
    SELECT g.id, g.tags->>'country' AS country, g.admin_level, g.tags->>'ISO3166-2' AS iso, g.osm_id,
           coalesce(g.wikidata_id, g.tags->>'wikidata') AS wikidata,
           EXISTS (
             SELECT 1 FROM geo_objects s
             WHERE s.type = 'sea' AND s.origin = 'marine_regions' AND s.valid_to IS NULL
               AND s.tags->>'mrgid' IN (${sql.join(mrgids.map((m) => sql`${String(m)}`), sql`, `)})
               AND ST_DWithin(s.geom, g.geom, 0.05)
               AND ST_DWithin(s.geom::geography, g.geom::geography, 2000)
           ) AS touches
    FROM geo_objects g
    WHERE g.type IN ('country', 'admin_region') AND g.valid_to IS NULL AND g.osm_id LIKE 'relation/%'
      AND g.tags ? 'country' AND g.admin_level IS NOT NULL
    ORDER BY g.osm_id`);
  return rows.map((r) => ({
    geoObjectId: r.id,
    country: r.country!,
    adminLevel: r.admin_level,
    iso: r.iso,
    osmRelationId: Number(r.osm_id!.slice("relation/".length)),
    wikidataId: r.wikidata,
    touchesMediterranean: r.touches,
  }));
}

const ids = (list: string[]) => sql.join(list.map((id) => sql`${id}::uuid`), sql`, `);

/**
 * Keys of the planned active subdivisions whose members' polygon meets no land polygon, so they would be stored
 * without `land_geom` (the land import is missing or covers only part of the Mediterranean).
 */
export async function subdivisionsWithoutLand(db: Db, plan: PlannedSubdivision[]): Promise<string[]> {
  const missing: string[] = [];
  for (const entry of plan.filter((p) => p.status === "active")) {
    const { rows } = await db.execute<{ hit: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM land_polygons l
        WHERE l.geom && ${unionOf(entry.memberGeoObjectIds)} AND ST_Intersects(l.geom, ${unionOf(entry.memberGeoObjectIds)})
      ) AS hit`);
    if (!rows[0]!.hit) missing.push(entry.key);
  }
  return missing;
}

/** Union of the geometries of geo objects, polygons only; null when none has area. */
const unionOf = (list: string[]) =>
  sql`(SELECT ST_CollectionExtract(ST_UnaryUnion(ST_Collect(ST_MakeValid(geom) ORDER BY id)), 3) FROM geo_objects WHERE id IN (${ids(list)}))`;

type Candidate = { geom: string; landGeom: string | null };

/**
 * The stored shape of a planned subdivision: its unit polygon (union of members minus the cut units) joined with
 * `TERRITORIAL_WATER_M` around its land, so islands and coastal water lie inside even where OSM boundaries stop at the
 * coastline. `land_geom` is the unit polygon without that water, intersected with the land polygons: the land
 * of a neighbour inside the water belt never counts as this subdivision's land, so assignment by nearest land stays
 * unambiguous. Both as EWKB hex.
 */
async function candidate(db: Db, entry: PlannedSubdivision): Promise<Candidate> {
  const cut = entry.cutGeoObjectIds.length > 0 ? unionOf(entry.cutGeoObjectIds) : sql`NULL::geometry`;
  const { rows } = await db.execute<{ geom: string | null; land: string | null }>(sql`
    WITH u AS (
      SELECT CASE WHEN c.g IS NULL THEN m.g ELSE ST_CollectionExtract(ST_Difference(m.g, c.g), 3) END AS g
      FROM (SELECT ${unionOf(entry.memberGeoObjectIds)} AS g) m, (SELECT ${cut} AS g) c
    ), land AS (
      SELECT ST_CollectionExtract(ST_Intersection(u.g, ST_MakeValid(ST_UnaryUnion(ST_Collect(l.geom ORDER BY l.id)))), 3) AS g
      FROM u JOIN land_polygons l ON l.geom && u.g AND ST_Intersects(l.geom, u.g)
      GROUP BY u.g
    )
    SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(
             CASE WHEN land.g IS NULL OR ST_IsEmpty(land.g) THEN u.g
                  ELSE ST_Union(u.g, ST_Buffer(ST_SimplifyPreserveTopology(land.g, 0.0005)::geography, ${TERRITORIAL_WATER_M})::geometry) END
           ), 3))::text AS geom,
           CASE WHEN land.g IS NULL OR ST_IsEmpty(land.g) THEN NULL ELSE ST_Multi(land.g)::text END AS land
    FROM u LEFT JOIN land ON true`);
  const row = rows[0];
  if (!row?.geom) throw new Error(`subdivision ${entry.key}: members have no area`);
  return { geom: row.geom, landGeom: row.land };
}

/**
 * The geo object of a split group or merge: valid `admin_region` with `config_key = key` and the union of its members as
 * geometry; created or updated when members or geometry changed. Returns its id. With `readOnly` (the subdivision is
 * built) nothing is written; `drifted` tells that the members' union no longer equals the geo object's geometry.
 */
async function ensureMadeGeoObject(
  db: Db,
  entry: PlannedSubdivision,
  readOnly = false,
): Promise<{ id: string; drifted: boolean }> {
  const union = sql`ST_Multi(ST_CollectionExtract(ST_UnaryUnion(ST_Collect(ST_MakeValid(geom) ORDER BY id)), 3))`;
  const [existing] = await db
    .select({ id: geoObjects.id, same: sql<boolean>`ST_OrderingEquals(${geoObjects.geom}, (SELECT ${union} FROM geo_objects WHERE id IN (${ids(entry.memberGeoObjectIds)})))` })
    .from(geoObjects)
    .where(and(eq(geoObjects.configKey, entry.key), isNull(geoObjects.validTo)))
    .for("update");
  let id: string;
  if (readOnly && existing) return { id: existing.id, drifted: !existing.same };
  if (!existing) {
    const [row] = await db
      .insert(geoObjects)
      .values({
        type: "admin_region",
        origin: "manual",
        configKey: entry.key,
        adminLevel: entry.adminLevel,
        tags: { country: entry.country },
        geom: sql`(SELECT ${union} FROM geo_objects WHERE id IN (${ids(entry.memberGeoObjectIds)}))`,
      })
      .returning({ id: geoObjects.id });
    id = row!.id;
  } else {
    id = existing.id;
    if (!existing.same) {
      await db
        .update(geoObjects)
        .set({ geom: sql`(SELECT ${union} FROM geo_objects WHERE id IN (${ids(entry.memberGeoObjectIds)}))` })
        .where(eq(geoObjects.id, id));
    }
  }
  await addNames(
    db,
    id,
    Object.entries(entry.names).map(([language, name]) => ({ name, language, origin: "manual" as const, isPreferred: true })),
  );
  return { id, drifted: false };
}

export type SubdivisionApplyResult = {
  inserted: number;
  replaced: number;
  unchanged: number;
  /** Valid unbuilt rows whose key left the plan; they end without a successor. */
  ended: number;
  /** Differences that touch a built subdivision (`built_at` set): reported, never applied. */
  deviations: Array<{ key: string; reason: string }>;
};

/**
 * Brings the valid `subdivisions` rows in line with `plan` (spec 14). A key without row is inserted (`sd_` id); a row
 * with the same geo object, country, status, geometry and land equals the plan and stays. Otherwise an unbuilt row
 * ends (`valid_to` = `today`) and a new row replaces it; a built row (`built_at`) is never touched, the difference is
 * a deviation. Unbuilt rows whose key left the plan end, built ones are reported. Geo objects of split groups and
 * merges are made here (`ensureMadeGeoObject`). Run it in one transaction.
 */
export async function applySubdivisionPlan(db: Db, plan: PlannedSubdivision[], today: string): Promise<SubdivisionApplyResult> {
  const result: SubdivisionApplyResult = { inserted: 0, replaced: 0, unchanged: 0, ended: 0, deviations: [] };
  const valid = await db.select().from(subdivisions).where(isNull(subdivisions.validTo)).for("update");
  const byKey = new Map(valid.map((r) => [r.key, r]));

  for (const entry of plan) {
    const existing = byKey.get(entry.key);
    // A built subdivision keeps its geo object as it is; a change of its members is a deviation.
    const made = entry.geoObjectId ? null : await ensureMadeGeoObject(db, entry, !!existing?.builtAt);
    const geoObjectId = entry.geoObjectId ?? made!.id;
    const cand = await candidate(db, entry);
    const insert = () =>
      db.insert(subdivisions).values({
        publicId: newPublicId("sd"),
        key: entry.key,
        country: entry.country,
        geoObjectId,
        geom: sql`${cand.geom}::geometry`,
        landGeom: cand.landGeom ? sql`${cand.landGeom}::geometry` : null,
        status: entry.status,
        statusReason: entry.statusReason,
        validFrom: today,
      });
    if (!existing) {
      await insert();
      result.inserted++;
      continue;
    }
    const [cmp] = (
      await db.execute<{ geom: boolean; land: boolean }>(sql`
        SELECT ST_OrderingEquals(geom, ${cand.geom}::geometry) AS geom,
               CASE WHEN land_geom IS NULL OR ${cand.landGeom}::geometry IS NULL THEN land_geom IS NULL AND ${cand.landGeom}::geometry IS NULL
                    ELSE ST_OrderingEquals(land_geom, ${cand.landGeom}::geometry) END AS land
        FROM subdivisions WHERE id = ${existing.id}`)
    ).rows;
    const differences = [
      existing.geoObjectId !== geoObjectId && "geo object",
      made?.drifted && "geo object geometry",
      existing.country !== entry.country && "country",
      existing.status !== entry.status && `status ${existing.status} -> ${entry.status}`,
      (existing.statusReason ?? null) !== entry.statusReason && "status reason",
      !cmp!.geom && "geometry",
      !cmp!.land && "land geometry",
    ].filter((d): d is string => !!d);
    if (differences.length === 0) {
      result.unchanged++;
    } else if (existing.builtAt) {
      result.deviations.push({ key: entry.key, reason: `built subdivision differs from the plan: ${differences.join(", ")}` });
    } else {
      await db.update(subdivisions).set({ validTo: today }).where(eq(subdivisions.id, existing.id));
      await insert();
      result.replaced++;
    }
  }

  const planned = new Set(plan.map((p) => p.key));
  const gone = valid.filter((r) => !planned.has(r.key));
  for (const r of gone.filter((x) => x.builtAt)) {
    result.deviations.push({ key: r.key, reason: "built subdivision is no longer in the plan" });
  }
  const endable = gone.filter((x) => !x.builtAt).map((x) => x.id);
  if (endable.length > 0) {
    await db.update(subdivisions).set({ validTo: today }).where(inArray(subdivisions.id, endable));
    result.ended = endable.length;
  }
  return result;
}

export type SubdivisionRef = {
  id: string;
  publicId: string;
  key: string;
  country: string;
  status: SubdivisionStatus;
  bbox: Bbox;
};

/** The valid subdivision with this key and the bounding box of its polygon; null when there is none. */
export async function subdivisionByKey(db: Db, key: string): Promise<SubdivisionRef | null> {
  const { rows } = await db.execute<{
    id: string;
    publicId: string;
    key: string;
    country: string;
    status: SubdivisionStatus;
    w: number;
    s: number;
    e: number;
    n: number;
  }>(sql`
    SELECT id, public_id AS "publicId", key, country, status,
           ST_XMin(geom) AS w, ST_YMin(geom) AS s, ST_XMax(geom) AS e, ST_YMax(geom) AS n
    FROM subdivisions WHERE key = ${key} AND valid_to IS NULL`);
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, publicId: r.publicId, key: r.key, country: r.country, status: r.status, bbox: [r.w, r.s, r.e, r.n] };
}
