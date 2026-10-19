import { describe, expect, it } from "vitest";
import { parseArgs } from "../consolidate";

describe("consolidate parseArgs", () => {
  it("takes exactly one scope", () => {
    expect(parseArgs(["--area", "saronic"])).toEqual({ scope: { areaKey: "saronic" } });
    expect(parseArgs(["--tile", "q025:812:508"])).toEqual({ scope: { tileId: "q025:812:508" } });
    expect(parseArgs(["--comparison-set", "saronic"])).toEqual({ scope: { comparisonSetArea: "saronic" } });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["--area", "saronic", "--tile", "q025:812:508"])).toThrow(/usage/);
    expect(() => parseArgs(["--area"])).toThrow(/usage/);
    expect(() => parseArgs(["--place", "x"])).toThrow(/usage/);
  });

  it("an evaluation run needs the candidate rules version, and --rules only goes with --evaluation", () => {
    expect(parseArgs(["--comparison-set", "saronic", "--evaluation", "--rules", "v2"])).toEqual({
      scope: { comparisonSetArea: "saronic" },
      evaluation: true,
      rulesVersion: "v2",
    });
    expect(() => parseArgs(["--comparison-set", "saronic", "--evaluation"])).toThrow(/usage/);
    expect(() => parseArgs(["--area", "saronic", "--rules", "v2"])).toThrow(/usage/);
  });

  it("a repeated flag is refused, not overridden by its last value (bundle J review M-4)", () => {
    expect(() => parseArgs(["--comparison-set", "saronic", "--evaluation", "--rules", "v2", "--rules", "v3"])).toThrow(/usage/);
    expect(() => parseArgs(["--comparison-set", "saronic", "--evaluation", "--evaluation", "--rules", "v2"])).toThrow(/usage/);
    expect(() => parseArgs(["--area", "saronic", "--area", "saronic"])).toThrow(/usage/);
  });
});
