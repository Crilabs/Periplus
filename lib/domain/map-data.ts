import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { z } from "zod";
import { getConfig, getConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import { geoObjects, geoObjectTypeEnum, places, restrictedAreas, subdivisions, tiles, type GeoObjectType, type RestrictedKind } from "@/lib/db/schema";
import { confidenceClass } from "@/lib/domain/consolidation/weights";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { isAnchoringBan, type AnchoringBanConfig } from "@/lib/domain/geometry/restrictions";
import type { Bbox } from "@/lib/domain/tiles";
import { BBOX_TOLERANCE, MAP_FEATURE_LIMIT, MAX_BBOX_DEGREES, NOT_IN_GEO_OBJECT_LAYER } from "@/lib/domain/map-limits";
import { areaSubdivisionsSql } from "@/lib/domain/areas/view";
import { validAt } from "@/lib/domain/timeline";

export const MAP_LAYERS = ["subdivisions", "seas", "areas", "tiles", "geo-objects", "places", "restricted-areas"] as const;

/** Large outlines (subdivisions, seas) are drawn simplified to this many degrees (about 100 m). */
const OUTLINE_SIMPLIFY_DEG = 0.001;
export type MapLayer = (typeof MAP_LAYERS)[number];

export { MAP_FEATURE_LIMIT };


const coordinate = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .transform(Number);

/** `w,s,e,n` in WGS84 degrees: west < east, south < north, each side at most 5°. */
export const bboxParam = z
  .string()
  .transform((s) => s.split(","))
  .pipe(z.tuple([coordinate, coordinate, coordinate, coordinate]))
  .refine(([w, s, e, n]) => w >= -180 && e <= 180 && s >= -90 && n <= 90, "outside WGS84")
  .refine(([w, s, e, n]) => w < e && s < n, "empty bbox")
  .refine(([w, s, e, n]) => e - w <= MAX_BBOX_DEGREES + BBOX_TOLERANCE && n - s <= MAX_BBOX_DEGREES + BBOX_TOLERANCE, "bbox too large")
  .transform((b): Bbox => b);

/** `?types=bay,island` of the geo-object layer: only these types (filtered in the query, so the cap counts only them). */
export const typesParam = z
  .string()
  .transform((s) => (s === "" ? [] : s.split(",")))
  .pipe(z.array(z.enum(geoObjectTypeEnum.enumValues)).max(geoObjectTypeEnum.enumValues.length));

/** `?subdivision=GR-ATT` of the areas layer: only areas whose scope tiles belong to this subdivision (by key). */
export const subdivisionParam = z.string().trim().min(1).max(64);

export const mapDataRequest = z.object({
  layer: z.enum(MAP_LAYERS),
  bbox: bboxParam,
  types: typesParam.optional(),
  subdivision: subdivisionParam.optional(),
});

/** A layer's features plus `truncated` (a GeoJSON foreign member): more rows than the cap intersect the view. */
export type MapLayerData = FeatureCollection & { truncated: boolean };

type Row = { geometry: Geometry; properties: Record<string, unknown> };

const envelope = ([west, south, east, north]: Bbox): SQL =>
  sql`ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)`;

/** Index-assisted bbox test (`&&`) plus the exact intersection. */
const intersects = (geom: AnyColumn, bbox: Bbox): SQL =>
  sql`(${geom} && ${envelope(bbox)} and ST_Intersects(${geom}, ${envelope(bbox)}))`;

function layerQuery(layer: MapLayer, bbox: Bbox, limit: number, types?: GeoObjectType[], subdivision?: string): SQL {
  switch (layer) {
    case "subdivisions":
      return sql`
        select ST_AsGeoJSON(ST_SimplifyPreserveTopology(${subdivisions.geom}, ${OUTLINE_SIMPLIFY_DEG}), 5)::json as geometry,
          json_build_object(
            'key', ${subdivisions.key},
            'country', ${subdivisions.country},
            'status', ${subdivisions.status},
            'name', ${displayNameSql(subdivisions.geoObjectId)}
          ) as properties
        from ${subdivisions}
        where ${subdivisions.validTo} is null and ${intersects(subdivisions.geom, bbox)}
        order by ${subdivisions.key}
        limit ${limit}`;
    case "seas":
      return sql`
        select ST_AsGeoJSON(ST_SimplifyPreserveTopology(${geoObjects.geom}, ${OUTLINE_SIMPLIFY_DEG}), 5)::json as geometry,
          json_build_object('id', ${geoObjects.id}, 'name', ${displayNameSql(geoObjects.id)}) as properties
        from ${geoObjects}
        where ${geoObjects.type} = 'sea' and ${validAt(geoObjects)} and ${intersects(geoObjects.geom, bbox)}
        order by ${geoObjects.id}
        limit ${limit}`;
    case "areas":
      return sql`
        select ${asGeoJson(geoObjects.geom)} as geometry,
          json_build_object(
            'id', ${geoObjects.id},
            'key', ${geoObjects.configKey},
            'name', ${displayNameSql(geoObjects.id)},
            'subdivisionKeys', (select string_agg(x.key, ',' order by x.key) from (${areaSubdivisionsSql(sql`${geoObjects.id}`)}) x),
            'polygonOrigin', ${geoObjects.tags}->>'polygonOrigin'
          ) as properties
        from ${geoObjects}
        where ${geoObjects.type} = 'area' and ${validAt(geoObjects)} and ${intersects(geoObjects.geom, bbox)}
          ${subdivision ? sql`and exists (select 1 from (${areaSubdivisionsSql(sql`${geoObjects.id}`)}) y where y.key = ${subdivision})` : sql``}
        order by ${geoObjects.id}
        limit ${limit}`;
    case "tiles":
      return sql`
        select ${asGeoJson(tiles.bbox)} as geometry,
          json_build_object(
            'id', ${tiles.id},
            'hasCoast', ${tiles.hasCoast},
            'subdivisionKey', (select s.key from subdivisions s where s.id = ${tiles.subdivisionId}),
            'placeCount', (select count(*) from ${places} where ${places.tileId} = ${tiles.id} and ${validAt(places)}),
            'candidateCount', (
              select count(*) from ${places}
              where ${places.tileId} = ${tiles.id} and ${places.status} = 'candidate' and ${validAt(places)}
            )
          ) as properties
        from ${tiles}
        where ${validAt(tiles)} and ${intersects(tiles.bbox, bbox)}
        order by ${tiles.id}
        limit ${limit}`;
    case "geo-objects":
      return sql`
        select ${asGeoJson(geoObjects.geom)} as geometry,
          json_build_object(
            'id', ${geoObjects.id},
            'type', ${geoObjects.type},
            'category', ${geoObjects.category},
            'name', ${displayNameSql(geoObjects.id)},
            'parentName', ${displayNameSql(geoObjects.parentId)}
          ) as properties
        from ${geoObjects}
        where ${geoObjects.type}::text <> all(${`{${NOT_IN_GEO_OBJECT_LAYER.join(",")}}`}::text[]) and ${validAt(geoObjects)} and ${intersects(geoObjects.geom, bbox)}
          ${types ? sql`and ${geoObjects.type}::text = any(${`{${types.join(",")}}`}::text[])` : sql``}
        order by ${geoObjects.id}
        limit ${limit}`;
    case "places":
      return sql`
        select ${asGeoJson(places.position)} as geometry,
          json_build_object(
            'id', ${places.id},
            'kind', ${places.kind},
            'status', ${places.status},
            'name', ${displayNameSql(places.geoObjectId)},
            'publicId', ${places.publicId},
            'profile', (
              select json_build_object('confidence', pr.confidence, 'rulesVersion', pr.rules_version)
              from profiles pr where pr.geo_object_id = ${places.geoObjectId}
              order by pr.version desc limit 1
            )
          ) as properties
        from ${places}
        where ${validAt(places)} and ${intersects(places.position, bbox)}
        order by ${places.id}
        limit ${limit}`;
    case "restricted-areas":
      return sql`
        select ${asGeoJson(restrictedAreas.geom)} as geometry,
          json_build_object(
            'id', ${restrictedAreas.id},
            'kind', ${restrictedAreas.kind},
            'sourceRef', ${restrictedAreas.sourceRef}
          ) as properties
        from ${restrictedAreas}
        where ${validAt(restrictedAreas)} and ${intersects(restrictedAreas.geom, bbox)}
        order by ${restrictedAreas.id}
        limit ${limit}`;
  }
}

/** The anchoring-ban rule of the configuration (as the geometry stage applies it). */
function configuredAnchoringBan(): AnchoringBanConfig {
  const config = getConfig();
  return {
    noAnchoringKinds: config.gazetteer.noAnchoringKinds,
    protectedAreaAnchoringBan: config.restrictions.protectedAreaAnchoringBan,
  };
}

/**
 * One map layer as GeoJSON: valid rows intersecting `bbox`, at most `limit` features (default 5,000), with
 * `truncated` when more intersect it (UI-12: the map says so instead of silently dropping objects).
 * `geo-objects` leaves out areas and seas (own layers), countries and admin regions (shown as `subdivisions`) and, with
 * `types`, keeps only those types. `areas` carry `subdivisionKeys` (comma-joined keys of the subdivisions their scope tiles belong to) and
 * `polygonOrigin`; with `subdivision` (a key) only the areas touching it. `subdivisions` and `seas` are simplified outlines; tiles carry their `subdivisionKey`. Tile counts: `placeCount` all valid places of the tile,
 * `candidateCount` those still `candidate`. `restricted-areas` carry `anchoringBan` by `opts.anchoringBan`
 * (default: the configured rule). `places` carry `profileConfidence` and `profileClass` of the newest profile version
 * of their geo object (its class by that version's rules), both null without a profile (or without a profile
 * confidence); `hasProfile` tells those two apart.
 */
export async function mapLayer(
  db: Db,
  layer: MapLayer,
  bbox: Bbox,
  opts: { limit?: number; anchoringBan?: AnchoringBanConfig; types?: GeoObjectType[]; subdivision?: string } = {},
): Promise<MapLayerData> {
  const limit = opts.limit ?? MAP_FEATURE_LIMIT;
  const { rows: fetched } = await db.execute<Row>(layerQuery(layer, bbox, limit + 1, layer === "geo-objects" ? opts.types : undefined, layer === "areas" ? opts.subdivision : undefined));
  const truncated = fetched.length > limit;
  const rows = fetched.slice(0, limit);
  if (layer === "restricted-areas") {
    const ban = opts.anchoringBan ?? configuredAnchoringBan();
    for (const r of rows) {
      const p = r.properties as { kind: RestrictedKind; sourceRef: string | null };
      r.properties.anchoringBan = isAnchoringBan(p.kind, p.sourceRef, ban);
    }
  }
  if (layer === "places") {
    for (const r of rows) {
      const profile = r.properties.profile as { confidence: number | null; rulesVersion: string } | null;
      delete r.properties.profile;
      const confidence = profile?.confidence ?? null;
      r.properties.hasProfile = profile !== null;
      r.properties.profileConfidence = confidence;
      r.properties.profileClass = confidence === null ? null : confidenceClass(confidence, getConsolidationConfig(profile!.rulesVersion));
    }
  }
  const features: Feature[] = rows.map((r) => ({ type: "Feature", geometry: r.geometry, properties: r.properties }));
  return { type: "FeatureCollection", features, truncated };
}
