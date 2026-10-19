import type { LonLat } from "./types";

/*
 * Small pure geometry for the delivery (spec 08, Teil B): coordinates with five decimals, distances in nautical
 * miles. Fine for checks within an area; the database does the heavy geometry.
 */

/** Earth radius in nautical miles. */
const EARTH_RADIUS_NM = 3440.065;
const NM_PER_DEGREE = 60;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** At most five decimals (Teil B "Dezimalgrad mit 5 Nachkommastellen"). */
export function round5(n: number): number {
  return Number(n.toFixed(5));
}

/** Great-circle distance (haversine), nautical miles. */
export function distanceNm(a: LonLat, b: LonLat): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray casting against one ring (`[lon, lat]` positions). */
function inRing(p: LonLat, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and in none of the holes, for any polygon of a multipolygon. */
export function pointInPolygon(p: LonLat, g: GeoJSON.Polygon | GeoJSON.MultiPolygon): boolean {
  const polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polygons.some(([outer, ...holes]) => outer !== undefined && inRing(p, outer) && !holes.some((h) => inRing(p, h)));
}

/**
 * Distance from the point to the nearest segment of the lines, nautical miles, in a local equirectangular projection
 * centred on the point; no lines → infinity.
 */
export function distanceToLinesNm(p: LonLat, lines: Array<GeoJSON.LineString | GeoJSON.MultiLineString>): number {
  const kx = Math.cos(rad(p.lat)) * NM_PER_DEGREE;
  const project = ([lon, lat]: number[]): [number, number] => [(lon! - p.lon) * kx, (lat! - p.lat) * NM_PER_DEGREE];
  let best = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    for (const part of line.type === "LineString" ? [line.coordinates] : line.coordinates) {
      for (let i = 1; i < part.length; i++) best = Math.min(best, distanceToSegment(project(part[i - 1]!), project(part[i]!)));
    }
  }
  return best;
}

/** Distance from the point to the polygon, nautical miles: 0 inside, else to the nearest ring (as `distanceToLinesNm`). */
export function distanceToPolygonNm(p: LonLat, g: GeoJSON.Polygon | GeoJSON.MultiPolygon): number {
  if (pointInPolygon(p, g)) return 0;
  const rings = (g.type === "Polygon" ? [g.coordinates] : g.coordinates).flat();
  return distanceToLinesNm(p, [{ type: "MultiLineString", coordinates: rings }]);
}

/** Distance from the origin to the segment a–b (plane). */
function distanceToSegment([ax, ay]: [number, number], [bx, by]: [number, number]): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
