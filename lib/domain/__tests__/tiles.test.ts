import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { testDb } from "@/test/db";
import { parseTileId, tileBbox, tileIdFor, tileNeighbours, tilesInBbox } from "@/lib/domain/tiles";

describe("tileIdFor", () => {
  it("assigns edge coordinates to the east/north tile", () => {
    expect(tileIdFor(23.25, 37.75)).toBe("q025:813:511");
    expect(tileIdFor(23.2499, 37.7499)).toBe("q025:812:510");
    expect(tileIdFor(-0.0001, 0)).toBe("q025:719:360");
    expect(tileIdFor(-180, -90)).toBe("q025:0:0");
  });

  it("rejects out-of-range coordinates", () => {
    expect(() => tileIdFor(180, 0)).toThrow(RangeError);
    expect(() => tileIdFor(-180.0001, 0)).toThrow(RangeError);
    expect(() => tileIdFor(0, 90)).toThrow(RangeError);
    expect(() => tileIdFor(0, -90.0001)).toThrow(RangeError);
    expect(() => tileIdFor(Number.NaN, 0)).toThrow(RangeError);
  });
});

describe("parseTileId / tileBbox", () => {
  it("parses and rejects malformed ids", () => {
    expect(parseTileId("q025:813:510")).toEqual({ col: 813, row: 510 });
    for (const bad of ["", "q025:1", "q05:1:2", "q025:a:2", "q025:-1:2", "q025:1:2:3", "q025:1440:0", "q025:0:720"]) {
      expect(() => parseTileId(bad), bad).toThrow();
    }
  });

  it("computes the bbox", () => {
    expect(tileBbox("q025:813:510")).toEqual([23.25, 37.5, 23.5, 37.75]);
  });

  it("round-trips the bbox south-west corner", () => {
    const [w, s] = tileBbox("q025:813:510");
    expect(tileIdFor(w, s)).toBe("q025:813:510");
  });
});

describe("tileNeighbours", () => {
  it("returns 8 neighbours in N, NE, E, SE, S, SW, W, NW order", () => {
    expect(tileNeighbours("q025:813:510")).toEqual([
      "q025:813:511",
      "q025:814:511",
      "q025:814:510",
      "q025:814:509",
      "q025:813:509",
      "q025:812:509",
      "q025:812:510",
      "q025:812:511",
    ]);
  });

  it("omits missing neighbours at the poles", () => {
    expect(tileNeighbours("q025:813:719")).toHaveLength(5);
    expect(tileNeighbours("q025:813:0")).toHaveLength(5);
  });
});

describe("tilesInBbox", () => {
  it("covers the pilot box with 12 tiles", () => {
    expect(tilesInBbox([23.0, 37.0, 23.75, 38.0])).toHaveLength(12);
  });

  it("excludes the tile east/north of an edge that lies exactly on a boundary", () => {
    expect(tilesInBbox([23.0, 37.0, 23.25, 37.25])).toEqual(["q025:812:508"]);
  });

  it("includes partially covered tiles", () => {
    expect(tilesInBbox([23.1, 37.1, 23.3, 37.3])).toHaveLength(4);
  });

  it("returns the containing tile for a degenerate box", () => {
    expect(tilesInBbox([23.3, 37.3, 23.3, 37.3])).toEqual([tileIdFor(23.3, 37.3)]);
  });
});

describe("SQL parity", () => {
  it("tile_id_for in SQL agrees with tileIdFor on 200 points incl. edges", async () => {
    const db = testDb();
    // mulberry32, fixed seed so failures reproduce
    let a = 0x9e3779b9;
    const rand = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const points: Array<[number, number]> = [
      [-180, -90], [-179.75, -89.75], [-0.25, -0.25], [0, 0], [-0.0001, 0], [23.25, 37.75],
      [23.2499, 37.7499], [179.75, 89.75], [179.9999, 89.9999], [23, 37], [23.75, 38],
    ];
    for (let i = 0; i < 40; i++) points.push([-180 + 0.25 * Math.floor(rand() * 1440), -90 + 0.25 * Math.floor(rand() * 720)]);
    while (points.length < 200) points.push([-180 + rand() * 360, -90 + rand() * 180]);

    for (const [lon, lat] of points) {
      const { rows } = await db.execute<{ id: string }>(
        sql`select tile_id_for(ST_SetSRID(ST_MakePoint(${lon}::float8, ${lat}::float8), 4326)) as id`,
      );
      expect(tileIdFor(lon, lat), `lon=${lon} lat=${lat}`).toBe(rows[0].id);
    }
  });
});
