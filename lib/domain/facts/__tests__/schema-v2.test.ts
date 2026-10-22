import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { TEXT_SCALE } from "@/config/fact-schema/v2";
import { SECTORS } from "../schema-types";
import { attributeDef, attributesForPrompt, getFactSchema, validateFactValue, validateTextFact } from "../schema";

const RESTRICTION_HIT = {
  kind: "military",
  restrictedAreaId: "0199f0a4-1b2c-7d3e-8f40-123456789abc",
  sourceRef: null,
  share: 0.6,
  anchoringBan: true,
};

describe("fact schema v2", () => {
  it("v2 keeps every v1 key and value schema", () => {
    const v1 = getFactSchema("v1").levels.place;
    const v2 = new Map(getFactSchema("v2").levels.place.map((d) => [d.key, d]));
    for (const def of v1) {
      const next = v2.get(def.key);
      expect(next, def.key).toBeDefined();
      expect(next!.rule, def.key).toBe(def.rule);
      for (const origin of def.origins) expect(next!.origins, def.key).toContain(origin);
      // prohibitions widens to a union with text entries (ruling M4-P10); every v1 value stays valid
      if (def.key !== "prohibitions") expect(next!.value, def.key).toBe(def.value);
    }
    expect(validateFactValue("shelter.N", 0.4, "v2")).toBe(validateFactValue("shelter.N", 0.4, "v1"));
    expect(validateFactValue("prohibitions", [RESTRICTION_HIT], "v2")).toEqual([RESTRICTION_HIT]);
    expect(validateFactValue("prohibitions", [], "v2")).toEqual([]);
  });

  it("shelter words map to the scale", () => {
    expect(TEXT_SCALE).toEqual({ good: 0.9, moderate: 0.5, poor: 0.1 });
    expect(validateTextFact("place", "shelter.N", "good")).toEqual({ ok: true, value: 0.9 });
    for (const s of SECTORS) expect(validateTextFact("place", `shelter.${s}`, "poor")).toEqual({ ok: true, value: 0.1 });
    expect(validateTextFact("place", "swell_protection", "moderate")).toEqual({ ok: true, value: 0.5 });
    expect(validateTextFact("place", "shelter.N", 0.4)).toMatchObject({ ok: false, reason: "invalid_value" });
  });

  it("computed-only attributes cannot come from text", () => {
    expect(validateTextFact("place", "anchor_area", { areaM2: 1 })).toMatchObject({ ok: false, reason: "not_text" });
    expect(validateTextFact("place", "fetch.N", 100)).toMatchObject({ ok: false, reason: "not_text" });
  });

  it("an attribute of another level is unknown", () => {
    expect(validateTextFact("island", "shelter.N", "good")).toMatchObject({ ok: false, reason: "unknown_attribute" });
    expect(validateTextFact("place", "meltemi_exposure", "high")).toMatchObject({ reason: "unknown_attribute" });
    expect(validateTextFact("place", "nonsense", 1)).toMatchObject({ reason: "unknown_attribute" });
  });

  it("seabed from text gets equal shares", () => {
    expect(validateTextFact("place", "seabed", ["sand", "weed"])).toEqual({
      ok: true,
      value: [
        { type: "sand", share: 0.5 },
        { type: "weed", share: 0.5 },
      ],
    });
    const three = validateTextFact("place", "seabed", ["sand", "mud", "rock"]);
    expect(three.ok).toBe(true);
    expect(validateTextFact("place", "seabed", ["sand", "sand"])).toEqual({ ok: true, value: [{ type: "sand", share: 1 }] });
    expect(validateTextFact("place", "seabed", [])).toMatchObject({ reason: "invalid_value" });
    expect(validateTextFact("place", "seabed", [{ type: "sand", share: 1 }])).toMatchObject({ reason: "invalid_value" });
  });

  it("depths from text are 0 to 200 m", () => {
    expect(validateTextFact("place", "depth.anchoring_min", 4.5)).toEqual({ ok: true, value: 4.5 });
    expect(validateTextFact("place", "depth.max", 250)).toMatchObject({ reason: "invalid_value" });
  });

  it("highlight values hold names, not prose", () => {
    expect(validateTextFact("place", "highlight.food", { present: true, names: ["Taverna Votsalo"] })).toEqual({
      ok: true,
      value: { present: true, names: ["Taverna Votsalo"] },
    });
    expect(validateTextFact("place", "highlight.food", { present: true, names: ["x".repeat(81)] })).toMatchObject({
      ok: false,
      reason: "invalid_value",
    });
    const eleven = Array.from({ length: 11 }, (_, i) => `Name ${i}`);
    expect(validateTextFact("place", "highlight.beach", { present: true, names: eleven })).toMatchObject({
      reason: "invalid_value",
    });
  });

  it("validates the structured place values", () => {
    expect(validateTextFact("place", "holding", "good")).toEqual({ ok: true, value: "good" });
    expect(validateTextFact("place", "mooring.types", [])).toMatchObject({ reason: "invalid_value" });
    expect(validateTextFact("place", "mooring.types", ["stern_to", "buoy"]).ok).toBe(true);
    expect(validateTextFact("place", "mooring.buoys", { present: true, count: 0, paid: null })).toMatchObject({
      reason: "invalid_value",
    });
    expect(validateTextFact("place", "mooring.buoys", { present: true, count: null, paid: true }).ok).toBe(true);
    expect(validateTextFact("place", "capacity", 2001)).toMatchObject({ reason: "invalid_value" });
    expect(validateTextFact("place", "occupancy", { "7": "full", "8": "full" }).ok).toBe(true);
    expect(validateTextFact("place", "occupancy", {})).toMatchObject({ reason: "invalid_value" });
    expect(validateTextFact("place", "occupancy", { "13": "full" })).toMatchObject({ reason: "invalid_value" });
    expect(validateTextFact("place", "services.water", true)).toEqual({ ok: true, value: true });
    expect(validateTextFact("place", "prohibitions", [{ kind: "anchoring", months: [7, 8] }]).ok).toBe(true);
    expect(validateTextFact("place", "prohibitions", [RESTRICTION_HIT])).toMatchObject({ reason: "invalid_value" });
    expect(validateTextFact("place", "hazards", [{ kind: "rock", name: null }]).ok).toBe(true);
    expect(validateTextFact("place", "season_notes", { months: [], kind: "closed" })).toMatchObject({
      reason: "invalid_value",
    });
    expect(validateTextFact("place", "prices", { amount: 25, currency: "EUR", unit: "night" }).ok).toBe(true);
    expect(validateTextFact("place", "prices", { amount: 25, currency: "USD", unit: "night" })).toMatchObject({
      reason: "invalid_value",
    });
    expect(validateTextFact("place", "contact", { vhf: "9", phone: null, url: "not a url" })).toMatchObject({
      reason: "invalid_value",
    });
    expect(validateTextFact("place", "contact", { vhf: "9", phone: null, url: "https://marina.example" }).ok).toBe(
      true,
    );
  });

  it("has area, island, cape/strait and poi attributes", () => {
    expect(validateTextFact("area", "meltemi_exposure", "high")).toEqual({ ok: true, value: 0.9 });
    expect(validateTextFact("island", "meltemi_exposure", "low")).toEqual({ ok: true, value: 0.1 });
    expect(validateTextFact("area", "charter_bases", ["Lavrio"]).ok).toBe(true);
    expect(validateTextFact("cape_strait", "passage_notes", { difficulty: "difficult", notes: ["acceleration"] }).ok).toBe(
      true,
    );
    expect(validateTextFact("cape_strait", "passage", {})).toMatchObject({ reason: "unknown_attribute" });
    expect(validateTextFact("cape_strait", "hazards", [{ kind: "current", name: null }]).ok).toBe(true);
    expect(validateTextFact("poi", "exists", false)).toEqual({ ok: true, value: false });
    expect(validateTextFact("poi", "season_notes", { months: [6, 7], kind: "open" }).ok).toBe(true);
  });

  it("keys on several levels share one definition", () => {
    const { levels } = getFactSchema("v2");
    const hazards = (l: keyof typeof levels) => levels[l].find((d) => d.key === "hazards");
    expect(hazards("place")).toBe(hazards("cape_strait"));
    const season = (l: keyof typeof levels) => levels[l].find((d) => d.key === "season_notes");
    expect(season("place")).toBe(season("poi"));
    expect(levels.area).toBe(levels.island);
  });

  it("names the consolidation rules of spec 07", () => {
    expect(attributeDef("holding", "v2").rule).toBe("holding");
    expect(attributeDef("services.wifi", "v2").rule).toBe("latest_observation");
    expect(attributeDef("highlight.town", "v2").rule).toBe("highlight");
    expect(attributeDef("occupancy", "v2").rule).toBe("occupancy");
    expect(attributeDef("meltemi_exposure", "v2").rule).toBe("area_weighted");
    expect(attributeDef("quietness", "v2").rule).toBe("default");
    expect(attributeDef("ferry_traffic", "v2").rule).toBe("area_weighted");
    const rules = new Set(Object.values(getFactSchema("v2").levels).flatMap((defs) => defs.map((d) => d.rule)));
    for (const rule of rules) {
      expect([
        "shelter",
        "swell_protection",
        "bathymetry",
        "holding",
        "latest_observation",
        "occupancy",
        "highlight",
        "prohibitions",
        "area_weighted",
        "union",
        "default",
        "computed_only",
        "review_over_computed",
      ]).toContain(rule);
    }
  });
});

describe("union attributes (ruling M5-P3)", () => {
  const UNION = ["hazards", "mooring.types", "season_notes", "wind_systems", "restricted_zones", "charter_bases", "supply_ports"];

  it("the list-valued attributes are merged by union, every one with an identity key in the active rules", () => {
    const defs = Object.values(getFactSchema("v2").levels).flat();
    const unionKeys = [...new Set(defs.filter((d) => d.rule === "union").map((d) => d.key))].sort();
    expect(unionKeys).toEqual([...UNION].sort());
    expect(Object.keys(getConfig().consolidation.rules.union.keys).sort()).toEqual([...UNION].sort());
  });

  it("no list-valued attribute is left to a single-value rule", () => {
    // season_notes is one entry per fact, but the profile keeps all of them (ruling M5-P3).
    const listValued = Object.values(getFactSchema("v2").levels)
      .flat()
      .filter((d) => d.value instanceof z.ZodArray && d.rule !== "union")
      .map((d) => `${d.key}:${d.rule}`);
    // prohibitions (own rule) and seabed (shares, bathymetry) are lists with a rule of their own.
    expect([...new Set(listValued)].sort()).toEqual(["prohibitions:prohibitions", "seabed:bathymetry"]);
  });
});

describe("attributesForPrompt", () => {
  it("lists the text attributes of a level with description and value format", () => {
    const lines = attributesForPrompt("place").split("\n");
    const shelter = lines.find((l) => l.startsWith("shelter.N — "));
    expect(shelter).toMatch(/— .*"enum":\["good","moderate","poor"\]/);
    expect(lines.some((l) => l.startsWith("fetch.N"))).toBe(false);
    expect(lines.some((l) => l.startsWith("anchor_area"))).toBe(false);
    expect(lines.find((l) => l.startsWith("seabed — "))).toMatch(/"items":\{.*"enum":\["sand"/);
    expect(attributesForPrompt("place")).not.toMatch(/\$schema/);
    expect(attributesForPrompt("cape_strait").split("\n").map((l) => l.split(" — ")[0])).toEqual([
      "passage_notes",
      "sea_state",
      "hazards",
    ]);
  });
});
