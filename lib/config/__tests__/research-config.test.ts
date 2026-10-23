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

  it("accepts the shipped config", () => {
    expect(researchSchema.safeParse(valid()).success).toBe(true);
  });
});
