import { describe, expect, it } from "vitest";
import { parseArgs } from "../check-geometry";

describe("check-geometry parseArgs", () => {
  it("takes exactly --subdivision <key>", () => {
    expect(parseArgs(["--subdivision", "GR-I"])).toEqual({ subdivision: "GR-I" });
    for (const argv of [[], ["--subdivision"], ["--subdivision", "--x"], ["GR-I"], ["--subdivision", "a", "b"], ["--area", "saronic"]]) {
      expect(() => parseArgs(argv)).toThrow("usage: check-geometry.ts --subdivision <key>");
    }
  });
});
