import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { bufferBbox, mediterraneanBbox } from "@/lib/domain/gazetteer/land";
import { TILE_SIZE } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";
import { parseArgs } from "../import-land-polygons";

describe("import-land-polygons CLI", () => {
  it("parses flags and defaults the version to today", () => {
    const a = parseArgs(["--shp", "x.shp", "--mediterranean"]);
    expect(a).toMatchObject({ shp: "x.shp", mediterranean: true });
    expect(a.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parseArgs(["--mediterranean", "--shp", "x", "--version", "2026-01-02"]).version).toBe("2026-01-02");
  });

  it("rejects missing, unknown or malformed arguments", () => {
    expect(() => parseArgs(["--mediterranean"])).toThrow(/usage/);
    expect(() => parseArgs(["--shp", "x"])).toThrow(/usage/);
    expect(() => parseArgs(["--shp", "x", "--area", "saronic"])).toThrow(/usage/);
    expect(() => parseArgs(["--shp", "x", "--mediterranean", "--foo", "1"])).toThrow(/usage/);
    expect(() => parseArgs(["--shp", "x", "--mediterranean", "--version", "today"])).toThrow(/YYYY-MM-DD/);
  });
});

describe("mediterraneanBbox", () => {
  it("covers the buffered extent of a configured sea, snapped outward to the tile grid", async () => {
    const mrgid = String(getConfig().subdivisions.mediterranean.marineRegionsMrgids[0]);
    await withRollback(async (tx) => {
      await tx.execute(sql`
        INSERT INTO geo_objects (id, type, origin, tags, geom)
        VALUES (gen_random_uuid(), 'sea', 'marine_regions', ${JSON.stringify({ mrgid })}::jsonb,
                ST_SetSRID(ST_GeomFromText('POLYGON((-30.07 -60.03, -29.5 -60.03, -29.5 -59.5, -30.07 -59.5, -30.07 -60.03))'), 4326))`);
      const km = getConfig().gazetteer.landBufferKm;
      const box = await mediterraneanBbox(tx, km);
      const [w, s, e, n] = bufferBbox([-30.07, -60.03, -29.5, -59.5], km);
      // The box also covers whatever seas other tests committed; at least it contains this one, on the grid.
      expect(box[0]).toBeLessThanOrEqual(w);
      expect(box[1]).toBeLessThanOrEqual(s);
      expect(box[2]).toBeGreaterThanOrEqual(e);
      expect(box[3]).toBeGreaterThanOrEqual(n);
      expect(box.every((v) => Number.isInteger(v / TILE_SIZE))).toBe(true);
    });
  });

  it("throws without seas", async () => {
    await withRollback(async (tx) => {
      await tx.execute(sql`UPDATE geo_objects SET valid_to = current_date WHERE type = 'sea' AND origin = 'marine_regions' AND valid_to IS NULL`);
      await expect(mediterraneanBbox(tx, 5)).rejects.toThrow(/seas missing/);
    });
  });
});
