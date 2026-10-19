import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { bathymetry } from "@/lib/db/schema";
import type { LonLat } from "@/lib/domain/geometry/water";
import { tileIdFor } from "@/lib/domain/tiles";

export const TEST_RASTER_SIZE = 10;
export const TEST_RASTER_PIXEL_DEG = 0.001;
export const TEST_RASTER_DATASET = "synthetic-dtm";
export const TEST_RASTER_VERSION = "synthetic-1";
export const TEST_RASTER_RESOLUTION_M = 100;
const DEFAULT_ORIGIN: LonLat = { lon: 21.0, lat: 35.21 };
const NODATA = -9999;

/**
 * Synthetic 10×10 bathymetry raster (SRID 4326, band 32BF, nodata −9999, pixel 0.001°) with its
 * top-left corner at `origin` (default 21.000 E / 35.210 N, outside the pilot box). Row r (0 = north)
 * holds depth 2·(r+1) m; `landPixel` [row, col] gets −5 (dry). Inserted into `bathymetry` under
 * `tileId` (default the tile of `origin`) — write it only inside `withRollback`. With
 * `asElevationGtiff` nothing is inserted; the GTiff bytes of the elevation values −2·(r+1) are returned.
 */
export async function insertTestRaster(
  tx: Db,
  opts: { asElevationGtiff?: boolean; landPixel?: [row: number, col: number]; origin?: LonLat; tileId?: string } = {},
): Promise<Uint8Array | void> {
  const origin = opts.origin ?? DEFAULT_ORIGIN;
  const sign = opts.asElevationGtiff ? -1 : 1;
  const values = Array.from({ length: TEST_RASTER_SIZE }, (_, r) =>
    Array.from({ length: TEST_RASTER_SIZE }, (_, c) =>
      opts.landPixel && opts.landPixel[0] === r && opts.landPixel[1] === c ? -5 * sign : sign * 2 * (r + 1),
    ),
  );
  const literal = `{${values.map((row) => `{${row.join(",")}}`).join(",")}}`;
  const rast = sql`ST_SetValues(
    ST_AddBand(
      ST_MakeEmptyRaster(${TEST_RASTER_SIZE}::int, ${TEST_RASTER_SIZE}::int, ${origin.lon}::float8, ${origin.lat}::float8,
        ${TEST_RASTER_PIXEL_DEG}::float8, ${-TEST_RASTER_PIXEL_DEG}::float8, 0::float8, 0::float8, 4326),
      '32BF'::text, 0::float8, ${NODATA}::float8),
    1, 1, 1, ${literal}::float8[][])`;

  if (opts.asElevationGtiff) {
    const { rows } = await tx.execute<{ bytes: Buffer }>(sql`select ST_AsGDALRaster(${rast}, 'GTiff') as bytes`);
    return new Uint8Array(rows[0]!.bytes);
  }
  await tx.insert(bathymetry).values({
    dataset: TEST_RASTER_DATASET,
    datasetVersion: TEST_RASTER_VERSION,
    resolutionM: TEST_RASTER_RESOLUTION_M,
    tileId: opts.tileId ?? tileIdFor(origin.lon, origin.lat),
    rast,
  });
}
