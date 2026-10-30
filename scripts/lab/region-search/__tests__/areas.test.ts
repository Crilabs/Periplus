import { describe, expect, it } from "vitest";
import { QUERY_TEMPLATES, buildQueries, type Area } from "../areas";

const areas: Area[] = [
  { key: "a", names: { en: "Alpha Island", de: "Alpha-Insel", el: "Νήσος Άλφα" } },
  { key: "b", names: { en: "Beta Gulf", de: "Beta-Golf", el: null } },
];

describe("buildQueries", () => {
  it("makes one query per area and template, in the template's language", () => {
    const queries = buildQueries(areas);
    expect(QUERY_TEMPLATES).toHaveLength(8);
    expect(queries).toHaveLength(16);
    expect(queries.filter((q) => q.area === "a" && q.lang === "el").map((q) => q.keyword)).toContain("Νήσος Άλφα αγκυροβόλια");
    expect(queries.filter((q) => q.area === "b" && q.lang === "de").map((q) => q.keyword)).toContain("Beta-Golf Ankerplätze");
  });

  it("falls back to the English name when the template's language has none", () => {
    const el = buildQueries(areas).filter((q) => q.area === "b" && q.lang === "el");
    expect(el.length).toBeGreaterThan(0);
    for (const q of el) expect(q.keyword.startsWith("Beta Gulf ")).toBe(true);
    for (const q of buildQueries(areas)) expect(q.keyword).not.toContain("undefined");
  });

  it("emits each keyword once", () => {
    const same: Area[] = [
      { key: "x", names: { en: "Gamma", de: "Gamma", el: "Gamma" } },
      { key: "y", names: { en: "Gamma", de: "Gamma", el: "Gamma" } },
    ];
    const keywords = buildQueries(same).map((q) => q.keyword);
    expect(new Set(keywords).size).toBe(keywords.length);
  });
});
