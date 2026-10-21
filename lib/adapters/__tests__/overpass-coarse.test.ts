import { describe, expect, it } from "vitest";
import { buildCoarseFeatureQuery } from "@/lib/adapters/overpass";
import { loadConfig } from "@/lib/config";

const { coarse } = loadConfig().gazetteer;

describe("buildCoarseFeatureQuery", () => {
  it("asks for islands, archipelagos, named bays and towns inside the country area", () => {
    const ql = buildCoarseFeatureQuery("MT", coarse, 180);
    expect(ql.startsWith("[out:json][timeout:180];")).toBe(true);
    expect(ql).toContain('area["ISO3166-1"="MT"][admin_level=2]->.c;');
    expect(ql).toContain('way[place~"^(island|archipelago)$"](area.c);');
    expect(ql).toContain('relation[place~"^(island|archipelago)$"](area.c);');
    expect(ql).toContain("natural=bay");
    expect(ql).toContain('node[place~"^(city|town)$"](area.c);');
    expect(ql.trimEnd().endsWith("out geom;")).toBe(true);
  });

  it("takes the town place values from the configuration", () => {
    expect(buildCoarseFeatureQuery("GR", { ...coarse, placeTypes: ["city"] }, 60)).toContain('node[place~"^(city)$"](area.c);');
  });
});
