import { describe, expect, it } from "vitest";
import { parseArgs } from "../compare-navily";

const TODAY = new Date("2026-10-19T08:00:00Z");

describe("compare-navily parseArgs", () => {
  it("reads area, path and output", () => {
    expect(parseArgs(["--area", "saronic", "--navily", "/tmp/s.json", "--out", "x.md"], {}, TODAY)).toEqual({
      area: "saronic",
      navily: "/tmp/s.json",
      out: "x.md",
      acceptProposals: false,
      coverage: false,
    });
  });

  it("takes the path from NAVILY_SPOTS_PATH and defaults the output to the dated pilot report", () => {
    expect(parseArgs(["--area", "saronic"], { NAVILY_SPOTS_PATH: "/tmp/env.json" }, TODAY)).toEqual({
      area: "saronic",
      navily: "/tmp/env.json",
      out: "docs/pilot/2026-10-19-m2-stichprobe.md",
      acceptProposals: false,
      coverage: false,
    });
  });

  it("the flag beats the environment", () => {
    expect(parseArgs(["--area", "a", "--navily", "/flag.json"], { NAVILY_SPOTS_PATH: "/env.json" }, TODAY).navily).toBe("/flag.json");
  });

  it("--accept-proposals is a flag without a value, anywhere in the arguments", () => {
    expect(parseArgs(["--accept-proposals", "--area", "saronic"], { NAVILY_SPOTS_PATH: "/x" }, TODAY).acceptProposals).toBe(true);
    expect(parseArgs(["--area", "saronic", "--accept-proposals", "--out", "y.md"], { NAVILY_SPOTS_PATH: "/x" }, TODAY)).toEqual({
      area: "saronic",
      navily: "/x",
      out: "y.md",
      acceptProposals: true,
      coverage: false,
    });
    expect(() => parseArgs(["--area", "a", "--accept-proposals", "--accept-proposals"], { NAVILY_SPOTS_PATH: "/x" }, TODAY)).toThrow(/usage/);
  });

  it("--coverage is a flag without a value, given once", () => {
    expect(parseArgs(["--area", "saronic", "--coverage"], { NAVILY_SPOTS_PATH: "/x" }, TODAY)).toMatchObject({ coverage: true, acceptProposals: false });
    expect(parseArgs(["--coverage", "--accept-proposals", "--area", "a"], { NAVILY_SPOTS_PATH: "/x" }, TODAY)).toMatchObject({ coverage: true, acceptProposals: true });
    expect(parseArgs(["--area", "a"], { NAVILY_SPOTS_PATH: "/x" }, TODAY).coverage).toBe(false);
    expect(() => parseArgs(["--area", "a", "--coverage", "--coverage"], { NAVILY_SPOTS_PATH: "/x" }, TODAY)).toThrow(/usage/);
  });

  it("aborts without a Navily path, without an area or on unknown flags", () => {
    expect(() => parseArgs(["--area", "saronic"], {}, TODAY)).toThrow(/NAVILY_SPOTS_PATH/);
    expect(() => parseArgs(["--navily", "/x.json"], {}, TODAY)).toThrow(/usage/);
    expect(() => parseArgs(["--area", "a", "--bogus", "b"], { NAVILY_SPOTS_PATH: "/x" }, TODAY)).toThrow(/usage/);
    expect(() => parseArgs(["--area"], { NAVILY_SPOTS_PATH: "/x" }, TODAY)).toThrow(/usage/);
  });
});
