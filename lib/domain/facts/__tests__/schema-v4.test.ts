import { describe, expect, it } from "vitest";
import { getFactSchema } from "../schema";
import { SECTORS } from "../schema-types";

describe("fact schema v4", () => {
  const v4 = getFactSchema("v4");
  const v3 = getFactSchema("v3");
  const keys = v4.levels.place.map((d) => d.key);

  it("has only the level place filled", () => {
    expect(v4.version).toBe("v4");
    for (const level of ["area", "island", "cape_strait", "poi"] as const) expect(v4.levels[level]).toEqual([]);
  });

  it("holds the berth keys with v3's definitions", () => {
    for (const s of SECTORS) expect(keys).toContain(`shelter.${s}`);
    for (const k of ["prices", "contact", "berthable", "place.kind_evidence", "depth.min", "depth.approach", "mooring.types", "services.fuel"]) {
      expect(keys).toContain(k);
      expect(v4.levels.place.find((d) => d.key === k)).toBe(v3.levels.place.find((d) => d.key === k));
    }
  });

  it("has no highlight, quietness or other out-of-scope keys", () => {
    expect(keys.some((k) => k.startsWith("highlight."))).toBe(false);
    expect(keys).not.toContain("quietness");
    expect(keys).not.toContain("opening_bearing");
    expect(keys.some((k) => k.startsWith("fetch."))).toBe(false);
  });

  it("stays inactive: active.json keeps v3", async () => {
    expect((await import("@/config/fact-schema/active.json")).default).toMatchObject({ version: "v3" });
  });
});
