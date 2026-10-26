import { describe, expect, it } from "vitest";
import { buildCoarseKindQuery, COARSE_KINDS } from "@/lib/adapters/overpass";
import { loadConfig } from "@/lib/config";

const { coarse } = loadConfig().gazetteer;

describe("buildCoarseKindQuery", () => {
  it("one query per kind inside the country area (B15)", () => {
    expect(COARSE_KINDS).toEqual(["islands", "bays", "towns"]);
    for (const kind of COARSE_KINDS) {
      const ql = buildCoarseKindQuery("MT", coarse, kind, 180);
      expect(ql.startsWith("[out:json][timeout:180];")).toBe(true);
      expect(ql).toContain('area["ISO3166-1"="MT"][admin_level=2]->.c;');
      expect(ql.trimEnd().endsWith("out geom;")).toBe(true);
    }
    const islands = buildCoarseKindQuery("MT", coarse, "islands", 180);
    expect(islands).toContain('way[place~"^(island|archipelago)$"](area.c);');
    expect(islands).toContain('relation[place~"^(island|archipelago)$"](area.c);');
    expect(islands).not.toContain("natural=bay");
    expect(buildCoarseKindQuery("MT", coarse, "bays", 180)).toContain("relation[natural=bay][name](area.c);");
    const towns = buildCoarseKindQuery("MT", coarse, "towns", 180);
    expect(towns).toContain('node[place~"^(city|town)$"](area.c);');
    expect(towns).not.toContain("island");
  });

  it("limits a block to its box (south, west, north, east)", () => {
    const ql = buildCoarseKindQuery("MT", coarse, "bays", 180, [14, 35, 15, 36]);
    expect(ql).toContain("way[natural=bay][name](area.c)(35,14,36,15);");
    expect(ql).toContain("relation[natural=bay][name](area.c)(35,14,36,15);");
  });

  it("takes the town place values from the configuration", () => {
    expect(buildCoarseKindQuery("GR", { ...coarse, placeTypes: ["city"] }, "towns", 60)).toContain('node[place~"^(city)$"](area.c);');
  });
});
