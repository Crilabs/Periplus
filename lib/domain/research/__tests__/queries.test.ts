import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { buildResearchQueries, type CandidateNames } from "../queries";

const cfg = getConfig().research;
const base: CandidateNames = {
  names: { en: "Vathi", el: "Βαθύ" },
  island: { en: "Methana" },
  areas: [{ en: "Saronic Gulf", el: "Σαρωνικός Κόλπος" }, { en: "Argo-Saronic Gulf" }],
  country: { en: "Greece", el: "Ελλάδα" },
  countryCode: "GR",
  tileId: "q025:1:2",
};
const priorityOf = (template: string) => cfg.templates.positive.findIndex((t) => t.template === template);

describe("buildResearchQueries", () => {
  it("fills {name} and {island} per template language and sets level, scope, location and tile", () => {
    const qs = buildResearchQueries("p1", base, cfg, "positive");
    expect(qs).toContainEqual(expect.objectContaining({ keyword: "Vathi Methana anchorage", languageCode: "en", locationCode: 2826, level: "research", scopeId: "p1", tileId: "q025:1:2" }));
    expect(qs.find((q) => q.keyword === "Vathi Methana anchorage")!.priority).toBe(priorityOf("{name} {island} anchorage"));
  });

  it("fills {area} once per sailing area, with the English name where the language has none (B34)", () => {
    const keywords = buildResearchQueries("p1", base, cfg, "positive").map((q) => q.keyword);
    expect(keywords).toEqual(expect.arrayContaining(["Vathi Saronic Gulf anchorage", "Vathi Argo-Saronic Gulf anchorage"]));
    expect(keywords).toEqual(expect.arrayContaining(["Βαθύ Σαρωνικός Κόλπος αγκυροβόλιο", "Βαθύ Argo-Saronic Gulf αγκυροβόλιο"]));
  });

  it("fills {country} with the country's name in the template language (B34)", () => {
    const qs = buildResearchQueries("p1", base, cfg, "positive");
    expect(qs).toContainEqual(expect.objectContaining({ keyword: "Vathi Greece anchorage", languageCode: "en" }));
    expect(qs).toContainEqual(expect.objectContaining({ keyword: "Βαθύ Ελλάδα αγκυροβόλιο", languageCode: "el" }));
  });

  it("has no template without a location: every one needs {island}, {area} or {country} (B34)", () => {
    for (const t of [...cfg.templates.positive, ...cfg.templates.negative]) {
      expect(t.template, t.template).toMatch(/\{(island|area|country)\}/);
    }
  });

  it("makes no query with a location the candidate lacks", () => {
    const qs = buildResearchQueries("p1", { ...base, island: null, areas: [] }, cfg, "positive");
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.every((q) => q.keyword.includes("Greece") || q.keyword.includes("Ελλάδα"))).toBe(true);
    expect(qs.some((q) => q.keyword.includes("{"))).toBe(false);
    expect(buildResearchQueries("p1", { ...base, island: null, areas: [], country: null }, cfg, "positive")).toEqual([]);
  });

  it("makes no el query for a country without el", () => {
    const qs = buildResearchQueries("p1", { ...base, countryCode: "XX" }, cfg, "positive");
    expect(qs.some((q) => q.languageCode === "el")).toBe(false);
    expect(qs.some((q) => q.languageCode === "en")).toBe(true);
  });

  it("makes no query without names", () => {
    expect(buildResearchQueries("p1", { ...base, names: {} }, cfg, "positive")).toEqual([]);
  });

  it("does not repeat a search key when two languages share a name", () => {
    const qs = buildResearchQueries("p1", { ...base, names: { en: "Vathi", de: "Vathi" }, island: null }, cfg, "positive");
    const keys = qs.map((q) => `${q.keyword}|${q.languageCode}|${q.locationCode}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has a negative query in every language of the positive templates, it and fr included", () => {
    const qs = buildResearchQueries("p1", { ...base, names: { en: "Vathi", de: "Vathi", it: "Vathi", fr: "Vathi", el: "Βαθύ" }, countryCode: "GR" }, cfg, "negative");
    expect(qs.map((q) => q.keyword)).toEqual(
      expect.arrayContaining(["Vathi Greece anchoring prohibited", "Vathi Greece Ankerverbot", "Vathi Greece divieto di ancoraggio", "Vathi Greece interdiction de mouillage"]),
    );
  });

  it("negative uses only the negative templates", () => {
    const qs = buildResearchQueries("p1", base, cfg, "negative");
    expect(qs.map((q) => q.keyword).sort()).toEqual(["Vathi Greece anchoring prohibited", "Βαθύ Ελλάδα απαγόρευση αγκυροβολίας"].sort());
  });
});
