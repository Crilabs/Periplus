import { describe, expect, it } from "vitest";
import { getFactSchema } from "@/lib/domain/facts/schema";
import type { ConsolidationInput, RuleName } from "@/lib/domain/consolidation/types";
import { computed, review, ruleCtx, text } from "@/test/fixtures/consolidation/scenarios";
import { applyRule, RULES } from "../index";
import { occupancyRule } from "../occupancy";
import { prohibitionsRule } from "../prohibitions";
import { unionKeys } from "../union";

type Over = Partial<ConsolidationInput>;
const t = (value: unknown, over: Over = {}) => text({ value, ...over });

describe("RULES", () => {
  it("every rule name of fact schema v1 and v2 has an implementation", () => {
    for (const v of ["v1", "v2"])
      for (const defs of Object.values(getFactSchema(v).levels))
        for (const d of defs) expect(RULES[d.rule as RuleName], `${v} ${d.key} ${d.rule}`).toBeTypeOf("function");
  });

  it("presence-picked and field-wise attributes are object attributes of fact schema v2 with that rule", () => {
    const cfg = ruleCtx().cfg;
    const defs = Object.values(getFactSchema("v2").levels).flat();
    for (const key of cfg.rules.latest_observation.presence) expect(defs.find((d) => d.key === key)?.rule, key).toBe("latest_observation");
    for (const key of cfg.rules.default.fieldwise) expect(defs.find((d) => d.key === key)?.rule, key).toBe("default");
  });

  it("every union attribute of fact schema v2 has a configured identity key", () => {
    const ctx = ruleCtx();
    for (const defs of Object.values(getFactSchema("v2").levels))
      for (const d of defs.filter((x) => x.rule === "union")) expect(() => unionKeys(d.key, { ...ctx, attribute: d.key })).not.toThrow();
  });
});

describe("occupancyRule", () => {
  const ctx = ruleCtx({ attribute: "occupancy" });

  it("occupancy fills 12 months, months without data are unknown", () => {
    const r = occupancyRule(
      [t({ "7": "full", "8": "full" }, { sourceWeight: 0.9 }), t({ "7": "moderate", "6": "empty" }, { sourceKey: "source:b", sourceWeight: 0.4 })],
      ctx,
    )!;
    expect(r.value).toEqual({
      "1": "unknown",
      "2": "unknown",
      "3": "unknown",
      "4": "unknown",
      "5": "unknown",
      "6": "empty",
      "7": "full",
      "8": "full",
      "9": "unknown",
      "10": "unknown",
      "11": "unknown",
      "12": "unknown",
    });
    expect(r.conflict).toBeNull();
    expect(r.support).toHaveLength(2);
  });

  it("a month counts once per source (ruling M5-P4)", () => {
    const r = occupancyRule(
      [
        t({ "7": "moderate" }, { sourceWeight: 0.8 }),
        t({ "7": "moderate" }, { sourceWeight: 0.8 }),
        t({ "7": "full" }, { sourceKey: "source:b", sourceWeight: 0.9 }),
      ],
      ctx,
    )!;
    expect((r.value as Record<string, string>)["7"]).toBe("full");
  });

  it("a tie goes to the fuller level, not the alphabetically first (M5-C-R2 M-6)", () => {
    const r = occupancyRule(
      [t({ "7": "empty", "8": "full" }, { sourceWeight: 0.8 }), t({ "7": "moderate", "8": "empty" }, { sourceKey: "source:b", sourceWeight: 0.8 })],
      ctx,
    )!;
    expect(r.value).toMatchObject({ "7": "moderate", "8": "full" });
  });
});

describe("prohibitionsRule", () => {
  const ctx = ruleCtx({ attribute: "prohibitions" });
  const anchoring = [{ kind: "anchoring", months: null }];
  const forum = (value: unknown, observedAt: string) => t(value, { observedAt, sourceKey: "source:forum", sourceType: "forum", sourceWeight: 0.4 });
  const authority = (value: unknown, observedAt: string) =>
    t(value, { observedAt, sourceKey: "source:port", sourceType: "authority", sourceWeight: 0.9 });

  it("a ban is never lifted by omission, not even by a younger authority naming another kind (M5-C-R2 I-2)", () => {
    const r = prohibitionsRule([forum(anchoring, "2022-07-01"), authority([{ kind: "fishing", months: null }], "2024-07-01")], ctx)!;
    expect(r.value).toEqual([anchoring[0], { kind: "fishing", months: null }]);
    expect(prohibitionsRule([forum(anchoring, "2022-07-01"), authority([], "2024-07-01")], ctx)!.value).toEqual(anchoring);
    // a younger non-authority text does not lift it
    expect(prohibitionsRule([forum(anchoring, "2022-07-01"), t([{ kind: "fire", months: [7] }], { observedAt: "2024-07-01", sourceKey: "source:b" })], ctx)!.value).toEqual(
      [anchoring[0], { kind: "fire", months: [7] }],
    );
  });

  it("months per kind are united, null (all year) wins, sorted by kind", () => {
    const r = prohibitionsRule(
      [
        t([{ kind: "swimming", months: [8] }, { kind: "anchoring", months: [7, 8] }]),
        t([{ kind: "swimming", months: [6] }], { sourceKey: "source:b" }),
        t([{ kind: "anchoring", months: null }], { sourceKey: "source:c" }),
      ],
      ctx,
    )!;
    expect(r.value).toEqual([
      { kind: "anchoring", months: null },
      { kind: "swimming", months: [6, 8] },
    ]);
  });

  it("computed entries are never lifted; only a computation → its value unchanged", () => {
    const entry = { kind: "military", restrictedAreaId: "00000000-0000-4000-8000-000000000001", sourceRef: null, share: 0.4, anchoringBan: true };
    const c = computed({ attribute: "prohibitions", value: [entry], observedAt: "2023-01-01" });
    expect(prohibitionsRule([c], ctx)).toMatchObject({ value: [entry], origin: "computed" });
    const r = prohibitionsRule([c, forum(anchoring, "2022-07-01"), authority([{ kind: "fire", months: [8] }], "2024-07-01")], ctx)!;
    expect(r.value).toEqual([anchoring[0], { kind: "fire", months: [8] }, entry]);
    const both = prohibitionsRule([c, forum([{ kind: "fishing", months: null }], "2025-07-01")], ctx)!;
    expect(both.value).toEqual([{ kind: "fishing", months: null }, entry]);
  });

  it("a kind is removed by a review, a computed entry by a newer computation (M5-C-R2 I-2)", () => {
    const decision = review({ attribute: "prohibitions", value: [{ kind: "fishing", months: null }], observedAt: "2024-07-01" });
    const younger = t([{ kind: "swimming", months: [7] }], { observedAt: "2025-07-01", sourceKey: "source:b" });
    const r = applyRule("prohibitions", [forum(anchoring, "2022-07-01"), decision, younger], ctx)!;
    expect(r.value).toEqual([
      { kind: "fishing", months: null },
      { kind: "swimming", months: [7] },
    ]);
    const entry = { kind: "military", restrictedAreaId: "00000000-0000-4000-8000-000000000001", sourceRef: null, share: 0.4, anchoringBan: true };
    const old = computed({ attribute: "prohibitions", value: [entry], observedAt: "2023-01-01" });
    const recomputed = computed({ attribute: "prohibitions", value: [], observedAt: "2025-01-01" });
    expect(prohibitionsRule([old, recomputed, forum(anchoring, "2022-07-01")], ctx)!.value).toEqual(anchoring);
  });

  it("the output is sorted, also with only a computation (M5-C-R2 M-4)", () => {
    const area = (kind: string, id: string) => ({ kind, restrictedAreaId: id, sourceRef: null, share: 0.4, anchoringBan: true });
    const military = area("military", "00000000-0000-4000-8000-000000000001");
    const reserve = area("protected_area", "00000000-0000-4000-8000-000000000002");
    const c = computed({ attribute: "prohibitions", value: [reserve, military], observedAt: "2023-01-01" });
    expect(prohibitionsRule([c], ctx)!.value).toEqual([military, reserve]);
  });
});

describe("applyRule", () => {
  const ctx = ruleCtx({ attribute: "shelter.N" });

  it("a review decision newer than all facts wins with 0.95", () => {
    const decision = review({ value: 0.2, observedAt: "2026-09-01" });
    const r = applyRule("shelter", [computed({ value: 0.6, observedAt: "2026-01-01" }), t(0.9, { observedAt: "2025-07-01" }), decision], ctx)!;
    expect(r).toEqual({ value: 0.2, origin: "review", confidence: 0.95, observedAt: "2026-09-01", support: [decision], conflict: null });
    // a fact on the same day as the decision is no newer
    expect(applyRule("shelter", [t(0.9, { observedAt: "2026-09-01" }), decision], ctx)).toMatchObject({ value: 0.2, origin: "review" });
  });

  it("a text fact newer than the review decision goes through the rule again", () => {
    const water = ruleCtx({ attribute: "services.water" });
    const decision = review({ value: false, observedAt: "2025-07-01" });
    const newer = t(true, { observedAt: "2026-07-01", sourceKey: "source:b" });
    const r = applyRule("latest_observation", [t(true, { observedAt: "2025-03-01" }), decision, newer], water)!;
    // time course: the 2026 text changes the value
    expect(r).toMatchObject({ value: true, origin: "text", conflict: null });
    expect(r.support).toEqual([newer]);
  });

  it("an input without observation date (POI import) never disables the review shortcut (M5-C-R1 (2))", () => {
    const food = ruleCtx({ attribute: "highlight.food" });
    const decision = review({ attribute: "highlight.food", value: { present: false, names: [] }, observedAt: "2026-05-01" });
    const poi = computed({
      attribute: "highlight.food",
      value: { present: true, names: ["Nikos"] },
      computationId: null,
      poiId: "poi-1",
      sourceKey: "gazetteer:osm",
      confidence: 1,
      dateKnown: false,
      observedAt: "2026-09-01",
    });
    expect(applyRule("highlight", [decision, poi], food)).toMatchObject({ value: { present: false, names: [] }, origin: "review", conflict: null });
  });

  it("union attributes never take the shortcut: a review adds to the list (M5-C-R2 M-3)", () => {
    const hazards = ruleCtx({ attribute: "hazards" });
    const decision = review({ attribute: "hazards", value: [{ kind: "shoal", name: null }], observedAt: "2026-09-01" });
    const r = applyRule("union", [t([{ kind: "rock", name: "Xera" }], { observedAt: "2025-07-01" }), decision], hazards)!;
    expect(r.value).toEqual([
      { kind: "rock", name: "Xera" },
      { kind: "shoal", name: null },
    ]);
  });

  it("an unknown rule name fails loudly (M5-C-R2 M-2)", () => {
    expect(() => applyRule("no_such_rule" as RuleName, [t(1)], ctx)).toThrow("Unknown consolidation rule no_such_rule");
  });

  it("empty inputs still go through the rule (harbour floor)", () => {
    const marina = ruleCtx({ attribute: "shelter.N", place: { kind: "marina", status: "confirmed" } });
    expect(applyRule("shelter", [], marina)).toMatchObject({ value: 0.8, origin: "rule" });
    expect(applyRule("default", [], ruleCtx({ attribute: "capacity" }))).toBeNull();
  });

  it("dispatches to the named rule", () => {
    const inputs = [t({ present: true, names: ["Nikos"] })];
    expect(applyRule("highlight", inputs, ruleCtx({ attribute: "highlight.food" }))).toEqual(
      RULES.highlight(inputs, ruleCtx({ attribute: "highlight.food" })),
    );
  });
});

describe("one source counts once (ruling M5-P4)", () => {
  // a matcher fact and a model mention of the same span: two facts of one source with one value
  it.each<[RuleName, string, unknown, unknown]>([
    ["holding", "holding", "good", "poor"],
    ["default", "capacity", 40, 60],
    ["latest_observation", "services.water", true, false],
    ["highlight", "highlight.food", { present: true, names: ["Nikos"] }, { present: true, names: ["Maria"] }],
    ["area_weighted", "meltemi_exposure", 0.9, 0.1],
    ["union", "hazards", [{ kind: "rock", name: "Xera" }], [{ kind: "shoal", name: null }]],
    ["occupancy", "occupancy", { "7": "full" }, { "7": "moderate" }],
    ["prohibitions", "prohibitions", [{ kind: "anchoring", months: [7] }], [{ kind: "fire", months: null }]],
  ])("%s gives the same result with a duplicated mention", (rule, attribute, a, b) => {
    const ctx = ruleCtx({ attribute });
    const one = [t(a, { sourceWeight: 0.6 }), t(b, { sourceKey: "source:b", sourceWeight: 0.7 })];
    const two = [...one, t(b, { sourceKey: "source:b", sourceWeight: 0.7 })];
    const r1 = applyRule(rule, one, ctx)!;
    const r2 = applyRule(rule, two, ctx)!;
    expect(r2.value).toEqual(r1.value);
    expect(r2.confidence).toBe(r1.confidence);
    expect(r2.conflict?.a.weight).toBe(r1.conflict?.a.weight);
  });
});
