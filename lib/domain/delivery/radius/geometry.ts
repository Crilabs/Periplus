import type { Region } from "@/contract/v3_0";
import type { DeliveryConfig } from "@/lib/config";
import { tileBbox } from "@/lib/domain/tiles";
import { distanceNm, distanceToPolygonNm, EARTH_RADIUS_NM, round5 } from "../geo";
import type { LonLat } from "../types";

/*
 * The circle of a radius package (spec 18, "Umkreis"): its radius from the trip length, its ring and box, and whether a
 * region or a tile cell touches it. Great-circle geometry on the sphere of `distanceNm`; the Mediterranean never reaches
 * the antimeridian or a pole, so neither is handled beyond clamping the box.
 */

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Radius in nautical miles for a trip of `days` days: `nmPerDay × days × returnFactor`. */
export function radiusNm(days: number, cfg: DeliveryConfig["radius"]): number {
  if (!Number.isInteger(days) || days < cfg.minDays || days > cfg.maxDays) {
    throw new RangeError(`days must be an integer within ${cfg.minDays}–${cfg.maxDays}: ${days}`);
  }
  return cfg.nmPerDay * days * cfg.returnFactor;
}

/** The point `nm` nautical miles from `from` on the initial bearing `bearingDeg` (great circle), unrounded. */
export function destination(from: LonLat, bearingDeg: number, nm: number): LonLat {
  const d = nm / EARTH_RADIUS_NM;
  const lat1 = rad(from.lat);
  const brg = rad(bearingDeg);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
  const lon2 = rad(from.lon) + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lon: deg(lon2), lat: deg(lat2) };
}

/** A GeoJSON polygon with `[lon, lat]` positions (as the contract's `geoPolygon`). */
export type CirclePolygon = GeoJSON.Polygon & { coordinates: Array<Array<[number, number]>> };

/**
 * The circle as a GeoJSON polygon: `segments` geodesic points counter-clockwise from due east, closed (first = last),
 * five decimals.
 */
export function circlePolygon(center: LonLat, radiusNm: number, segments = 64): CirclePolygon {
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < segments; i++) {
    // counter-clockwise in lon/lat: east (90°), north (0°), west (270°), south (180°)
    const p = destination(center, 90 - (360 * i) / segments, radiusNm);
    ring.push([round5(p.lon), round5(p.lat)]);
  }
  ring.push([ring[0]![0], ring[0]![1]]);
  return { type: "Polygon", coordinates: [ring] };
}

const floor5 = (n: number) => round5(Math.floor(n * 1e5) / 1e5);
const ceil5 = (n: number) => round5(Math.ceil(n * 1e5) / 1e5);

/** `[west, south, east, north]` around the circle, rounded outward to five decimals. */
export function circleBbox(center: LonLat, radiusNm: number): [number, number, number, number] {
  const d = radiusNm / EARTH_RADIUS_NM;
  const dLat = deg(d);
  // widest longitude of a spherical cap: asin(sin d / cos φ)
  const s = Math.sin(d) / Math.cos(rad(center.lat));
  const dLon = s >= 1 ? 180 : deg(Math.asin(s));
  return [
    Math.max(-180, floor5(center.lon - dLon)),
    Math.max(-90, floor5(center.lat - dLat)),
    Math.min(180, ceil5(center.lon + dLon)),
    Math.min(90, ceil5(center.lat + dLat)),
  ];
}

/** A region touches the circle: by its polygon, else by its centre and radius. */
export function regionTouchesCircle(region: Region, center: LonLat, radiusNm: number): boolean {
  if (region.polygon) return distanceToPolygonNm(center, region.polygon) <= radiusNm;
  return distanceNm(center, region.center) - region.radiusNm <= radiusNm;
}

/** The 0.25° cell of a tile (`q025:<col>:<row>`) touches the circle: its nearest point lies within the radius. */
export function tileTouchesCircle(tileId: string, center: LonLat, radiusNm: number): boolean {
  const [west, south, east, north] = tileBbox(tileId);
  const nearest = { lon: Math.min(east, Math.max(west, center.lon)), lat: Math.min(north, Math.max(south, center.lat)) };
  return distanceNm(center, nearest) <= radiusNm;
}
