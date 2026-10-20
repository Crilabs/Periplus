import { describe, expect, it } from "vitest";
import type { SubdivisionsConfig } from "@/lib/config";
import { planSubdivisions, planWarnings, type AdminUnit } from "../plan";

const season = { fromMonth: 4, toMonth: 10 };
const lang = ["en"];

function config(over: Partial<SubdivisionsConfig> & { countries: SubdivisionsConfig["countries"] }): SubdivisionsConfig {
  return {
    mediterranean: { marineRegionsMrgids: [1] },
    split: [],
    wholeCountry: [],
    extra: [],
    merge: [],
    notMediterranean: [],
    keyOverrides: {},
    overrides: {},
    retiredAreaKeys: {},
    ...over,
  };
}

let seq = 0;
function unit(country: string, adminLevel: number, over: Partial<AdminUnit> = {}): AdminUnit {
  seq++;
  return {
    geoObjectId: `g${seq}`,
    country,
    adminLevel,
    iso: null,
    osmRelationId: 1000 + seq,
    wikidataId: null,
    touchesMediterranean: true,
    ...over,
  };
}

const gr = { firstLevel: 5, secondLevel: 6, sourceLanguages: lang, season, cycleDays: 30 };
const lvl4 = { firstLevel: 4, sourceLanguages: lang, season, cycleDays: 30 } as const;
const whole = { firstLevel: "whole", sourceLanguages: lang, season, cycleDays: 30 } as const;

describe("planSubdivisions", () => {
  it("excluded country yields one excluded row", () => {
    const cfg = config({ countries: { LY: { ...lvl4, status: "excluded", statusReason: "Bürgerkrieg" } } });
    const country = unit("LY", 2);
    const plan = planSubdivisions([country, unit("LY", 4, { iso: "LY-TB" }), unit("LY", 4, { iso: "LY-MB" })], cfg);
    expect(plan).toEqual([
      expect.objectContaining({ key: "LY", country: "LY", geoObjectId: country.geoObjectId, status: "excluded", statusReason: "Bürgerkrieg" }),
    ]);
  });

  it("whole country yields the country", () => {
    const cfg = config({ countries: { MT: whole, LB: lvl4 }, wholeCountry: ["LB"] });
    const mt = unit("MT", 2);
    const lb = unit("LB", 2);
    const plan = planSubdivisions([mt, lb, unit("LB", 4, { iso: "LB-AS" })], cfg);
    expect(plan.map((p) => [p.key, p.geoObjectId, p.status])).toEqual([
      ["LB", lb.geoObjectId, "active"],
      ["MT", mt.geoObjectId, "active"],
    ]);
    expect(plan[0]!.memberGeoObjectIds).toEqual([lb.geoObjectId]);
  });

  it("first-level units that touch the Mediterranean become subdivisions, others do not", () => {
    const cfg = config({ countries: { HR: lvl4 } });
    const a = unit("HR", 4, { iso: "HR-17" });
    const b = unit("HR", 4, { iso: "HR-21", touchesMediterranean: false });
    const c = unit("HR", 6, { iso: "HR-XX" });
    const plan = planSubdivisions([unit("HR", 2), a, b, c], cfg);
    expect(plan.map((p) => p.key)).toEqual(["HR-17"]);
    expect(plan[0]).toMatchObject({ geoObjectId: a.geoObjectId, memberGeoObjectIds: [a.geoObjectId], statusReason: null, names: {} });
  });

  it("split replaces GR-L by GR-CYC and GR-DOD", () => {
    const cfg = config({
      countries: { GR: gr },
      split: [
        {
          parentKey: "GR-L",
          groups: [
            { key: "GR-CYC", names: { en: "Cyclades" }, memberWikidataIds: ["Q1", "Q2"] },
            { key: "GR-DOD", names: { en: "Dodecanese" }, memberWikidataIds: ["Q3", "Q9"] },
          ],
        },
      ],
    });
    const parent = unit("GR", 5, { iso: "GR-L" });
    const other = unit("GR", 5, { iso: "GR-A" });
    const members = ["Q1", "Q2", "Q3"].map((q) => unit("GR", 6, { wikidataId: q }));
    const plan = planSubdivisions([parent, other, ...members], cfg);
    expect(plan.map((p) => p.key)).toEqual(["GR-A", "GR-CYC", "GR-DOD"]);
    const cyc = plan.find((p) => p.key === "GR-CYC")!;
    expect(cyc.geoObjectId).toBeNull();
    expect(cyc.memberGeoObjectIds).toEqual([members[0]!.geoObjectId, members[1]!.geoObjectId]);
    expect(cyc.names).toEqual({ en: "Cyclades" });
    expect(plan.find((p) => p.key === "GR-L")).toBeUndefined();
  });

  it("merge replaces its members by one subdivision", () => {
    const cfg = config({
      countries: { ES: lvl4 },
      merge: [{ key: "ES-X", memberKeys: ["ES-A", "ES-B"], names: { en: "AB" } }],
    });
    const a = unit("ES", 4, { iso: "ES-A" });
    const b = unit("ES", 4, { iso: "ES-B" });
    const c = unit("ES", 4, { iso: "ES-C" });
    const plan = planSubdivisions([a, b, c], cfg);
    expect(plan.map((p) => p.key)).toEqual(["ES-C", "ES-X"]);
    expect(plan[1]).toMatchObject({ geoObjectId: null, memberGeoObjectIds: [a.geoObjectId, b.geoObjectId], country: "ES" });
  });

  it("extra cuts CY-NC out of CY", () => {
    const cfg = config({
      countries: { CY: { ...lvl4, firstLevel: 5 } },
      wholeCountry: ["CY"],
      extra: [{ key: "CY-NC", country: "CY", osmRelationId: 2514541, cutFrom: "CY", names: { en: "Northern Cyprus" } }],
    });
    const cy = unit("CY", 2);
    const nc = unit("CY", 3, { osmRelationId: 2514541 });
    const plan = planSubdivisions([cy, nc], cfg);
    expect(plan.map((p) => p.key)).toEqual(["CY", "CY-NC"]);
    expect(plan[0]!.cutGeoObjectIds).toEqual([nc.geoObjectId]);
    expect(plan[1]).toMatchObject({ geoObjectId: nc.geoObjectId, names: { en: "Northern Cyprus" }, cutGeoObjectIds: [] });
  });

  it("notMediterranean drops a unit", () => {
    const cfg = config({ countries: { EG: lvl4 }, notMediterranean: ["EG-SUZ"] });
    const plan = planSubdivisions([unit("EG", 4, { iso: "EG-ALX" }), unit("EG", 4, { iso: "EG-SUZ" })], cfg);
    expect(plan.map((p) => p.key)).toEqual(["EG-ALX"]);
  });

  it("unit without ISO takes keyOverrides, else <cc>-<Qid>, and never throws", () => {
    const withOverride = unit("LB", 4, { osmRelationId: 12903506, wikidataId: "Q5" });
    const withQid = unit("ME", 4, { wikidataId: "Q77" });
    const bare = unit("ME", 4);
    const cfg = config({ countries: { LB: lvl4, ME: lvl4 }, keyOverrides: { "12903506": "LB-KJ" } });
    const plan = planSubdivisions([withOverride, withQid, bare], cfg);
    expect(plan.map((p) => p.key).sort()).toEqual(["LB-KJ", "ME-Q77", `ME-R${bare.osmRelationId}`].sort());
  });

  it("overrides change status and reason of a row", () => {
    const cfg = config({
      countries: { HR: lvl4 },
      overrides: { "HR-17": { status: "excluded", statusReason: "Sperrgebiet" } },
    });
    const plan = planSubdivisions([unit("HR", 4, { iso: "HR-17" })], cfg);
    expect(plan[0]).toMatchObject({ status: "excluded", statusReason: "Sperrgebiet" });
  });

  it("units of a country without configuration are ignored", () => {
    expect(planSubdivisions([unit("XX", 4, { iso: "XX-1" })], config({ countries: {} }))).toEqual([]);
  });
});

describe("whole country far from the sea and extra bases", () => {
  it("a whole country that does not touch the Mediterranean yields no row", () => {
    const cfg = config({ countries: { GB: whole } });
    expect(planSubdivisions([unit("GB", 2, { iso: null, touchesMediterranean: false })], cfg)).toEqual([]);
  });

  it("an extra of a whole country becomes its own row cut out of CY and the country unit never becomes one", () => {
    const cfg = config({
      countries: { GB: whole, CY: whole },
      extra: [{ key: "GB-SBA", country: "GB", osmRelationId: 3263728, cutFrom: "CY", names: { en: "Akrotiri and Dhekelia" } }],
    });
    const uk = unit("GB", 2, { touchesMediterranean: false });
    const sba = unit("GB", 2, { osmRelationId: 3263728 });
    const cy = unit("CY", 2);
    const plan = planSubdivisions([uk, sba, cy], cfg);
    expect(plan.map((p) => p.key)).toEqual(["CY", "GB-SBA"]);
    expect(plan[0]!.cutGeoObjectIds).toEqual([sba.geoObjectId]);
    expect(plan[1]).toMatchObject({ country: "GB", geoObjectId: sba.geoObjectId });
  });
});

describe("planWarnings", () => {
  it("reports configuration that matches nothing", () => {
    const cfg = config({
      countries: { GR: gr },
      split: [
        {
          parentKey: "GR-ZZ",
          groups: [
            { key: "GR-A1", names: {}, memberWikidataIds: ["Q1"] },
            { key: "GR-A2", names: {}, memberWikidataIds: ["Q2"] },
          ],
        },
      ],
      merge: [{ key: "GR-M", memberKeys: ["GR-Q1", "GR-Q2"], names: {} }],
      notMediterranean: ["GR-NO"],
      overrides: { "GR-GONE": { status: "excluded" } },
    });
    const units = [unit("GR", 5, { iso: "GR-L" })];
    const text = planWarnings(units, cfg, planSubdivisions(units, cfg)).join("\n");
    for (const needle of ["GR-ZZ", "GR-Q1", "GR-NO", "GR-GONE"]) expect(text).toContain(needle);
  });

  it("is silent for a consistent configuration", () => {
    const cfg = config({ countries: { HR: lvl4 } });
    const units = [unit("HR", 4, { iso: "HR-17" })];
    expect(planWarnings(units, cfg, planSubdivisions(units, cfg))).toEqual([]);
  });

  it("reports keyOverrides that match no unit", () => {
    const cfg = config({ countries: { HR: lvl4 }, keyOverrides: { "999": "HR-ZZ" } });
    const units = [unit("HR", 4, { iso: "HR-17" })];
    expect(planWarnings(units, cfg, planSubdivisions(units, cfg)).join("\n")).toContain("keyOverrides 999");
  });

  it("reports a duplicate key that was dropped", () => {
    const cfg = config({ countries: { HR: lvl4 } });
    const units = [unit("HR", 4, { iso: "HR-17" }), unit("HR", 4, { iso: "HR-17" })];
    const plan = planSubdivisions(units, cfg);
    expect(plan).toHaveLength(1);
    expect(planWarnings(units, cfg, plan).join("\n")).toContain("duplicate key HR-17");
  });
});
