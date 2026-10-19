import type { Geometry } from "geojson";
import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

export type GeometryType = "Geometry" | "Point" | "LineString" | "Polygon" | "MultiPolygon";

/**
 * PostGIS column `geometry(<type>,4326)`. The driver value is the raw EWKB hex string and is never
 * used directly: write with `geomFromGeoJson`, read with `asGeoJson`.
 */
export function geometry(name: string, type: GeometryType) {
  return customType<{ data: string; driverData: string }>({
    dataType: () => `geometry(${type},4326)`,
  })(name);
}

/** GeoJSON (WGS84) to a PostGIS geometry with SRID 4326. */
export function geomFromGeoJson(g: Geometry): SQL {
  return sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(g)}), 4326)`;
}

/** PostGIS geometry to GeoJSON. */
export function asGeoJson(col: AnyColumn | SQL): SQL<Geometry> {
  return sql<Geometry>`ST_AsGeoJSON(${col})::json`;
}

/**
 * PostGIS raster column `raster` (postgis_raster). The driver value is the raw hex WKB and is never
 * used directly; read values with ST_Value / ST_Clip in SQL.
 */
export function raster(name: string) {
  return customType<{ data: string; driverData: string }>({
    dataType: () => "raster",
  })(name);
}
