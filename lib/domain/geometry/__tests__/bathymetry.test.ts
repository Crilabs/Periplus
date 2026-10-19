import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { bathymetry } from "@/lib/db/schema";
import { withRollback } from "@/test/db";
import { insertTestRaster } from "@/test/geometry/raster";
import { importBathymetryRaster } from "../bathymetry";

const TILE = "q025:804:501";
const input = (bytes: Uint8Array) => ({
  bytes,
  dataset: "synthetic-import",
  datasetVersion: "v1",
  resolutionM: 100,
  tileId: TILE,
  valueIsElevation: true,
});

/** Band-1 value of the imported synthetic raster at a WGS84 point (NULL for nodata / no coverage). */
async function valueAt(tx: Db, lon: number, lat: number): Promise<number | null> {
  const { rows } = await tx.execute<{ v: number | null }>(sql`
    select ST_Value(b.rast, 1, p) as v
    from bathymetry b, (select ST_SetSRID(ST_MakePoint(${lon}::float8, ${lat}::float8), 4326) as p) q
    where b.dataset = 'synthetic-import' and b.tile_id = ${TILE} and ST_Intersects(b.rast, p)
    limit 1`);
  return rows[0]?.v ?? null;
}

const rowCount = async (tx: Db) =>
  (await tx.select({ id: bathymetry.id }).from(bathymetry).where(and(eq(bathymetry.dataset, "synthetic-import"), eq(bathymetry.tileId, TILE)))).length;

describe("bathymetry raster", () => {
  it("GTiff round trip works (GDAL driver enabled)", () =>
    withRollback(async (tx) => {
      const bytes = (await insertTestRaster(tx, { asElevationGtiff: true })) as Uint8Array;
      expect(bytes.byteLength).toBeGreaterThan(0);
      const { rows } = await tx.execute<{ w: number; srid: number }>(
        sql`select ST_Width(r) as w, ST_SRID(r) as srid from (select ST_FromGDALRaster(${Buffer.from(bytes)}) as r) t`,
      );
      expect(rows[0]).toEqual({ w: 10, srid: 4326 });
    }));

  it("importBathymetryRaster flips elevation to positive depth and replaces per tile", () =>
    withRollback(async (tx) => {
      const bytes = (await insertTestRaster(tx, { asElevationGtiff: true, landPixel: [0, 0] })) as Uint8Array;
      expect(await importBathymetryRaster(tx, input(bytes))).toEqual({ rasterTiles: 1 });
      expect(await valueAt(tx, 21.0045, 35.2075)).toBe(6); // row 2
      expect(await valueAt(tx, 21.0005, 35.2095)).toBe(-5); // land pixel: elevation +5 → depth −5
      const first = await rowCount(tx);
      expect(first).toBe(1);

      await importBathymetryRaster(tx, input(bytes));
      expect(await rowCount(tx)).toBe(first);
    }));

  it("nodata stays nodata when the sign is flipped", () =>
    withRollback(async (tx) => {
      const elevation = (await insertTestRaster(tx, { asElevationGtiff: true })) as Uint8Array;
      const { rows } = await tx.execute<{ bytes: Buffer }>(sql`
        select ST_AsGDALRaster(ST_SetValue(ST_FromGDALRaster(${Buffer.from(elevation)}), 1, 1, 1, -9999), 'GTiff') as bytes`);
      await importBathymetryRaster(tx, input(new Uint8Array(rows[0]!.bytes)));
      expect(await valueAt(tx, 21.0005, 35.2095)).toBeNull();
      expect(await valueAt(tx, 21.0015, 35.2095)).toBe(2);
      const nodata = await tx.execute<{ nd: number }>(sql`
        select ST_BandNoDataValue(rast, 1) as nd from bathymetry where dataset = 'synthetic-import' and tile_id = ${TILE}`);
      expect(nodata.rows[0]!.nd).toBe(-9999);
    }));

  it("depth values (valueIsElevation false) are stored unchanged", () =>
    withRollback(async (tx) => {
      const elevation = (await insertTestRaster(tx, { asElevationGtiff: true })) as Uint8Array;
      await importBathymetryRaster(tx, { ...input(elevation), valueIsElevation: false });
      expect(await valueAt(tx, 21.0045, 35.2075)).toBe(-6);
    }));
});
