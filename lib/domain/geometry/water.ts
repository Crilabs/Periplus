import { sql, type SQL } from "drizzle-orm";
import type { Geometry, MultiPolygon, Polygon } from "geojson";
import type { GeometryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import type { LonLat } from "@/lib/domain/geo-view";
import { utmSridFor } from "./projection";

export type { LonLat };

/**
 * Water around a place, land subtracted. `key` identifies the geometry (md5 of its WKB snapped to
 * 1e-7°, `"empty"` without water); `widthM` = diameter of the largest inscribed circle (0 when empty).
 */
export type WaterArea = {
  geometry: Polygon | MultiPolygon | null;
  key: string;
  widthM: number;
  source: "polygon" | "circle";
};

export type OriginSource = "position" | "review_anchor" | "computed_anchor" | "moved_off_land";

const pointSql = (p: LonLat): SQL =>
  sql`ST_SetSRID(ST_MakePoint(${p.lon}::float8, ${p.lat}::float8), 4326)`;

/** Land polygons intersecting `geom` (WGS84), unioned; NULL without land. */
const landUnion = (geom: SQL): SQL =>
  sql`(select ST_Union(l.geom) from land_polygons l where l.geom && ${geom} and ST_Intersects(l.geom, ${geom}))`;

/**
 * Water area of a place: a polygon up to `maxPolygonAreaM2` as it is; a larger polygon cut to the circle
 * (`harbourRadiusM` for a harbour, else `bayRadiusM`) around `center`; a point → that circle. Land is
 * subtracted in every case.
 */
export async function waterArea(
  db: Db,
  input: { geom: Geometry; center: LonLat; isHarbour: boolean },
  cfg: GeometryConfig["water"],
): Promise<WaterArea> {
  const radiusM = input.isHarbour ? cfg.harbourRadiusM : cfg.bayRadiusM;
  const srid = utmSridFor(input.center.lon, input.center.lat);
  const { rows } = await db.execute<{ source: WaterArea["source"]; geometry: Polygon | MultiPolygon | null; key: string; width_m: number }>(sql`
    with input as (
      select ${geomFromGeoJson(input.geom)} as geom,
             ST_Buffer(${pointSql(input.center)}::geography, ${radiusM}::float8)::geometry as circle
    ),
    base as (
      select case
               when ST_Dimension(geom) < 2 then circle
               when ST_Area(geom::geography) <= ${cfg.maxPolygonAreaM2}::float8 then geom
               else ST_Intersection(geom, circle)
             end as geom,
             case when ST_Dimension(geom) < 2 then 'circle' else 'polygon' end as source
      from input
    ),
    water as (
      select source,
             ST_CollectionExtract(coalesce(ST_Difference(geom, ${landUnion(sql`base.geom`)}), geom), 3) as geom
      from base
    ),
    nonempty as (
      select source, case when ST_IsEmpty(geom) then null else geom end as geom from water
    )
    select source,
           ST_AsGeoJSON(geom)::json as geometry,
           coalesce(md5(ST_AsBinary(ST_SnapToGrid(geom, 1e-7))), 'empty') as key,
           coalesce(2 * (ST_MaximumInscribedCircle(ST_Transform(geom, ${srid}::int))).radius, 0) as width_m
    from nonempty`);
  const row = rows[0]!;
  return { geometry: row.geometry, key: row.key, widthM: Math.round(Number(row.width_m)), source: row.source };
}

/**
 * Origin of the fetch rays and depth samples: the review anchor (`anchor.origin === "review"`), else
 * this run's computed anchor, else the place position. A candidate on land is moved to the nearest
 * point of the water area shrunk by `originCoastOffsetM` (`ST_PointOnSurface(water)` when the shrunk
 * area is empty). `null` without water.
 */
export async function resolveOrigin(
  db: Db,
  input: {
    position: LonLat;
    anchor: { position: LonLat; origin: string | null } | null;
    computedAnchor: LonLat | null;
    water: WaterArea;
  },
  cfg: GeometryConfig["water"],
): Promise<{ origin: LonLat; source: OriginSource } | null> {
  if (!input.water.geometry) return null;
  const [candidate, source]: [LonLat, OriginSource] =
    input.anchor?.origin === "review"
      ? [input.anchor.position, "review_anchor"]
      : input.computedAnchor
        ? [input.computedAnchor, "computed_anchor"]
        : [input.position, "position"];

  const srid = utmSridFor(candidate.lon, candidate.lat);
  const point = pointSql(candidate);
  const { rows } = await db.execute<{ on_land: boolean; lon: number | null; lat: number | null }>(sql`
    with w as (select ST_Transform(${geomFromGeoJson(input.water.geometry)}, ${srid}::int) as geom),
    p as (select ST_Transform(${point}, ${srid}::int) as geom),
    on_land as (select ${landUnion(point)} is not null as on_land),
    moved as (
      select ST_Transform(
               case when ST_IsEmpty(shrunk) then ST_PointOnSurface(w.geom) else ST_ClosestPoint(shrunk, p.geom) end,
               4326) as geom
      from w, p, lateral (select ST_Buffer(w.geom, -${cfg.originCoastOffsetM}::float8) as shrunk) s
      where (select on_land from on_land)
    )
    select (select on_land from on_land) as on_land, ST_X(geom) as lon, ST_Y(geom) as lat
    from (select 1) one left join moved on true`);
  const row = rows[0]!;
  if (!row.on_land) return { origin: candidate, source };
  return { origin: { lon: Number(row.lon), lat: Number(row.lat) }, source: "moved_off_land" };
}
