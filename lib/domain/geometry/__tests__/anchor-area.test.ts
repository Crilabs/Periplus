import type { Geometry, Polygon } from "geojson";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { withRollback } from "@/test/db";
import { insertTestRaster } from "@/test/geometry/raster";
import { anchorArea } from "../anchor-area";
import type { LonLat } from "../water";

const cfg = loadConfig("config").geometry.anchorArea;

const box = (w: number, s: number, e: number, n: number): Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

/** Extent of the test raster: 21.000–21.010 E × 35.200–35.210 N; row r (0 = north) has depth 2·(r+1) m. */
const RASTER_EXTENT = box(21.0, 35.2, 21.01, 35.21);

const within = (value: number, expected: number, share: number) =>
  expect(Math.abs(value / expected - 1), `${value} vs ${expected}`).toBeLessThanOrEqual(share);

async function insertLandBox(tx: Db, g: Polygon): Promise<void> {
  await tx.execute(
    sql`insert into land_polygons (id, geom, dataset_version) values (gen_random_uuid(), ${geomFromGeoJson(g)}, 'synthetic-1')`,
  );
}

async function check(tx: Db, area: Geometry, p: LonLat): Promise<{ valid: boolean; inside: boolean; dLatM: number }> {
  const { rows } = await tx.execute<{ valid: boolean; inside: boolean; d: number }>(sql`
    with a as (select ${geomFromGeoJson(area)} as geom),
         p as (select ST_SetSRID(ST_MakePoint(${p.lon}::float8, ${p.lat}::float8), 4326) as geom)
    select ST_IsValid(a.geom) as valid, ST_Within(p.geom, a.geom) as inside,
           ST_Distance(p.geom::geography, ST_SetSRID(ST_MakePoint(${p.lon}::float8, 35.2065), 4326)::geography) as d
    from a, p`);
  const row = rows[0]!;
  return { valid: row.valid, inside: row.inside, dLatM: Number(row.d) };
}

describe("anchorArea", () => {
  it("band 3–12 m without land: ≈ 504,600 m² ±2 %, position on the band's centre line", () =>
    withRollback(async (tx) => {
      await insertTestRaster(tx);
      const result = await anchorArea(tx, RASTER_EXTENT, cfg);
      expect(result.geometry?.type).toBe("MultiPolygon");
      within(result.areaM2, 504_600, 0.02);
      expect(result.key).toMatch(/^[0-9a-f]{32}$/);
      expect(result.position).not.toBeNull();
      const c = await check(tx, result.geometry!, result.position!);
      expect(c.valid).toBe(true);
      expect(c.inside).toBe(true);
      expect(c.dLatM).toBeLessThanOrEqual(30);

      // Same inputs → same key.
      expect((await anchorArea(tx, RASTER_EXTENT, cfg)).key).toBe(result.key);
    }));

  it("a land strip lon 21.000–21.001 with 30 m clearance → ≈ 437,500 m² ±2 %", () =>
    withRollback(async (tx) => {
      await insertTestRaster(tx);
      await insertLandBox(tx, box(21.0, 35.2, 21.001, 35.21));
      const result = await anchorArea(tx, RASTER_EXTENT, cfg);
      within(result.areaM2, 437_500, 0.02);
      const c = await check(tx, result.geometry!, result.position!);
      expect(c.valid).toBe(true);
      expect(c.inside).toBe(true);
    }));

  it("land just outside the water still keeps its clearance", () =>
    withRollback(async (tx) => {
      await insertTestRaster(tx);
      // Land west of the raster, touching its western edge: water itself has no land.
      await insertLandBox(tx, box(20.99, 35.2, 21.0, 35.21));
      within((await anchorArea(tx, RASTER_EXTENT, cfg)).areaM2, 504_600 * (1 - 30 / 909), 0.02);
    }));

  it("water only over the 2 m row → null geometry, 0 m², no position", () =>
    withRollback(async (tx) => {
      await insertTestRaster(tx);
      expect(await anchorArea(tx, box(21.0, 35.209, 21.01, 35.21), cfg)).toEqual({
        geometry: null,
        areaM2: 0,
        position: null,
        key: "empty",
      });
    }));

  it("water without raster coverage → empty", () =>
    withRollback(async (tx) => {
      expect((await anchorArea(tx, box(21.1, 35.1, 21.11, 35.11), cfg)).key).toBe("empty");
    }));
});
