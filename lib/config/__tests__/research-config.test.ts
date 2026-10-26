import { describe, expect, it } from "vitest";
import { getConfig } from "../index";
import { isForbiddenUrl } from "@/lib/domain/sources/forbidden-domains";
import { researchSchema } from "../schemas";

const valid = () => structuredClone(getConfig().research);

describe("research config", () => {
  it("loads with start values", () => {
    const c = getConfig().research;
    expect(c.templates.positive.length).toBeGreaterThan(0);
    expect(c.skipDomains).toContain("navily.com");
    expect(c.source).toEqual({ weight: 0.5, ratePerMinute: 20 });
  });

  it("rejects a template without {name}", () => {
    const c = valid();
    c.templates.positive.push({ template: "anchorage", lang: "en" });
    expect(researchSchema.safeParse(c).success).toBe(false);
  });

  it("rejects a language without a locationCodes entry", () => {
    const c = valid();
    c.templates.negative.push({ template: "{name} ankerverbot", lang: "nl" });
    expect(researchSchema.safeParse(c).success).toBe(false);
    const d = valid();
    d.languagesByCountry.default!.push("nl");
    expect(researchSchema.safeParse(d).success).toBe(false);
  });

  it("loads the state start values and rejects an unknown always category", () => {
    const c = getConfig().research;
    expect(c.state).toEqual({
      landingRadiusM: 600,
      shoreMaxM: 1000,
      footMaxM: 1500,
      detourFactor: 1.4,
      transportMaxM: 15000,
      transportCategories: ["culture", "town", "nature", "beach"],
      transportMinSitelinks: 5,
      alwaysCategories: ["food", "supply", "bakery", "beach", "transport"],
      textConfidence: 0.8,
      transportKeywords: ["bus", "taxi", "ferry", "bahn", "fähre", "λεωφορείο", "ταξί", "φέρι", "πλοίο"],
    });
    const bad = valid();
    bad.state.alwaysCategories.push("bogus" as never);
    expect(researchSchema.safeParse(bad).success).toBe(false);
    const neg = valid();
    neg.state.footMaxM = -1;
    expect(researchSchema.safeParse(neg).success).toBe(false);
  });

  it("loads extraction, confirmation and discovery start values", () => {
    const c = getConfig().research;
    expect(c.extraction).toEqual({ factSchema: "v4", placeRadiusKm: 15, maxUnitWords: 12000, windowWords: 600, maxSharedWords: 8, routeMaxStops: 40, maxAttempts: 3, markdownReadConcurrency: 8 });
    expect(c.confirmation.minIndependentSources).toBe(2);
    expect(c.confirmation.minSignalConfidence).toBe(0.7);
    expect(c.confirmation.positiveKinds).toEqual(["anchored", "moored_buoy", "berthed", "listed_as_berth"]);
    expect(c.discovery).toEqual({ corridorBufferKm: 3, minNameSimilarity: 0.8, vetoSimilarity: 0.4, maxLegKm: 25, maxLegDays: 3, corroboratingDomains: 2 });
  });

  it("loads the gate and rejects a released gate without a chosen threshold among the thresholds", () => {
    const c = getConfig().research;
    expect(c.gate).toEqual({ subdivision: "GR-I", thresholds: [2, 3, 4, 5], released: false, chosenThreshold: null, maxPositionDeviationM: 150, shelterErrorMin: 0.7, minConfirmed: 25, minCoverage: 0.5 });
    for (const minCoverage of [-0.1, 1.5]) expect(researchSchema.safeParse({ ...c, gate: { ...c.gate, minCoverage } }).success, String(minCoverage)).toBe(false);
    for (const minConfirmed of [0, 1.5]) expect(researchSchema.safeParse({ ...c, gate: { ...c.gate, minConfirmed } }).success, String(minConfirmed)).toBe(false);
    for (const chosenThreshold of [null, 9]) {
      expect(researchSchema.safeParse({ ...c, gate: { ...c.gate, released: true, chosenThreshold } }).success).toBe(false);
    }
    expect(researchSchema.safeParse({ ...c, gate: { ...c.gate, released: true, chosenThreshold: 2 } }).success).toBe(true);
  });

  it("a released gate must deliver with its chosen threshold: confirmation.minIndependentSources equals it", () => {
    const c = getConfig().research;
    const released = { ...c, gate: { ...c.gate, released: true, chosenThreshold: 3 } };
    expect(researchSchema.safeParse({ ...released, confirmation: { ...c.confirmation, minIndependentSources: 2 } }).success).toBe(false);
    expect(researchSchema.safeParse({ ...released, confirmation: { ...c.confirmation, minIndependentSources: 3 } }).success).toBe(true);
    expect(researchSchema.safeParse({ ...c, gate: { ...c.gate, released: false, chosenThreshold: 3 } }).success).toBe(true);
  });

  it("rejects gate thresholds that are not strictly ascending (the report's chosen threshold is the first match)", () => {
    const c = getConfig().research;
    for (const thresholds of [[3, 2, 4], [2, 2, 3]]) expect(researchSchema.safeParse({ ...c, gate: { ...c.gate, thresholds } }).success, thresholds.join()).toBe(false);
    expect(researchSchema.safeParse({ ...c, gate: { ...c.gate, thresholds: [2, 5] } }).success).toBe(true);
  });

  it("rejects a kind that is both positive and negative", () => {
    const c = valid();
    c.confirmation.negativeKinds.push("anchored");
    expect(researchSchema.safeParse(c).success).toBe(false);
  });

  it("rejects a harbour-ignored kind that is not a negative kind", () => {
    const c = valid();
    expect(c.confirmation.harbourIgnoredNegativeKinds).toEqual(["no_space"]);
    c.confirmation.harbourIgnoredNegativeKinds.push("anchored");
    expect(researchSchema.safeParse(c).success).toBe(false);
  });

  it("rejects an unknown fact schema version", () => {
    const c = valid();
    c.extraction.factSchema = "v99";
    expect(researchSchema.safeParse(c).success).toBe(false);
  });

  it("skips aggregator and stock-photo domains, TripAdvisor on every country domain (N1 probe)", () => {
    const { skipDomains } = getConfig().research;
    for (const url of ["https://www.tripadvisor.com/x", "https://www.tripadvisor.de/x", "https://www.tripadvisor.co.uk/x", "https://www.tripadvisor.com.au/x", "https://www.tripadvisor.gr/x", "https://www.getyourguide.com/x", "https://www.rome2rio.com/x", "https://www.alamy.com/x"]) {
      expect(isForbiddenUrl(url, skipDomains), url).toBe(true);
    }
    expect(isForbiddenUrl("https://www.sailing-blog.example/tripadvisor", skipDomains)).toBe(false);
  });

  it("has search templates aimed at trip reports (N1 probe)", () => {
    const templates = getConfig().research.templates.positive;
    expect(templates).toEqual(
      expect.arrayContaining([
        { template: "{name} sailing blog", lang: "en" },
        { template: "{name} anchored overnight", lang: "en" },
        { template: "{name} {island} Törnbericht", lang: "de" },
        { template: "{name} vela ancoraggio", lang: "it" },
      ]),
    );
  });

  it("rejects a template with only {island} (it would find pages that name no berth)", () => {
    const c = valid();
    c.templates.positive.push({ template: "Törn {island}", lang: "de" });
    expect(researchSchema.safeParse(c).success).toBe(false);
  });

  it("has no shipped template without {name}, and a copy threshold of 12 words", () => {
    const c = getConfig().research;
    for (const t of [...c.templates.positive, ...c.templates.negative]) expect(t.template).toContain("{name}");
    expect(c.confirmation.copyMinSharedWords).toBe(12);
  });

  it("accepts the shipped config", () => {
    expect(researchSchema.safeParse(valid()).success).toBe(true);
  });

  it("loads the landside start values and rejects a template without {subject} or an unknown language", () => {
    const c = getConfig().research;
    expect(c.landside.maxSubjectsPerPlace).toBe(5);
    expect(c.landside.maxHitsPerSubject).toBe(10);
    expect(c.landside.settlementMaxM).toBe(10000);
    expect(c.landside.boatKeywords).toEqual(expect.arrayContaining(["anchored", "Anker", "buoy"]));
    const noWords = valid();
    noWords.landside.boatKeywords = [];
    expect(researchSchema.safeParse(noWords).success).toBe(false);
    expect(c.landside.templates.map((t) => t.template)).toEqual([
      "{subject} things to do",
      "{subject} taverna",
      "{subject} beach",
      "{subject} Sehenswürdigkeiten",
      "{subject} cosa vedere",
    ]);
    const bad = valid();
    bad.landside.templates.push({ template: "things to do", lang: "en" });
    expect(researchSchema.safeParse(bad).success).toBe(false);
    const lang = valid();
    lang.landside.templates.push({ template: "{subject} x", lang: "nl" });
    expect(researchSchema.safeParse(lang).success).toBe(false);
  });
});
