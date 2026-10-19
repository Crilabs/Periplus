import { describe, expect, it } from "vitest";
import type { ConsolidationInput } from "@/lib/domain/consolidation/types";
import { computed, review, ruleCtx, text } from "@/test/fixtures/consolidation/scenarios";
import { areaWeightedRule } from "../area-weighted";
import { defaultRule } from "../default";
import { highlightRule } from "../highlight";
import { holdingRule } from "../holding";
import { latestObservationRule } from "../latest-observation";
import { unionRule } from "../union";

type Over = Partial<ConsolidationInput>;
const t = (value: unknown, over: Over = {}) => text({ value, ...over });

const ctx = ruleCtx({ attribute: "highlight.food" });
const water = ruleCtx({ attribute: "services.water" });

describe("latestObservationRule", () => {
  it("water 2019 yes, 2024 no → no, without conflict (time course)", () => {
    const r = latestObservationRule(
      [t(true, { observedAt: "2019-07-10", sourceWeight: 0.9 }), t(false, { observedAt: "2024-07-10", sourceKey: "source:b", sourceWeight: 0.4 })],
      water,
    )!;
    expect(r).toMatchObject({ value: false, origin: "text", observedAt: "2024-07-10", conflict: null });
  });

  it("same month: the stronger source wins", () => {
    const r = latestObservationRule(
      [
        t(true, { observedAt: "2026-07-05", sourceWeight: 0.5 }),
        t(false, { observedAt: "2026-07-20", sourceKey: "source:b", sourceWeight: 0.9 }),
      ],
      water,
    )!;
    expect(r).toMatchObject({ value: false, conflict: null });
    const flipped = latestObservationRule(
      [
        t(true, { observedAt: "2026-07-20", sourceWeight: 0.5 }),
        t(false, { observedAt: "2026-07-05", sourceKey: "source:b", sourceWeight: 0.9 }),
      ],
      water,
    )!;
    expect(flipped).toMatchObject({ value: false, conflict: null });
  });

  it("water yes and no in the same season year with similar weight is a conflict showing the heavier value", () => {
    const yes = t(true, { observedAt: "2026-06-01", sourceWeight: 0.9 });
    const no = t(false, { observedAt: "2026-08-01", sourceKey: "source:b", sourceWeight: 0.7 });
    const r = latestObservationRule([yes, no], water)!;
    expect(r.value).toBe(true);
    expect(r.conflict).toMatchObject({ attribute: "services.water", a: { value: true }, b: { value: false }, others: [] });
    expect(r.conflict!.a.factIds).toEqual([yes.factId]);
    expect(r.support).toEqual([yes]);
  });

  it("a duplicated mention of one source counts once (ruling M5-P4)", () => {
    const base = [t(true, { sourceWeight: 0.9 }), t(false, { sourceKey: "source:b", sourceWeight: 0.7 })];
    const dup = [...base, t(false, { sourceKey: "source:b", sourceWeight: 0.7 })];
    const one = latestObservationRule(base, water)!;
    const two = latestObservationRule(dup, water)!;
    expect(two.value).toBe(one.value);
    expect(two.confidence).toBe(one.confidence);
    expect(two.conflict!.a.weight).toBe(one.conflict!.a.weight);
    expect(two.conflict!.b.weight).toBe(one.conflict!.b.weight);
  });

  it("texts not younger than a review drop out behind it", () => {
    // the heavy 2026-03 text was overruled by the 2026-05 review; the light 2026-07 text competes with the review
    const r = latestObservationRule(
      [
        t(true, { observedAt: "2026-03-01", sourceWeight: 0.9, confidence: 0.9 }),
        t(true, { observedAt: "2026-03-01", sourceKey: "source:c", sourceWeight: 0.9, confidence: 0.9 }),
        review({ value: false, observedAt: "2026-05-01" }),
        t(true, { observedAt: "2026-07-01", sourceKey: "source:b", sourceWeight: 0.4 }),
      ],
      water,
    )!;
    expect(r).toMatchObject({ value: false, origin: "review", conflict: null });
  });

  it("no inputs → null", () => {
    expect(latestObservationRule([], water)).toBeNull();
  });
});

describe("highlightRule", () => {
  it("taverna 2019 yes, 2024 no → no, without conflict", () => {
    const r = highlightRule(
      [
        t({ present: true, names: ["Nikos"] }, { observedAt: "2019-07-10", sourceKey: "source:a", sourceWeight: 0.6 }),
        t({ present: false, names: [] }, { observedAt: "2024-07-10", sourceKey: "source:b", sourceWeight: 0.9 }),
      ],
      ctx,
    )!;
    expect(r.value).toEqual({ present: false, names: [] });
    expect(r.conflict).toBeNull();
  });

  it("highlight names are united and sorted by independent mentions", () => {
    // Nikos from source:a and source:b; Maria from source:a only (twice: one source counts once)
    const r = highlightRule(
      [
        t({ present: true, names: ["Maria", "Nikos"] }, { sourceKey: "source:a" }),
        t({ present: true, names: ["Maria"] }, { sourceKey: "source:a" }),
        t({ present: true, names: ["Nikos"] }, { sourceKey: "source:b" }),
        t({ present: true, names: ["Anna"] }, { sourceKey: "source:c" }),
      ],
      ctx,
    )!;
    expect(r.value).toEqual({ present: true, names: ["Nikos", "Anna", "Maria"] });
    expect(r.support).toHaveLength(4);
  });

  it("names are capped at maxNames", () => {
    const names = Array.from({ length: 12 }, (_, k) => `Name ${String(k).padStart(2, "0")}`);
    const r = highlightRule([t({ present: true, names })], ctx)!;
    expect((r.value as { names: string[] }).names).toEqual(names.slice(0, ctx.cfg.rules.highlight.maxNames));
  });

  it("present is picked on presence alone, names of absent inputs never count", () => {
    const r = highlightRule(
      [t({ present: true, names: ["Nikos"] }), t({ present: true, names: ["Maria"] }, { sourceKey: "source:b" })],
      ctx,
    )!;
    expect(r).toMatchObject({ value: { present: true, names: ["Maria", "Nikos"] }, conflict: null });
  });
});

describe("holdingRule", () => {
  const holding = ruleCtx({ attribute: "holding" });

  it("holding: weighted majority, texts only, no time course", () => {
    const r = holdingRule(
      [
        t("poor", { observedAt: "2025-06-01", sourceWeight: 0.9 }),
        t("good", { observedAt: "2026-06-01", sourceKey: "source:b", sourceWeight: 0.3 }),
        computed({ value: "good", attribute: "holding" }),
        t("good", { origin: "observed", sourceKey: "obs", sourceWeight: 0.8 }),
      ],
      holding,
    )!;
    expect(r).toMatchObject({ value: "poor", origin: "text", conflict: null });
  });

  it("similar weights are a conflict", () => {
    const r = holdingRule([t("good", { sourceWeight: 0.9 }), t("poor", { sourceKey: "source:b", sourceWeight: 0.8 })], holding)!;
    expect(r.value).toBe("good");
    expect(r.conflict).toMatchObject({ a: { value: "good" }, b: { value: "poor" } });
  });

  it("no text → null", () => {
    expect(holdingRule([computed({ value: "good" })], holding)).toBeNull();
  });
});

describe("defaultRule", () => {
  const capacity = ruleCtx({ attribute: "capacity" });

  it("default: latest with confidence ≥ 0.5, else weighted majority", () => {
    expect(
      defaultRule([t(40, { observedAt: "2022-07-01", confidence: 0.8 }), t(60, { observedAt: "2025-07-01", sourceKey: "source:b", confidence: 0.6 })], capacity),
    ).toMatchObject({ value: 60, conflict: null });
    // a newer input below 0.5 does not count while an eligible one exists
    expect(
      defaultRule([t(40, { observedAt: "2022-07-01", confidence: 0.8 }), t(60, { observedAt: "2025-07-01", sourceKey: "source:b", confidence: 0.3 })], capacity),
    ).toMatchObject({ value: 40 });
    // none eligible: the heaviest value of all, never a conflict
    const r = defaultRule([t(40, { confidence: 0.45 }), t(60, { sourceKey: "source:b", confidence: 0.4 })], capacity)!;
    expect(r).toMatchObject({ value: 40, conflict: null });
  });

  it("no inputs → null", () => {
    expect(defaultRule([], capacity)).toBeNull();
  });
});

describe("areaWeightedRule", () => {
  it("area facts: numeric weighted mean 0.62, enum majority, arrays united", () => {
    const meltemi = ruleCtx({ attribute: "meltemi_exposure", level: "area", place: null });
    const inputs = [t(0.9, { confidence: 1, sourceWeight: 0.65 }), t(0.1, { sourceKey: "source:b", confidence: 1, sourceWeight: 0.35 })];
    expect(areaWeightedRule(inputs, meltemi)).toMatchObject({ value: 0.62, conflict: null });
    // a duplicated mention of one source does not move the mean (ruling M5-P4)
    const dup = [...inputs, t(0.1, { sourceKey: "source:b", confidence: 1, sourceWeight: 0.35 })];
    expect(areaWeightedRule(dup, meltemi)!.value).toBe(0.62);

    const ferry = ruleCtx({ attribute: "ferry_traffic", level: "area", place: null });
    expect(
      areaWeightedRule(
        [t("high", { observedAt: "2024-07-01", sourceWeight: 0.9 }), t("low", { observedAt: "2026-07-01", sourceKey: "source:b", sourceWeight: 0.3 })],
        ferry,
      ),
    ).toMatchObject({ value: "high", conflict: null });

    const lists = ruleCtx({ attribute: "charter_bases", level: "area", place: null });
    expect(
      areaWeightedRule([t(["Alpha", "Beta"]), t(["Beta", "Gamma"], { sourceKey: "source:b" })], lists)!.value,
    ).toEqual(["Beta", "Alpha", "Gamma"]);
  });
});

describe("unionRule", () => {
  const hazards = ruleCtx({ attribute: "hazards" });

  it("hazards merge by kind and name, counted per independent source, never a conflict, no entry lost", () => {
    const r = unionRule(
      [
        t([{ kind: "rock", name: "Xera" }, { kind: "shoal", name: null }], { sourceKey: "source:a" }),
        t([{ kind: "rock", name: "Xera" }], { sourceKey: "source:a" }),
        t([{ kind: "wreck", name: null }, { kind: "rock", name: "Xera" }], { sourceKey: "source:b" }),
        t([{ kind: "rock", name: "Mikri" }], { sourceKey: "source:c", confidence: 0.3 }),
      ],
      hazards,
    )!;
    expect(r.value).toEqual([
      { kind: "rock", name: "Xera" },
      { kind: "rock", name: "Mikri" },
      { kind: "shoal", name: null },
      { kind: "wreck", name: null },
    ]);
    expect(r.conflict).toBeNull();
    expect(r.support).toHaveLength(4);
  });

  it("months of one wind system are united", () => {
    const r = unionRule(
      [t([{ name: "meltemi", months: [7, 8] }]), t([{ name: "meltemi", months: [6, 7] }, { name: "bora", months: [1] }], { sourceKey: "source:b" })],
      ruleCtx({ attribute: "wind_systems", level: "area", place: null }),
    )!;
    expect(r.value).toEqual([
      { name: "meltemi", months: [6, 7, 8] },
      { name: "bora", months: [1] },
    ]);
  });

  it("season notes (single entries) merge by kind into a list", () => {
    const r = unionRule(
      [t({ kind: "crowded", months: [8] }), t({ kind: "crowded", months: [7] }, { sourceKey: "source:b" }), t({ kind: "meltemi", months: [7, 8] })],
      ruleCtx({ attribute: "season_notes" }),
    )!;
    expect(r.value).toEqual([
      { kind: "crowded", months: [7, 8] },
      { kind: "meltemi", months: [7, 8] },
    ]);
  });

  it("mooring types: the element is its own key", () => {
    const r = unionRule([t(["buoy"]), t(["buoy"]), t(["anchor", "buoy"], { sourceKey: "source:b" })], ruleCtx({ attribute: "mooring.types" }))!;
    expect(r.value).toEqual(["buoy", "anchor"]);
  });

  it("an attribute without configured key throws", () => {
    expect(() => unionRule([t(["x"])], ruleCtx({ attribute: "capacity" }))).toThrow(/No union key/);
  });
});
