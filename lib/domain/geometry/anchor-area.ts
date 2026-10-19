import { sql } from "drizzle-orm";
import type { Geometry, MultiPolygon, Position } from "geojson";
import type { GeometryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { utmSridFor } from "./projection";
import type { LonLat } from "./water";

/**
 * Anchor area of a place: water with depth `minDepthM`…`maxDepthM` at least `landClearanceM` from land.
 * `key` identifies the geometry like `WaterArea.key` (md5 of its WKB snapped to 1e-7°, `"empty"` without
 * area); `position` = centre of the largest inscribed circle (computed in UTM), null when empty.
 */
export type AnchorArea = {
  geometry: MultiPolygon | null;
  areaM2: number;
  position: LonLat | null;
  key: string;
};

/** Centre of the bounding box of a GeoJSON geometry (for the UTM zone); null without coordinates. */
function bboxCenter(g: Geometry): LonLat | null {
  const positions: Position[] = [];
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") positions.push(c as Position);
    else if (Array.isArray(c)) c.forEach(walk);
  };
  const visit = (x: Geometry): void => (x.type === "GeometryCollection" ? x.geometries.forEach(visit) : walk(x.coordinates));
  visit(g);
  if (positions.length === 0) return null;
  const lons = positions.map((p) => p[0]!);
  const lats = positions.map((p) => p[1]!);
  return { lon: (Math.min(...lons) + Math.max(...lons)) / 2, lat: (Math.min(...lats) + Math.max(...lats)) / 2 };
}

const EMPTY: AnchorArea = { geometry: null, areaM2: 0, position: null, key: "empty" };

/**
 * Anchor area inside `water`: raster pixels (centre inside the water, every raster intersecting it) with
 * `minDepthM ≤ depth ≤ maxDepthM` as polygons, unioned, intersected with the water, minus land buffered by
 * `landClearanceM` (land outside the water within the clearance counts too); polygon parts only.
 */
export async function anchorArea(db: Db, water: Geometry, cfg: GeometryConfig["anchorArea"]): Promise<AnchorArea> {
  const center = bboxCenter(water);
  if (!center) return EMPTY;
  const srid = utmSridFor(center.lon, center.lat);
  const { rows } = await db.execute<{ geometry: MultiPolygon | null; area_m2: number; lon: number | null; lat: number | null; key: string }>(sql`
    with w as (select ${geomFromGeoJson(water)} as geom),
    reach as (select ST_Buffer(w.geom::geography, ${cfg.landClearanceM}::float8)::geometry as geom from w),
    depth_band as (
      select ST_Union(d.geom) as geom
      from w, bathymetry b,
           lateral ST_DumpAsPolygons(ST_Clip(b.rast, 1, w.geom, true), 1) d
      where ST_ConvexHull(b.rast) && w.geom and ST_Intersects(b.rast, w.geom)
        and d.val >= ${cfg.minDepthM}::float8 and d.val <= ${cfg.maxDepthM}::float8
    ),
    land as (
      select ST_Union(ST_Intersection(l.geom, reach.geom)) as geom
      from land_polygons l, reach
      where l.geom && reach.geom and ST_Intersects(l.geom, reach.geom)
    ),
    clearance as (select ST_Buffer(land.geom::geography, ${cfg.landClearanceM}::float8)::geometry as geom from land),
    area as (
      select ST_Multi(ST_CollectionExtract(
               coalesce(ST_Difference(inside.geom, (select geom from clearance)), inside.geom), 3)) as geom
      from (select ST_Intersection(depth_band.geom, w.geom) as geom from depth_band, w where depth_band.geom is not null) inside
    ),
    nonempty as (select geom from area where not ST_IsEmpty(geom)),
    centre as (
      select ST_Transform((ST_MaximumInscribedCircle(ST_Transform(geom, ${srid}::int))).center, 4326) as geom
      from nonempty
    )
    select ST_AsGeoJSON(n.geom)::json as geometry,
           ST_Area(n.geom::geography) as area_m2,
           ST_X(c.geom) as lon, ST_Y(c.geom) as lat,
           md5(ST_AsBinary(ST_SnapToGrid(n.geom, 1e-7))) as key
    from nonempty n, centre c`);
  const row = rows[0];
  if (!row) return EMPTY;
  return {
    geometry: row.geometry,
    areaM2: Math.round(Number(row.area_m2)),
    position: { lon: Number(row.lon), lat: Number(row.lat) },
    key: row.key,
  };
}
