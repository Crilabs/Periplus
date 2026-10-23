import { sql } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { BerthLandingKind, BerthStateLanding } from "@/lib/db/schema/research-state";
import { activeAssessor } from "./assessment";
import { activeExtractor } from "./confirmation";
import { liveResearchSourceSql } from "./sources";

/*
 * Landing points of a berth (spec 5.7, plan N4a task 4). A marina or port is its own landing point. Otherwise the
 * landing objects (OSM piers, slipways) and beaches within `state.landingRadiusM` of the anchor area (else of the
 * anchor position, else of the place position); without any, the nearest shore point of the land polygons seen from
 * the anchor position. Every landing hint of a done unit of the active extractor, on the current version of its page,
 * comes on top as a text without position.
 */

type Row = { id: string; kind: BerthLandingKind; lon: number; lat: number };

/** The kind of a landing POI from its category and OSM tags: a beach, a slipway, else a pier. Pure. */
export function landingKind(category: string, tags: Record<string, unknown>): BerthLandingKind {
  if (category === "beach") return "beach";
  if (tags.leisure === "slipway" || tags.man_made === "slipway") return "slipway";
  return "pier";
}

export async function landingPoints(db: Db, placeId: string, config: AppConfig): Promise<BerthStateLanding[]> {
  const { landingRadiusM, shoreMaxM } = config.research.state;
  const { rows: places } = await db.execute<{
    kind: string;
    geo_object_id: string;
    lon: number;
    lat: number;
    anchor_lon: number | null;
    anchor_lat: number | null;
  }>(sql`
    select kind::text as kind, geo_object_id, ST_X(position) as lon, ST_Y(position) as lat,
           ST_X(anchor_position) as anchor_lon, ST_Y(anchor_position) as anchor_lat
    from places where id = ${placeId}`);
  const place = places[0];
  if (!place) throw new Error(`Unknown place ${placeId}`);

  const points: BerthStateLanding[] = [];
  if (place.kind === "marina" || place.kind === "port") {
    points.push({ kind: "harbour", lon: place.lon, lat: place.lat, geoObjectId: place.geo_object_id, description: null });
  } else {
    const found = await landingObjects(db, placeId, place.geo_object_id, landingRadiusM);
    if (found.length > 0) {
      points.push(...found.map((r): BerthStateLanding => ({ kind: r.kind, lon: r.lon, lat: r.lat, geoObjectId: r.id, description: null })));
    } else {
      const from = { lon: place.anchor_lon ?? place.lon, lat: place.anchor_lat ?? place.lat };
      const shore = await nearestShore(db, from, shoreMaxM);
      if (shore) points.push({ kind: "shore", lon: shore.lon, lat: shore.lat, geoObjectId: null, description: null });
    }
  }
  return [...points, ...(await hintTexts(db, placeId, config))];
}

/**
 * Landing objects and beaches within `radiusM` of the reference of the place: the newest computed anchor area, else the
 * anchor position, else the place position. Nearest first, ties by id.
 */
async function landingObjects(db: Db, placeId: string, geoObjectId: string, radiusM: number): Promise<Row[]> {
  const { rows } = await db.execute<{ id: string; category: string; tags: Record<string, unknown>; lon: number; lat: number }>(sql`
    with p as (
      select coalesce(
        (select ST_SetSRID(ST_GeomFromGeoJSON(c.outputs->'area'), 4326)
         from computations c
         where c.geo_object_id = ${geoObjectId} and c.kind = 'anchor_area' and jsonb_typeof(c.outputs->'area') = 'object'
         order by c.created_at desc, c.id desc limit 1),
        places.anchor_position, places.position) as ref
      from places where id = ${placeId}
    )
    select o.id, o.category::text as category, o.tags, ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat
    from p, geo_objects o
    where o.type = 'poi' and o.category in ('landing', 'beach') and o.valid_to is null and o.merged_into_id is null
      and ST_DWithin(o.centroid, p.ref, ${radiusM}::float8 / (111000 * cos(radians(least(abs(ST_Y(ST_PointOnSurface(p.ref))), 85)))) * 1.2)
      and ST_DWithin(o.centroid::geography, p.ref::geography, ${radiusM}::float8)
    order by ST_Distance(o.centroid::geography, p.ref::geography), o.id`);
  return rows.map((r) => ({ id: r.id, kind: landingKind(r.category, r.tags), lon: r.lon, lat: r.lat }));
}

/** The point of a land polygon boundary nearest to `from` within `maxM`; null without land polygons that near. */
async function nearestShore(db: Db, from: { lon: number; lat: number }, maxM: number): Promise<{ lon: number; lat: number } | null> {
  const { rows } = await db.execute<{ lon: number; lat: number }>(sql`
    with pt as (select ST_SetSRID(ST_MakePoint(${from.lon}::float8, ${from.lat}::float8), 4326) as geom),
    nearest as (select l.geom from land_polygons l, pt order by l.geom <-> pt.geom limit 1)
    select ST_X(s.geom) as lon, ST_Y(s.geom) as lat
    from nearest, pt, lateral (select ST_ClosestPoint(ST_Boundary(nearest.geom), pt.geom) as geom) s
    where ST_Distance(s.geom::geography, pt.geom::geography) <= ${maxM}::float8`);
  return rows[0] ?? null;
}

/**
 * The landing hints, read as the free facts are (`freeFacts`): done units of the active extractor, the document's
 * current version, a page with an active, not generated assessment, a live source. Oldest observation first.
 */
async function hintTexts(db: Db, placeId: string, config: AppConfig): Promise<BerthStateLanding[]> {
  const extractor = activeExtractor(config);
  const assessor = activeAssessor(config);
  const { rows } = await db.execute<{ description: string }>(sql`
    select h.description
    from landing_hints h
    join research_units u on u.id = h.unit_id
    join documents d on d.current_version_id = h.document_version_id
    join sources src on src.id = d.source_id
    join page_assessments a on a.document_version_id = h.document_version_id and a.model = ${assessor.model} and a.prompt_version = ${assessor.promptVersion}
    where h.place_id = ${placeId}
      and u.kind = 'berth' and u.status = 'done' and u.model = ${extractor.model} and u.prompt_version = ${extractor.promptVersion}
      and a.generated = false and ${liveResearchSourceSql("src")}
    order by h.observed_at, h.id`);
  // the same hint of several pages counts once
  const seen = new Set<string>();
  return rows
    .filter((r) => {
      const key = r.description.trim().toLowerCase();
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .map((r) => ({ kind: "text", lon: null, lat: null, geoObjectId: null, description: r.description }));
}
