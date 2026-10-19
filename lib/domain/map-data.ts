import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { z } from "zod";
import { getConfig, getConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import { geoObjects, places, restrictedAreas, tiles, type RestrictedKind } from "@/lib/db/schema";
import { confidenceClass } from "@/lib/domain/consolidation/weights";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { isAnchoringBan, type AnchoringBanConfig } from "@/lib/domain/geometry/restrictions";
import type { Bbox } from "@/lib/domain/tiles";
import { BBOX_TOLERANCE, MAX_BBOX_DEGREES } from "@/lib/domain/map-limits";
import { validAt } from "@/lib/domain/timeline";

export const MAP_LAYERS = ["areas", "tiles", "geo-objects", "places", "restricted-areas"] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

/** Default cap per request; beyond ~5,000 objects the map switches to vector tiles (spec 09). */
export const MAP_FEATURE_LIMIT = 5000;


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

export const mapDataRequest = z.object({ layer: z.enum(MAP_LAYERS), bbox: bboxParam });

type Row = { geometry: Geometry; properties: Record<string, unknown> };

const envelope = ([west, south, east, north]: Bbox): SQL =>
  sql`ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)`;

/** Index-assisted bbox test (`&&`) plus the exact intersection. */
const intersects = (geom: AnyColumn, bbox: Bbox): SQL =>
  sql`(${geom} && ${envelope(bbox)} and ST_Intersects(${geom}, ${envelope(bbox)}))`;

function layerQuery(layer: MapLayer, bbox: Bbox, limit: number): SQL {
  switch (layer) {
    case "areas":
      return sql`
        select ${asGeoJson(geoObjects.geom)} as geometry,
          json_build_object('id', ${geoObjects.id}, 'key', ${geoObjects.configKey}, 'name', ${displayNameSql(geoObjects.id)}) as properties
        from ${geoObjects}
        where ${geoObjects.type} = 'area' and ${validAt(geoObjects)} and ${intersects(geoObjects.geom, bbox)}
        order by ${geoObjects.id}
        limit ${limit}`;
    case "tiles":
      return sql`
        select ${asGeoJson(tiles.bbox)} as geometry,
          json_build_object(
            'id', ${tiles.id},
            'hasCoast', ${tiles.hasCoast},
            'areaKey', (select a.config_key from geo_objects a where a.id = ${tiles.areaId}),
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
        where ${geoObjects.type} <> 'area' and ${validAt(geoObjects)} and ${intersects(geoObjects.geom, bbox)}
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
 * One map layer as GeoJSON: valid rows intersecting `bbox`, at most `limit` features (default 5,000).
 * `geo-objects` leaves out areas (own layer). Tile counts: `placeCount` all valid places of the tile,
 * `candidateCount` those still `candidate`. `restricted-areas` carry `anchoringBan` by `opts.anchoringBan`
 * (default: the configured rule). `places` carry `profileConfidence` and `profileClass` of the newest profile version
 * of their geo object (its class by that version's rules), both null without a profile (or without a profile
 * confidence); `hasProfile` tells those two apart.
 */
export async function mapLayer(
  db: Db,
  layer: MapLayer,
  bbox: Bbox,
  opts: { limit?: number; anchoringBan?: AnchoringBanConfig } = {},
): Promise<FeatureCollection> {
  const { rows } = await db.execute<Row>(layerQuery(layer, bbox, opts.limit ?? MAP_FEATURE_LIMIT));
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
  return { type: "FeatureCollection", features };
}
