import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, type GeoObjectType, type GeoOrigin, type PoiCategory } from "@/lib/db/schema";
import { newPublicId, type PublicIdPrefix } from "@/lib/domain/ids";
import { addNames, type NameDraft } from "./names";

export type GeoObjectDraft = {
  type: GeoObjectType;
  category?: PoiCategory;
  origin: GeoOrigin;
  osmId?: string;
  wikidataId?: string;
  geonamesId?: string;
  tags?: Record<string, string>;
  /** OSM admin_level, only for `admin_region` and `country`. */
  adminLevel?: number;
  /** `{ lines }`: outer rings as lines (OSM relation members), assembled into an area. */
  geometry: GeoJSON.Geometry | { lines: GeoJSON.LineString[] };
  names: NameDraft[];
};

/** Public ID prefix of the delivered types (Spec 02); other types get none. */
const PUBLIC_ID_PREFIX: Partial<Record<GeoObjectType, PublicIdPrefix>> = {
  area: "ar",
  island: "rg",
  archipelago: "rg",
  coast_section: "rg",
  gulf: "rg",
  channel: "rg",
  poi: "hl",
};

/** A new public id of the type's family (`ar_` for an area), null for a type without one. */
export function publicIdFor(type: GeoObjectType): string | null {
  const prefix = PUBLIC_ID_PREFIX[type];
  return prefix ? newPublicId(prefix) : null;
}

/**
 * The public id an existing object keeps after a type change: its own while the new type is of the same id family,
 * a new one of the new family otherwise, none for a type without public id. The old id then leaves the next package as
 * `removed` (a highlight that became an island is no longer that highlight; gesamt-review DAT-3, checked by
 * `geo_objects_public_id_prefix_check`).
 */
function publicIdAfter(type: GeoObjectType, current: string | null): string | null {
  const prefix = PUBLIC_ID_PREFIX[type];
  if (!prefix) return null;
  return current?.startsWith(`${prefix}_`) ? current : newPublicId(prefix);
}

/**
 * The CTE chain `built(g)` that assembles a draft geometry once: lines become `ST_BuildArea(ST_Collect(…))`, lines
 * that enclose no area the centroid of the lines; a GeoJSON geometry is taken as it is. Every step is a MATERIALIZED
 * CTE, so the planner never pulls the expression up and constant-folds a copy per reference: as nested sub-selects,
 * Postgres evaluated ST_BuildArea of a 225,000-point relation 18 times during planning (1.1 GB and 14 s for one
 * upsert) and the 2 GB database was killed storing the Bay of Biscay (N7 check). Used as `WITH ${builtGeometry(g)} …
 * FROM built`.
 */
export function builtGeometry(geometry: GeoObjectDraft["geometry"]): SQL {
  if (!("lines" in geometry)) return sql`built AS MATERIALIZED (SELECT ${geomFromGeoJson(geometry)} AS g)`;
  const lines = sql.join(geometry.lines.map((l) => geomFromGeoJson(l)), sql`, `);
  return sql`lines AS MATERIALIZED (SELECT ST_Collect(ARRAY[${lines}]) AS c),
    area AS MATERIALIZED (SELECT c, ST_BuildArea(c) AS a FROM lines),
    built AS MATERIALIZED (SELECT CASE WHEN a IS NULL OR ST_IsEmpty(a) THEN ST_Centroid(c) ELSE a END AS g FROM area)`;
}

/**
 * The statement behind `resolveGeometry`: the built geometry as EWKB hex (`g`) and, when it is unusable, why
 * (`reason`). An invalid geometry is repaired with `ST_MakeValid`, keeping only parts of its own dimension (an area
 * stays an area, a line a line); when nothing valid remains, `g` is null. Each heavy function runs once (`builtGeometry`).
 */
export function resolveGeometrySql(geometry: GeoObjectDraft["geometry"]): SQL {
  return sql`
    WITH ${builtGeometry(geometry)},
    checked AS MATERIALIZED (SELECT g, ST_IsValid(g) AS valid FROM built),
    repaired AS MATERIALIZED (
      SELECT CASE WHEN valid THEN g ELSE ST_CollectionExtract(ST_MakeValid(g), ST_Dimension(g) + 1) END AS r,
             CASE WHEN valid THEN 'empty geometry' ELSE ST_IsValidReason(g) END AS reason
      FROM checked)
    SELECT CASE WHEN r IS NOT NULL AND NOT ST_IsEmpty(r) AND ST_IsValid(r) THEN r END AS g, reason FROM repaired`;
}

/** The draft geometry as EWKB hex, or why it is unusable (`resolveGeometrySql`). */
async function resolveGeometry(db: Db, geometry: GeoObjectDraft["geometry"]): Promise<{ geom: string } | { invalid: string }> {
  const { rows } = await db.execute<{ g: string | null; reason: string }>(resolveGeometrySql(geometry));
  const { g, reason } = rows[0]!;
  return g ? { geom: g } : { invalid: reason };
}

export type UpsertResult = { id: string; created: boolean; changed: boolean; names: number };

/** The first external ID present on the draft, as column and value. */
function externalKey(draft: GeoObjectDraft) {
  if (draft.osmId) return eq(geoObjects.osmId, draft.osmId);
  if (draft.wikidataId) return eq(geoObjects.wikidataId, draft.wikidataId);
  if (draft.geonamesId) return eq(geoObjects.geonamesId, draft.geonamesId);
  return undefined;
}

function sameTags(a: unknown, b: Record<string, string>): boolean {
  const x = (a ?? {}) as Record<string, string>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(b).length && keys.every((k) => x[k] === b[k]);
}

/**
 * Inserts or updates the valid geo object matching the draft's first external ID (`osm_id`, else
 * `wikidata_id`, else `geonames_id`; without any ID always a new object), then adds its names.
 * An existing object is only updated when type, category, tags or geometry changed (the history
 * trigger records core-column changes); a delivered type without public ID gets one, a type change into another id
 * family a new one (`publicIdAfter`). Origin and
 * external IDs of an existing object are left alone. An invalid geometry is repaired; one that cannot
 * be repaired writes nothing and returns `{ skipped: <reason> }`.
 */
export async function upsertGeoObject(db: Db, draft: GeoObjectDraft): Promise<UpsertResult | { skipped: string }> {
  const resolved = await resolveGeometry(db, draft.geometry);
  if ("invalid" in resolved) return { skipped: resolved.invalid };
  const { geom } = resolved;
  const tags = draft.tags ?? {};
  const category = draft.category ?? null;
  const key = externalKey(draft);

  const [existing] = key
    ? await db
        .select({
          id: geoObjects.id,
          adminLevel: geoObjects.adminLevel,
          type: geoObjects.type,
          category: geoObjects.category,
          tags: geoObjects.tags,
          publicId: geoObjects.publicId,
          sameGeom: sql<boolean>`ST_OrderingEquals(${geoObjects.geom}, ${geom}::geometry)`,
        })
        .from(geoObjects)
        .where(and(key, isNull(geoObjects.validTo)))
        .for("update")
    : [];

  let id: string;
  let created = false;
  let changed = false;
  if (!existing) {
    const [row] = await db
      .insert(geoObjects)
      .values({
        type: draft.type,
        category,
        origin: draft.origin,
        osmId: draft.osmId,
        wikidataId: draft.wikidataId,
        geonamesId: draft.geonamesId,
        tags,
        adminLevel: draft.adminLevel ?? null,
        geom: sql`${geom}::geometry`,
        publicId: publicIdFor(draft.type),
      })
      .returning({ id: geoObjects.id });
    id = row!.id;
    created = true;
    changed = true;
  } else {
    id = existing.id;
    const publicId = publicIdAfter(draft.type, existing.publicId);
    changed =
      existing.type !== draft.type ||
      existing.category !== category ||
      existing.adminLevel !== (draft.adminLevel ?? null) ||
      !sameTags(existing.tags, tags) ||
      !existing.sameGeom ||
      publicId !== existing.publicId;
    if (changed) {
      await db
        .update(geoObjects)
        .set({
          type: draft.type,
          category,
          tags,
          adminLevel: draft.adminLevel ?? null,
          publicId,
          ...(existing.sameGeom ? {} : { geom: sql`${geom}::geometry` }),
        })
        .where(eq(geoObjects.id, id));
    }
  }

  const names = await addNames(db, id, draft.names);
  return { id, created, changed, names };
}
