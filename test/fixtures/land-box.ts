import { sql } from "drizzle-orm";
import type { Polygon } from "geojson";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { landPolygons } from "@/lib/db/schema";

/** Open sea west of the Peloponnese (outside every pilot box): land put here in a rolled-back test is the only land. */
export const SEA: [lon: number, lat: number] = [19.37, 36.61];
const KY = 110_540;
const kx = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** The point `east`, `north` metres from `origin` (local frame of the render scene). */
export function metresFrom(origin: [number, number], east: number, north: number): [number, number] {
  return [origin[0] + east / kx(origin[1]), origin[1] + north / KY];
}

/** A land polygon covering the rectangle `west…east`, `south…north` (metres from `origin`). */
export async function insertLandBox(tx: Db, origin: [number, number], west: number, south: number, east: number, north: number): Promise<void> {
  const ring = [[west, south], [east, south], [east, north], [west, north], [west, south]].map(([e, n]) => metresFrom(origin, e!, n!));
  const polygon: Polygon = { type: "Polygon", coordinates: [ring] };
  await tx.insert(landPolygons).values({ geom: sql`${geomFromGeoJson(polygon)}`, datasetVersion: "test" });
}
