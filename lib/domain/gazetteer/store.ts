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

function publicIdFor(type: GeoObjectType): string | null {
  const prefix = PUBLIC_ID_PREFIX[type];
  return prefix ? newPublicId(prefix) : null;
}

/**
 * The draft geometry as EWKB hex. Lines become `ST_BuildArea(ST_Collect(…))`; when they enclose no
 * area, the centroid of the lines. An invalid result (`ST_IsValid`) throws: it is never stored.
 */
async function resolveGeometry(db: Db, geometry: GeoObjectDraft["geometry"], label: string): Promise<string> {
  let expr: SQL;
  if ("lines" in geometry) {
    const lines = sql.join(geometry.lines.map((l) => geomFromGeoJson(l)), sql`, `);
    expr = sql`(SELECT CASE WHEN a IS NULL OR ST_IsEmpty(a) THEN ST_Centroid(c) ELSE a END
                FROM (SELECT c, ST_BuildArea(c) AS a FROM (SELECT ST_Collect(ARRAY[${lines}]) AS c) l) x)`;
  } else {
    expr = geomFromGeoJson(geometry);
  }
  const { rows } = await db.execute<{ g: string; valid: boolean; reason: string }>(
    sql`SELECT g, ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason FROM (SELECT ${expr} AS g) x`,
  );
  const { g, valid, reason } = rows[0]!;
  if (!valid) throw new Error(`invalid geometry for ${label}: ${reason}`);
  return g;
}

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
 * trigger records core-column changes); a delivered type without public ID gets one. Origin and
 * external IDs of an existing object are left alone. An invalid geometry throws.
 */
export async function upsertGeoObject(
  db: Db,
  draft: GeoObjectDraft,
): Promise<{ id: string; created: boolean; changed: boolean; names: number }> {
  const label = draft.osmId ?? draft.wikidataId ?? draft.geonamesId ?? `new ${draft.type}`;
  const geom = await resolveGeometry(db, draft.geometry, label);
  const tags = draft.tags ?? {};
  const category = draft.category ?? null;
  const key = externalKey(draft);

  const [existing] = key
    ? await db
        .select({
          id: geoObjects.id,
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
        geom: sql`${geom}::geometry`,
        publicId: publicIdFor(draft.type),
      })
      .returning({ id: geoObjects.id });
    id = row!.id;
    created = true;
    changed = true;
  } else {
    id = existing.id;
    const publicId = existing.publicId ?? publicIdFor(draft.type);
    changed =
      existing.type !== draft.type ||
      existing.category !== category ||
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
          publicId,
          ...(existing.sameGeom ? {} : { geom: sql`${geom}::geometry` }),
        })
        .where(eq(geoObjects.id, id));
    }
  }

  const names = await addNames(db, id, draft.names);
  return { id, created, changed, names };
}
