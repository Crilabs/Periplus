import type { Polygon } from "geojson";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { withRollback } from "@/test/db";
import { insertTestRaster, TEST_RASTER_DATASET, TEST_RASTER_RESOLUTION_M, TEST_RASTER_VERSION } from "@/test/geometry/raster";
import { depthConfidence, depthRange, sampleDepths } from "../depth";

const cfg = loadConfig("config").geometry;

const box = (w: number, s: number, e: number, n: number): Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

describe("sampleDepths", () => {
  it("samples 50/100/200 m south of the origin", () =>
    withRollback(async (tx) => {
      await insertTestRaster(tx);
      expect(await sampleDepths(tx, { lon: 21.0045, lat: 35.2077 }, 180, [50, 100, 200])).toEqual([6, 8, 10]);
    }));

  it("outside the raster and on a land pixel the sample is null", () =>
    withRollback(async (tx) => {
      await insertTestRaster(tx, { landPixel: [2, 4] });
      expect(await sampleDepths(tx, { lon: 21.0045, lat: 35.2077 }, 180, [50, 100, 200])).toEqual([null, 8, 10]);
      // 1 km south of the origin lies below the raster's last row.
      expect(await sampleDepths(tx, { lon: 21.0045, lat: 35.2077 }, 180, [1000])).toEqual([null]);
      expect(await sampleDepths(tx, { lon: 21.05, lat: 35.2077 }, 180, [50])).toEqual([null]);
    }));

  it("the finest raster covering the point wins", () =>
    withRollback(async (tx) => {
      await insertTestRaster(tx);
      // Finer copy of the same raster with depth + 0.25 m over the eastern half only (cols 5..9).
      await tx.execute(sql`
        insert into bathymetry (id, dataset, dataset_version, resolution_m, tile_id, rast)
        select gen_random_uuid(), 'synthetic-hr', 'v1', 30, tile_id,
               ST_Clip(ST_MapAlgebra(rast, 1, '32BF', '[rast] + 0.25'),
                       ST_MakeEnvelope(21.005, 35.2, 21.01, 35.21, 4326))
        from bathymetry where dataset = ${TEST_RASTER_DATASET}`);
      expect(await sampleDepths(tx, { lon: 21.0075, lat: 35.2077 }, 180, [50])).toEqual([6.3]);
      expect(await sampleDepths(tx, { lon: 21.0025, lat: 35.2077 }, 180, [50])).toEqual([6]);
    }));
});

describe("depthRange", () => {
  it("depthRange over rows 1..5 → min 4, max 12; outside → null", () =>
    withRollback(async (tx) => {
      await insertTestRaster(tx);
      expect(await depthRange(tx, box(21.001, 35.204, 21.009, 35.209))).toEqual({
        min: 4,
        max: 12,
        resolutionM: TEST_RASTER_RESOLUTION_M,
        datasets: [{ dataset: TEST_RASTER_DATASET, version: TEST_RASTER_VERSION, resolutionM: TEST_RASTER_RESOLUTION_M }],
      });
      expect(await depthRange(tx, box(21.1, 35.1, 21.2, 35.15))).toBeNull();
    }));

  it("ignores land pixels and returns null when only land is inside", () =>
    withRollback(async (tx) => {
      await insertTestRaster(tx, { landPixel: [0, 0] });
      // Pixel (0, 0) alone: centre 21.0005 / 35.2095.
      expect(await depthRange(tx, box(21.0001, 35.2091, 21.0009, 35.2099))).toBeNull();
      expect((await depthRange(tx, box(21.0001, 35.2081, 21.0019, 35.2099)))?.min).toBe(2);
    }));
});

describe("depthConfidence", () => {
  it("depthConfidence", () => {
    expect(depthConfidence(115, 350, cfg.depth)).toBe(0.6);
    expect(depthConfidence(115, 200, cfg.depth)).toBe(0.3);
    expect(depthConfidence(20, 100, cfg.depth)).toBe(0.8);
    expect(depthConfidence(30, 100, cfg.depth)).toBe(0.8);
    expect(depthConfidence(115, 300, cfg.depth)).toBe(0.6);
  });
});
