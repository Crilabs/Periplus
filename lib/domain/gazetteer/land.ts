import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { landPolygons } from "@/lib/db/schema";
import { getConfig } from "@/lib/config";
import { TILE_SIZE, type Bbox } from "@/lib/domain/tiles";

const KM_PER_DEGREE = 111.32;

type LandFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

/** Expands a box by `km` on every side; longitude degrees scale with the cosine of the mid-latitude. */
export function bufferBbox([west, south, east, north]: Bbox, km: number): Bbox {
  const dLat = km / KM_PER_DEGREE;
  const midLat = (south + north) / 2;
  const dLon = km / (KM_PER_DEGREE * Math.cos((midLat * Math.PI) / 180));
  return [west - dLon, south - dLat, east + dLon, north + dLat];
}

function envelope([west, south, east, north]: Bbox) {
  return sql`ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)`;
}

/** Cheap JS test on the coordinate extent; edges count as intersecting. */
export function featureIntersectsBbox(feature: LandFeature, [west, south, east, north]: Bbox): boolean {
  const g = feature.geometry;
  const rings = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  for (const polygon of rings) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of polygon[0]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxX >= west && minX <= east && maxY >= south && minY <= north) return true;
  }
  return false;
}

/**
 * Imports land polygons clipped to `bbox`. Stored polygons overlapping the box are first removed
 * (completely inside) or trimmed to their part outside it (working state), so re-imports never
 * duplicate and neighbouring areas keep their land. `replaced` counts the stored rows removed or
 * trimmed in the box.
 */
export async function importLandPolygons(
  db: Db,
  features: AsyncIterable<LandFeature>,
  bbox: Bbox,
  datasetVersion: string,
): Promise<{ inserted: number; replaced: number }> {
  return db.transaction(async (tx) => {
    const box = envelope(bbox);
    const old = await tx.execute(sql`
      WITH old AS (
        DELETE FROM land_polygons
        WHERE ST_Intersects(geom, ${box}) AND NOT ST_Touches(geom, ${box})
        RETURNING geom, dataset_version
      ), kept AS (
        INSERT INTO land_polygons (id, geom, dataset_version)
        SELECT gen_random_uuid(), d.geom, d.dataset_version
        FROM (
          SELECT (ST_Dump(ST_CollectionExtract(ST_Difference(geom, ${box}), 3))).geom AS geom, dataset_version
          FROM old WHERE NOT ST_Covers(${box}, geom)
        ) d
        WHERE NOT ST_IsEmpty(d.geom)
      )
      SELECT count(*)::int AS n FROM old`);
    const replaced = Number((old.rows[0] as { n: number }).n);
    let inserted = 0;
    for await (const feature of features) {
      if (!featureIntersectsBbox(feature, bbox)) continue;
      const res = await tx.execute(sql`
        INSERT INTO land_polygons (id, geom, dataset_version)
        SELECT gen_random_uuid(), d.geom, ${datasetVersion}
        FROM (
          SELECT (ST_Dump(ST_CollectionExtract(ST_Intersection(src.g, ${box}), 3))).geom AS geom
          FROM (
            SELECT ST_MakeValid(raw.g) AS g
            FROM (SELECT ${geomFromGeoJson(feature.geometry)} AS g) raw
            WHERE raw.g && ${box}
          ) src
          WHERE ST_Intersects(src.g, ${box})
        ) d
        WHERE NOT ST_IsEmpty(d.geom)`);
      inserted += res.rowCount ?? 0;
    }
    return { inserted, replaced };
  });
}

/** Number of land polygons intersecting the box. */
export async function landCoverage(db: Db, bbox: Bbox): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(landPolygons)
    .where(sql`ST_Intersects(${landPolygons.geom}, ${envelope(bbox)})`);
  return row.n;
}

/**
 * The box land polygons are imported for (spec 14): `subdivisions.mediterranean.bbox` (which covers the configured
 * Mediterranean seas) plus `bufferKm`, snapped outward to the tile grid. Reads no data, so the land import can run on an
 * empty database before the first run "Landesteile neu bilden" (B3, B14).
 */
export function mediterraneanBbox(bufferKm: number): Bbox {
  const [w, s, e, n] = bufferBbox(getConfig().subdivisions.mediterranean.bbox, bufferKm);
  return [
    Math.floor(w / TILE_SIZE) * TILE_SIZE,
    Math.floor(s / TILE_SIZE) * TILE_SIZE,
    Math.ceil(e / TILE_SIZE) * TILE_SIZE,
    Math.ceil(n / TILE_SIZE) * TILE_SIZE,
  ];
}

/**
 * Splits `bbox` into blocks of at most `blockDeg` degrees per side, from the south-west corner, row by row; the last
 * column and row end exactly at the box edge, so the blocks cover the box without gaps.
 */
export function countryBlocks([west, south, east, north]: Bbox, blockDeg: number): Bbox[] {
  const steps = (from: number, to: number) => Math.max(1, Math.ceil((to - from) / blockDeg - 1e-9));
  const columns = steps(west, east);
  const rows = steps(south, north);
  const blocks: Bbox[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      blocks.push([
        west + column * blockDeg,
        south + row * blockDeg,
        column === columns - 1 ? east : west + (column + 1) * blockDeg,
        row === rows - 1 ? north : south + (row + 1) * blockDeg,
      ]);
    }
  }
  return blocks;
}
