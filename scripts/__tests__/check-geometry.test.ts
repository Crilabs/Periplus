import { describe, expect, it } from "vitest";
import { parseArgs } from "../check-geometry";

describe("check-geometry parseArgs", () => {
  it("takes exactly --area <key>", () => {
    expect(parseArgs(["--area", "saronic"])).toEqual({ area: "saronic" });
    for (const argv of [[], ["--area"], ["--area", "--x"], ["saronic"], ["--area", "a", "b"]]) {
      expect(() => parseArgs(argv)).toThrow("usage: check-geometry.ts --area <key>");
    }
  });
});
