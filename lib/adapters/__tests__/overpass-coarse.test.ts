import { describe, expect, it } from "vitest";
import { buildCoarseFeatureQueries } from "@/lib/adapters/overpass";
import { loadConfig } from "@/lib/config";

const { coarse } = loadConfig().gazetteer;

describe("buildCoarseFeatureQueries", () => {
  it("one query per kind and block inside the country area and the block's box (B15)", () => {
    const parts = buildCoarseFeatureQueries("MT", coarse, 180, [[14, 35, 15, 36], [15, 35, 16, 36]]);
    expect(parts.map((p) => p.part)).toEqual(["islands#0", "islands#1", "bays#0", "bays#1", "towns#0", "towns#1"]);
    for (const { ql } of parts) {
      expect(ql.startsWith("[out:json][timeout:180];")).toBe(true);
      expect(ql).toContain('area["ISO3166-1"="MT"][admin_level=2]->.c;');
      expect(ql.trimEnd().endsWith("out geom;")).toBe(true);
    }
    expect(parts[1]!.ql).toContain('way[place~"^(island|archipelago)$"](area.c)(35,15,36,16);');
    expect(parts[1]!.ql).toContain('relation[place~"^(island|archipelago)$"](area.c)(35,15,36,16);');
    expect(parts[1]!.ql).not.toContain("natural=bay");
    expect(parts[2]!.ql).toContain("way[natural=bay][name](area.c)(35,14,36,15);");
    expect(parts[2]!.ql).toContain("relation[natural=bay][name](area.c)(35,14,36,15);");
    expect(parts[4]!.ql).toContain('node[place~"^(city|town)$"](area.c)(35,14,36,15);');
    expect(parts[4]!.ql).not.toContain("island");
  });

  it("takes the town place values from the configuration", () => {
    const parts = buildCoarseFeatureQueries("GR", { ...coarse, placeTypes: ["city"] }, 60, [[20, 36, 22, 38]]);
    expect(parts.find((p) => p.part === "towns#0")!.ql).toContain('node[place~"^(city)$"](area.c)(36,20,38,22);');
  });
});
