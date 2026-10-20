import { describe, expect, it } from "vitest";
import { parseArgs } from "../consolidate";

describe("consolidate parseArgs", () => {
  it("takes exactly one scope", () => {
    expect(parseArgs(["--subdivision", "GR-I"])).toEqual({ scope: { subdivisionKey: "GR-I" } });
    expect(parseArgs(["--tile", "q025:812:508"])).toEqual({ scope: { tileId: "q025:812:508" } });
    expect(parseArgs(["--comparison-set", "GR-I"])).toEqual({ scope: { comparisonSetSubdivision: "GR-I" } });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "GR-I", "--tile", "q025:812:508"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision"])).toThrow(/usage/);
    expect(() => parseArgs(["--place", "x"])).toThrow(/usage/);
  });

  it("an evaluation run needs the candidate rules version, and --rules only goes with --evaluation", () => {
    expect(parseArgs(["--comparison-set", "GR-I", "--evaluation", "--rules", "v2"])).toEqual({
      scope: { comparisonSetSubdivision: "GR-I" },
      evaluation: true,
      rulesVersion: "v2",
    });
    expect(() => parseArgs(["--comparison-set", "GR-I", "--evaluation"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "GR-I", "--rules", "v2"])).toThrow(/usage/);
  });

  it("a repeated flag is refused, not overridden by its last value (bundle J review M-4)", () => {
    expect(() => parseArgs(["--comparison-set", "GR-I", "--evaluation", "--rules", "v2", "--rules", "v3"])).toThrow(/usage/);
    expect(() => parseArgs(["--comparison-set", "GR-I", "--evaluation", "--evaluation", "--rules", "v2"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "GR-I", "--subdivision", "GR-I"])).toThrow(/usage/);
  });
});
