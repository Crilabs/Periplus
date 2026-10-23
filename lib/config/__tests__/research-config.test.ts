import { describe, expect, it } from "vitest";
import { getConfig } from "../index";
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

  it("loads extraction, confirmation and discovery start values", () => {
    const c = getConfig().research;
    expect(c.extraction).toEqual({ factSchema: "v4", placeRadiusKm: 15, maxUnitWords: 12000, windowWords: 600, maxSharedWords: 8, routeMaxStops: 40 });
    expect(c.confirmation.minIndependentSources).toBe(2);
    expect(c.confirmation.minSignalConfidence).toBe(0.7);
    expect(c.confirmation.positiveKinds).toEqual(["anchored", "moored_buoy", "berthed", "listed_as_berth"]);
    expect(c.discovery).toEqual({ corridorBufferKm: 3, minNameSimilarity: 0.8, vetoSimilarity: 0.4, maxLegKm: 25, maxLegDays: 3, corroboratingDomains: 2 });
  });

  it("rejects a kind that is both positive and negative", () => {
    const c = valid();
    c.confirmation.negativeKinds.push("anchored");
    expect(researchSchema.safeParse(c).success).toBe(false);
  });

  it("rejects an unknown fact schema version", () => {
    const c = valid();
    c.extraction.factSchema = "v99";
    expect(researchSchema.safeParse(c).success).toBe(false);
  });

  it("accepts the shipped config", () => {
    expect(researchSchema.safeParse(valid()).success).toBe(true);
  });
});
