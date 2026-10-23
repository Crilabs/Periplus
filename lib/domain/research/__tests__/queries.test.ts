import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { buildResearchQueries, type CandidateNames } from "../queries";

const cfg = getConfig().research;
const base: CandidateNames = { names: { en: "Vathi", el: "Βαθύ" }, island: { en: "Methana" }, countryCode: "GR", tileId: "q025:1:2" };

describe("buildResearchQueries", () => {
  it("fills {name} and {island} per template language and sets level, scope, location and tile", () => {
    const qs = buildResearchQueries("p1", base, cfg, "positive");
    expect(qs).toContainEqual(expect.objectContaining({ keyword: "Vathi Methana anchorage", languageCode: "en", locationCode: 2826, level: "research", scopeId: "p1", tileId: "q025:1:2" }));
    expect(qs).toContainEqual(expect.objectContaining({ keyword: "Βαθύ αγκυροβόλιο", languageCode: "el", locationCode: 2300 }));
    expect(qs.find((q) => q.keyword === "Vathi Methana anchorage")!.priority).toBe(1);
  });

  it("makes no query with {island} without an island", () => {
    const qs = buildResearchQueries("p1", { ...base, island: null }, cfg, "positive");
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.some((q) => q.keyword.includes("Methana"))).toBe(false);
    expect(qs.some((q) => q.keyword.includes("{"))).toBe(false);
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
      expect.arrayContaining(["Vathi anchoring prohibited", "Vathi Ankerverbot", "Vathi divieto di ancoraggio", "Vathi interdiction de mouillage"]),
    );
  });

  it("negative uses only the negative templates", () => {
    const qs = buildResearchQueries("p1", base, cfg, "negative");
    expect(qs.map((q) => q.keyword).sort()).toEqual(["Vathi anchoring prohibited", "Βαθύ απαγόρευση αγκυροβολίας"].sort());
  });
});
