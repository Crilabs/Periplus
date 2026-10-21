import { describe, expect, it } from "vitest";
import { getConsolidationConfig } from "@/lib/config";
import { importanceOf, poiKinds, type ImportanceInput } from "../importance";

const cfg = getConsolidationConfig();
const base: ImportanceInput = { sources: [{ key: "source:a", weight: 0.9 }], sitelinks: null, category: "culture", kinds: [] };
const scoreWith = (kinds: string[], c = cfg) => importanceOf({ ...base, kinds }, c).score;

describe("importanceOf with kinds (spec 16)", () => {
  it("castle tag adds its bonus", () => {
    expect(cfg.importance.tagBonus?.["historic=castle"]).toBe(2);
    // 0.9 + culture 0.5 + castle 2
    expect(importanceOf({ ...base, kinds: ["historic=castle"] }, cfg)).toEqual({ importance: 3, score: 3.4, radiusNm: 20 });
    expect(scoreWith([])).toBe(1.4);
  });

  it("the largest bonus of several kinds counts once", () => {
    expect(scoreWith(["tourism=viewpoint", "historic=castle", "historic=ruins", "amenity=restaurant"])).toBe(3.4);
    expect(scoreWith(["historic=ruins", "tourism=viewpoint"])).toBe(2.4);
  });

  it("wikidata class bonus applies", () => {
    expect(scoreWith(["wikidata:Q839954"])).toBe(3.4);
    expect(scoreWith(["wikidata:Q1"])).toBe(1.4);
  });

  it("a version without tagBonus adds nothing", () => {
    const { tagBonus: _drop, ...importance } = cfg.importance;
    void _drop;
    expect(scoreWith(["historic=castle"], { ...cfg, importance })).toBe(1.4);
  });
});

describe("poiKinds", () => {
  it("lists the kind tags and the wikidata class, a value list split", () => {
    expect(
      poiKinds({ historic: "castle", tourism: "attraction;museum", name: "Kastro", amenity: "", natural: 3, wikidata_class: "Q839954" }),
    ).toEqual(["historic=castle", "tourism=attraction", "tourism=museum", "wikidata:Q839954"]);
    expect(poiKinds({})).toEqual([]);
  });
});
