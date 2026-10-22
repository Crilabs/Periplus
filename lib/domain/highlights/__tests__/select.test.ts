import { describe, expect, it } from "vitest";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import { highlightsConfig, selectHighlights, type HighlightCandidate } from "../select";

const cfg = {
  maxPerCategory: 5,
  reachKm: [1, 1, 5, 20, 20],
  levelWeights: [0.005, 0.2, 1, 3, 6],
  levelThresholds: [1, 6],
  textNameImportance: 2,
};

function cand(id: string, importance: 1 | 2 | 3 | 4 | 5, distanceKm: number, extra: Partial<HighlightCandidate> = {}): HighlightCandidate {
  return { geoObjectId: id, category: "culture", name: null, nameNormalized: null, importance, score: 0, distanceKm, lon: 25, lat: 36, ...extra };
}

describe("selectHighlights", () => {
  it("island with one ruin", () => {
    const r = selectHighlights([cand("ruin", 2, 0.8)], [], cfg, 500);
    expect(r).toMatchObject({ culture: { ids: ["ruin"], level: "none" } });
  });

  it("city with 300 culture candidates", () => {
    const list = [
      cand("big", 5, 8),
      ...Array.from({ length: 10 }, (_, i) => cand(`m${i}`, 3, 4)),
      ...Array.from({ length: 289 }, (_, i) => cand(`s${i}`, 1, 0.9)),
    ];
    const c = selectHighlights(list, [], cfg, 500).culture!;
    expect(c.ids).toHaveLength(5);
    expect(c.ids[0]).toBe("big");
    expect(c.level).toBe("many");
  });

  it("1000 importance-1 candidates alone are not many", () => {
    const list = Array.from({ length: 1000 }, (_, i) => cand(`s${i}`, 1, 0.5));
    expect(selectHighlights(list, [], cfg, 500).culture!.level).toBe("some");
  });

  it("ten importance-4 candidates are many", () => {
    const list = Array.from({ length: 10 }, (_, i) => cand(`m${i}`, 4, 10));
    const c = selectHighlights(list, [], cfg, 500).culture!;
    expect(c.ids).toHaveLength(5);
    expect(c.level).toBe("many");
  });

  it("filters by reach per importance", () => {
    const c = selectHighlights([cand("far5", 5, 15), cand("far2", 2, 3)], [], cfg, 500).culture!;
    expect(c.ids).toEqual(["far5"]);
    expect(c.candidates.map((x) => x.geoObjectId)).toEqual(["far5"]);
  });

  it("ties: score desc, then nearer, then smaller id", () => {
    const list = [
      cand("d", 3, 2, { score: 1 }),
      cand("c", 3, 1, { score: 1 }),
      cand("b", 3, 1, { score: 1 }),
      cand("a", 3, 3, { score: 0.5 }),
      cand("e", 3, 1, { score: 2 }),
    ];
    expect(selectHighlights(list, [], cfg, 500).culture!.ids).toEqual(["e", "b", "c", "d", "a"]);
  });

  it("collapses duplicates by name, category and distance", () => {
    const list = [
      cand("hi", 3, 1, { nameNormalized: "kastro", lon: 25, lat: 36 }),
      cand("lo", 2, 1, { nameNormalized: "kastro", lon: 25.0033, lat: 36 }),
    ];
    const c = selectHighlights(list, [], cfg, 500).culture!;
    expect(c.ids).toEqual(["hi"]);
    expect(c.candidates.map((x) => x.geoObjectId)).toEqual(["hi"]);
  });

  it("does not collapse far apart or different-category namesakes", () => {
    const list = [
      cand("a", 3, 1, { nameNormalized: "kastro" }),
      cand("b", 3, 1, { nameNormalized: "kastro", lon: 25.1 }),
      cand("c", 3, 1, { nameNormalized: "kastro", category: "food" }),
    ];
    const r = selectHighlights(list, [], cfg, 500);
    expect(r.culture!.ids).toEqual(["a", "b"]);
    expect(r.food!.ids).toEqual(["c"]);
  });

  it("text names count once with the text name importance", () => {
    const r = selectHighlights([], [
      { category: "food", nameNormalized: "taverna x" },
      { category: "food", nameNormalized: "taverna x" },
    ], cfg, 500);
    expect(r).toEqual({ food: { ids: [], level: "none", candidates: [], textNames: ["taverna x"] } });
  });

  it("empty", () => {
    expect(selectHighlights([], [], cfg, 500)).toEqual({});
  });
});

describe("highlightsConfig", () => {
  it("throws without highlights", () => {
    expect(() => highlightsConfig({ version: "v1" } as unknown as ConsolidationConfig)).toThrow(/has no highlights configuration/);
  });
});
