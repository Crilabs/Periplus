import { describe, expect, it } from "vitest";
import { areaBbox, parseArgs } from "../import-land-polygons";

describe("import-land-polygons CLI", () => {
  it("parses flags and defaults the version to today", () => {
    const a = parseArgs(["--shp", "x.shp", "--area", "saronic"]);
    expect(a).toMatchObject({ shp: "x.shp", area: "saronic" });
    expect(a.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parseArgs(["--shp", "x", "--area", "a", "--version", "2026-01-02"]).version).toBe("2026-01-02");
  });

  it("rejects missing, unknown or malformed arguments", () => {
    expect(() => parseArgs(["--area", "a"])).toThrow(/usage/);
    expect(() => parseArgs(["--shp", "x", "--area", "a", "--foo", "1"])).toThrow(/usage/);
    expect(() => parseArgs(["--shp", "x", "--area", "a", "--version", "today"])).toThrow(/YYYY-MM-DD/);
  });

  it("unions the polygon box with the tile box", () => {
    const polygon: GeoJSON.Polygon = {
      type: "Polygon",
      coordinates: [[[1, 2], [3, 2], [3, 4], [1, 4], [1, 2]]],
    };
    expect(areaBbox({ polygon, tileBbox: null })).toEqual([1, 2, 3, 4]);
    expect(areaBbox({ polygon, tileBbox: [0, 3, 2, 5] })).toEqual([0, 2, 3, 5]);
  });
});
