import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { attributeDef, attributesForPrompt, getFactSchema, validateTextFact } from "../schema";
import { FACT_ATTRIBUTE_LABELS } from "../labels";

const placeDefs = (version: string) => new Map(getFactSchema(version).levels.place.map((d) => [d.key, d]));
const shape = (def: { rule: string; description: string; origins: string[]; value: unknown }) => ({
  rule: def.rule,
  description: def.description,
  origins: def.origins,
  value: JSON.stringify(z.toJSONSchema(def.value as z.ZodType, { unrepresentable: "any" })),
});

describe("fact schema v3", () => {
  it("is the active version and the config loads with it", () => {
    expect(getFactSchema().version).toBe("v3");
    expect(getConfig().factSchema.version).toBe("v3");
  });

  it("differs from v2 exactly in services.fuel, services.water and the two new keys", () => {
    const v2 = placeDefs("v2");
    const v3 = placeDefs("v3");
    const added = [...v3.keys()].filter((k) => !v2.has(k)).sort();
    expect(added).toEqual(["berthable", "place.kind_evidence"]);
    expect([...v2.keys()].filter((k) => !v3.has(k))).toEqual([]);
    const changed = [...v2.keys()].filter((k) => JSON.stringify(shape(v2.get(k)!)) !== JSON.stringify(shape(v3.get(k)!))).sort();
    expect(changed).toEqual(["services.fuel", "services.water"]);
    for (const key of changed) {
      const a = shape(v2.get(key)!);
      const b = shape(v3.get(key)!);
      expect({ ...b, description: "" }).toEqual({ ...a, description: "" });
    }
    for (const level of ["area", "island", "cape_strait", "poi"] as const) {
      expect(getFactSchema("v3").levels[level]).toEqual(getFactSchema("v2").levels[level]);
    }
  });

  it("sharpens fuel and water in the prompt list", () => {
    const prompt = attributesForPrompt("place", "v3");
    expect(prompt).toContain("A petrol station in town does not count");
    expect(prompt).toContain("A fountain or tap in the village does not count");
    expect(attributesForPrompt("place", "v2")).not.toContain("petrol station");
  });

  it("berthable and place.kind_evidence are text-only latest observations", () => {
    expect(attributeDef("berthable", "v3")).toMatchObject({ rule: "latest_observation", origins: ["text"] });
    expect(attributeDef("place.kind_evidence", "v3")).toMatchObject({ rule: "latest_observation", origins: ["text"] });
    expect(validateTextFact("place", "berthable", false, "v3")).toEqual({ ok: true, value: false });
    expect(validateTextFact("place", "place.kind_evidence", "marina", "v3")).toEqual({ ok: true, value: "marina" });
    expect(validateTextFact("place", "place.kind_evidence", "harbour", "v3")).toMatchObject({ reason: "invalid_value" });
    expect(validateTextFact("place", "berthable", true, "v2")).toMatchObject({ reason: "unknown_attribute" });
  });

  it("every v3 key has a German label", () => {
    const keys = Object.values(getFactSchema("v3").levels).flatMap((defs) => defs.map((d) => d.key));
    expect(keys.filter((k) => !FACT_ATTRIBUTE_LABELS[k])).toEqual([]);
    expect(FACT_ATTRIBUTE_LABELS.berthable).toBe("Festmachplatz");
    expect(FACT_ATTRIBUTE_LABELS["place.kind_evidence"]).toBe("Ortsart laut Quelle");
  });

  it("place.kind_evidence is no gap for any kind, berthable is", () => {
    const { ignore } = getConfig().consolidation.gaps;
    for (const kind of ["anchorage", "port", "marina", "mooring_field"] as const) {
      expect(ignore[kind], kind).toContain("place.kind_evidence");
      expect(ignore[kind] ?? [], kind).not.toContain("berthable");
    }
  });
});
