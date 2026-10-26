import { describe, expect, it } from "vitest";
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
