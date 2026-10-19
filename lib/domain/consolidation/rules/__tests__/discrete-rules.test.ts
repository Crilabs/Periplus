import { describe, expect, it } from "vitest";
import type { ConsolidationInput } from "@/lib/domain/consolidation/types";
import { computed, review, ruleCtx, text } from "@/test/fixtures/consolidation/scenarios";
import { areaWeightedRule } from "../area-weighted";
import { defaultRule } from "../default";
import { highlightRule } from "../highlight";
import { holdingRule } from "../holding";
import { latestObservationRule } from "../latest-observation";
import { unionEntryKey, unionRule } from "../union";

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

  it("water yes and no in the same month with similar weight is a conflict showing the heavier value", () => {
    const yes = t(true, { observedAt: "2026-08-01", sourceWeight: 0.9 });
    const no = t(false, { observedAt: "2026-08-20", sourceKey: "source:b", sourceWeight: 0.7 });
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
    // the heavy 2026-03 text was overruled by the 2026-05-01 review; the light text of the same month (no time
    // course, ruling M5-C-R1 (3)) competes with the review by weight
    const r = latestObservationRule(
      [
        t(true, { observedAt: "2026-03-01", sourceWeight: 0.9, confidence: 0.9 }),
        t(true, { observedAt: "2026-03-01", sourceKey: "source:c", sourceWeight: 0.9, confidence: 0.9 }),
        review({ value: false, observedAt: "2026-05-01" }),
        t(true, { observedAt: "2026-05-20", sourceKey: "source:b", sourceWeight: 0.4 }),
      ],
      water,
    )!;
    expect(r).toMatchObject({ value: false, origin: "review", conflict: null });
  });

  it("a later month of the same season year is a time course: the lighter, younger source wins (M5-C-R1 (3))", () => {
    const r = latestObservationRule(
      [t(true, { observedAt: "2026-06-10", sourceWeight: 0.9 }), t(false, { observedAt: "2026-08-10", sourceKey: "source:b", sourceWeight: 0.4 })],
      water,
    )!;
    expect(r).toMatchObject({ value: false, observedAt: "2026-08-10", conflict: null });
    // overlapping months cannot be ordered: the heavier value, a conflict when within the ratio
    const overlap = latestObservationRule(
      [
        t(true, { observedAt: "2026-06-10", sourceWeight: 0.9 }),
        t(true, { observedAt: "2026-09-10", sourceKey: "source:c", sourceWeight: 0.2 }),
        t(false, { observedAt: "2026-08-10", sourceKey: "source:b", sourceWeight: 0.8 }),
      ],
      water,
    )!;
    expect(overlap.value).toBe(true);
  });

  it("support is sorted by input id, whatever the input order (M5-C-R2 M-5)", () => {
    const inputs = [t(true, { sourceKey: "source:a" }), t(true, { sourceKey: "source:b" }), t(true, { sourceKey: "source:c" })];
    const forward = latestObservationRule(inputs, water)!;
    const backward = latestObservationRule([...inputs].reverse(), water)!;
    expect(backward.support).toEqual(forward.support);
    expect(forward.support.map((i) => i.factId)).toEqual([...inputs.map((i) => i.factId)].sort());
  });

  it("no inputs → null", () => {
    expect(latestObservationRule([], water)).toBeNull();
  });
});

describe("mooring.buoys (ruling M5-C-R2 I-1)", () => {
  const buoys = ruleCtx({ attribute: "mooring.buoys" });

  it("sources agreeing on presence never conflict; count and paid come from the strongest input carrying them", () => {
    const r = latestObservationRule(
      [
        t({ present: true, count: null, paid: null }, { observedAt: "2026-08-01", sourceWeight: 0.9 }),
        t({ present: true, count: 20, paid: true }, { observedAt: "2026-08-15", sourceKey: "source:b", sourceWeight: 0.8 }),
      ],
      buoys,
    )!;
    expect(r).toMatchObject({ value: { present: true, count: 20, paid: true }, conflict: null });
    expect(r.support).toHaveLength(2);
  });

  it("an older count is kept when a newer source confirms presence without it", () => {
    const r = latestObservationRule(
      [
        t({ present: true, count: 20, paid: true }, { observedAt: "2024-07-01", sourceWeight: 0.6 }),
        t({ present: true, count: null, paid: false }, { observedAt: "2026-07-01", sourceKey: "source:b", sourceWeight: 0.9 }),
      ],
      buoys,
    )!;
    expect(r.value).toEqual({ present: true, count: 20, paid: false });
  });

  it("presence yes and no in one month is a conflict whose sides carry the full values", () => {
    const r = latestObservationRule(
      [
        t({ present: true, count: 12, paid: null }, { observedAt: "2026-08-01", sourceWeight: 0.9 }),
        t({ present: false, count: null, paid: null }, { observedAt: "2026-08-20", sourceKey: "source:b", sourceWeight: 0.8 }),
      ],
      buoys,
    )!;
    expect(r.value).toEqual({ present: true, count: 12, paid: null });
    expect(r.conflict).toMatchObject({
      a: { value: { present: true, count: 12, paid: null } },
      b: { value: { present: false, count: null, paid: null } },
    });
  });
});

describe("contact (ruling M5-C-R2 I-1)", () => {
  const contact = ruleCtx({ attribute: "contact" });
  const c = (vhf: string | null, phone: string | null, url: string | null) => ({ vhf, phone, url });

  it("partial contacts merge field by field, without conflict", () => {
    const r = defaultRule(
      [t(c("16", null, null), { observedAt: "2025-07-01" }), t(c(null, "+30 22990 1", null), { observedAt: "2026-07-01", sourceKey: "source:b" })],
      contact,
    )!;
    expect(r).toMatchObject({ value: c("16", "+30 22990 1", null), conflict: null });
    expect(r.support).toHaveLength(2);
    // two sources completing each other do not confirm one another: no second-source bonus
    const alone = defaultRule([t(c(null, "+30 22990 1", null), { observedAt: "2026-07-01", sourceKey: "source:b" })], contact)!;
    expect(r.confidence).toBe(alone.confidence);
    const confirmed = defaultRule(
      [t(c("16", null, null), { observedAt: "2026-07-01" }), t(c("16", "+30 22990 1", null), { observedAt: "2026-07-01", sourceKey: "source:b" })],
      contact,
    )!;
    expect(confirmed.confidence).toBeGreaterThan(alone.confidence);
  });

  it("each field is the latest input carrying it; in the same month the stronger source", () => {
    const r = defaultRule(
      [
        t(c("16", "+30 1", null), { observedAt: "2024-07-01", sourceWeight: 0.9 }),
        t(c("12", null, null), { observedAt: "2026-07-01", sourceKey: "source:b", sourceWeight: 0.4 }),
        t(c(null, "+30 2", null), { observedAt: "2026-07-05", sourceKey: "source:c", sourceWeight: 0.4 }),
        t(c(null, "+30 3", null), { observedAt: "2026-07-20", sourceKey: "source:d", sourceWeight: 0.3 }),
      ],
      contact,
    )!;
    expect(r.value).toEqual(c("12", "+30 2", null));
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
      [
        t({ present: true, names: ["Nikos"] }),
        t({ present: true, names: ["Maria"] }, { sourceKey: "source:b" }),
        // an older, lighter absent input: its names never count
        t({ present: false, names: ["Kostas"] }, { observedAt: "2025-07-01", sourceKey: "source:c", sourceWeight: 0.3 }),
      ],
      ctx,
    )!;
    expect(r).toMatchObject({ value: { present: true, names: ["Maria", "Nikos"] }, conflict: null });
  });

  it("a later month of the same season year is a time course (M5-C-R1 (3))", () => {
    const r = highlightRule(
      [
        t({ present: true, names: ["Nikos"] }, { observedAt: "2026-06-10", sourceWeight: 0.9 }),
        t({ present: false, names: [] }, { observedAt: "2026-08-10", sourceKey: "source:b", sourceWeight: 0.4 }),
      ],
      ctx,
    )!;
    expect(r).toMatchObject({ value: { present: false, names: [] }, conflict: null });
  });

  it("conflict sides carry the names (M5-C-R1 (6))", () => {
    const r = highlightRule(
      [
        t({ present: true, names: ["Nikos"] }, { observedAt: "2026-08-01", sourceWeight: 0.9 }),
        t({ present: true, names: ["Maria"] }, { observedAt: "2026-08-02", sourceKey: "source:c", sourceWeight: 0.2 }),
        t({ present: false, names: [] }, { observedAt: "2026-08-20", sourceKey: "source:b", sourceWeight: 0.9 }),
      ],
      ctx,
    )!;
    expect(r.conflict).toMatchObject({
      a: { value: { present: true, names: ["Maria", "Nikos"] } },
      b: { value: { present: false, names: [] } },
    });
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

describe("areaWeightedRule confidence and order", () => {
  const meltemi = ruleCtx({ attribute: "meltemi_exposure", level: "area", place: null });

  it("the second-source bonus only from sources agreeing with the mean (M5-C-R1 (4))", () => {
    const apart = [t(0.9, { confidence: 1, sourceWeight: 0.65 }), t(0.1, { sourceKey: "source:b", confidence: 1, sourceWeight: 0.35 })];
    expect(areaWeightedRule(apart, meltemi)!.confidence).toBe(0.65);
    const agreeing = [t(0.9, { confidence: 1, sourceWeight: 0.65 }), t(0.9, { sourceKey: "source:b", confidence: 1, sourceWeight: 0.35 })];
    expect(areaWeightedRule(agreeing, meltemi)!.confidence).toBe(0.8);
  });

  it("the mean does not depend on the input order (M5-C-R2 M-8)", () => {
    const pairs: [number, number][] = [
      [0.703, 0.14],
      [0.966, 0.58],
      [0.337, 0.22],
      [0.589, 0.3],
    ];
    const inputs = pairs.map(([value, w], k) => t(value, { sourceKey: `source:${k}`, confidence: 1, sourceWeight: w }));
    const forward = areaWeightedRule(inputs, meltemi)!.value;
    expect(areaWeightedRule([...inputs].reverse(), meltemi)!.value).toBe(forward);
  });
});

describe("unionRule", () => {
  const hazards = ruleCtx({ attribute: "hazards" });

  it("per-entry provenance: entry key → sorted fact ids (M5-C-R1 (5))", () => {
    const a = t([{ kind: "rock", name: "Xera" }, { kind: "shoal", name: null }], { sourceKey: "source:a" });
    const b = t([{ kind: "rock", name: "Xera" }], { sourceKey: "source:b" });
    const r = unionRule([b, a], hazards)!;
    expect(r.entryFactIds).toEqual({
      [unionEntryKey({ kind: "rock", name: "Xera" }, hazards)]: [a.factId, b.factId].sort(),
      [unionEntryKey({ kind: "shoal", name: null }, hazards)]: [a.factId],
    });
  });

  it("the second-source bonus only when two sources name one entry (M5-C-R2 M-1)", () => {
    const apart = unionRule([t([{ kind: "rock", name: "Xera" }]), t([{ kind: "shoal", name: null }], { sourceKey: "source:b" })], hazards)!;
    expect(apart.confidence).toBe(0.8);
    const agreeing = unionRule([t([{ kind: "rock", name: "Xera" }]), t([{ kind: "rock", name: "Xera" }], { sourceKey: "source:b" })], hazards)!;
    expect(agreeing.confidence).toBe(0.95);
  });

  it("a review never drops older entries; it adds, or removes one entry explicitly (M5-C-R2 M-3)", () => {
    const rock = { kind: "rock", name: "Xera" };
    const older = t([rock], { observedAt: "2025-07-01" });
    const adding = review({ attribute: "hazards", value: [{ kind: "shoal", name: null }], observedAt: "2026-05-01" });
    const younger = t([{ kind: "wreck", name: null }], { observedAt: "2026-07-01", sourceKey: "source:b" });
    expect(unionRule([older, adding, younger], hazards)!.value).toEqual([
      rock,
      { kind: "shoal", name: null },
      { kind: "wreck", name: null },
    ]);

    const removing = review({ attribute: "hazards", value: { remove: rock }, observedAt: "2026-05-01" });
    const removed = unionRule([older, removing, younger], hazards)!;
    expect(removed.value).toEqual([{ kind: "wreck", name: null }]);
    expect(removed.support).toContain(removing);
    // a younger text naming the entry again brings it back
    const again = t([rock], { observedAt: "2026-08-01", sourceKey: "source:c" });
    expect(unionRule([older, removing, younger, again], hazards)!.value).toEqual([rock, { kind: "wreck", name: null }]);
  });

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
