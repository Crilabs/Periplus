import { describe, expect, it } from "vitest";
import type { ConsolidationInput } from "@/lib/domain/rules/types";
import { getConsolidationConfig } from "@/lib/config";
import { computed, review, ruleCtx, text } from "@/test/fixtures/consolidation/scenarios";
import { bathymetryRule } from "../bathymetry";
import { computedOnlyRule } from "../computed-only";
import { reviewOverComputedRule } from "../review-over-computed";
import { shelterRule } from "../shelter";
import { swellProtectionRule } from "../swell-protection";

type Over = Partial<ConsolidationInput>;
const c = (value: unknown, over: Over = {}) => computed({ value, ...over });
const t = (value: unknown, over: Over = {}) => text({ value, ...over });

const ctx = ruleCtx({ today: "2026-10-19", attribute: "shelter.N" });
const marinaCtx = ruleCtx({ attribute: "shelter.N", place: { kind: "marina", status: "confirmed" } });
const portCtx = ruleCtx({ attribute: "shelter.N", place: { kind: "port", status: "confirmed" } });
const swellCtx = ruleCtx({ attribute: "swell_protection" });
const depthCtx = ruleCtx({ attribute: "depth.anchoring_min" });

describe("shelterRule", () => {
  it.each<[string, ConsolidationInput[], number, string]>([
    ["computed only", [c(0.6)], 0.6, "computed"],
    ["better text raises by at most 0.1", [c(0.6), t(0.9)], 0.7, "text"],
    ["better text within 0.1", [c(0.6), t(0.65)], 0.65, "text"],
    ["poor text corrected by at most 0.3", [c(0.6), t(0.1)], 0.3, "text"],
    ["contradicting texts take the worse", [c(0.6), t(0.9), t(0.5, { sourceKey: "source:b" })], 0.5, "text"],
    ["no computation: text value", [t(0.5)], 0.5, "text"],
    ["an observation corrects like a text", [c(0.6), t(0.1, { origin: "observed" })], 0.3, "observed"],
  ])("shelter: %s", (_n, inputs, value, origin) => {
    expect(shelterRule(inputs, ctx)).toMatchObject({ value, origin, conflict: null });
  });

  it("a text raises the basis by at most maxRaise, lowers it by up to maxCorrection (test run Attika 2)", () => {
    expect(ctx.cfg.rules.shelter).toMatchObject({ maxRaise: 0.1, maxCorrection: 0.3 });
    // a blanket "very good from any direction" (0.9) cannot close an open sector
    expect(shelterRule([c(0.597), t(0.9)], ctx)).toMatchObject({ value: 0.697, origin: "text" });
    expect(shelterRule([c(0.597), t(0.2)], ctx)).toMatchObject({ value: 0.297, origin: "text" });
    expect(shelterRule([t(0.9)], ctx)).toMatchObject({ value: 0.9, origin: "text" });
    // a review raises like a text
    expect(shelterRule([c(0.597), review({ value: 0.9 })], ctx)).toMatchObject({ value: 0.697, origin: "review" });
  });

  it("rules v3 (no maxRaise) keeps raising by up to maxCorrection", () => {
    const v3 = ruleCtx({ attribute: "shelter.N", cfg: getConsolidationConfig("v3") });
    expect(v3.cfg.rules.shelter).not.toHaveProperty("maxRaise");
    expect(shelterRule([c(0.597), t(0.9)], v3)).toMatchObject({ value: 0.897, origin: "text" });
    expect(shelterRule([c(0.6), t(0.9)], v3)).toMatchObject({ value: 0.9, origin: "text" });
  });

  it("the youngest computation is the basis", () => {
    const r = shelterRule([c(0.6, { observedAt: "2025-01-01" }), c(0.4, { observedAt: "2026-01-01" })], ctx)!;
    expect(r).toMatchObject({ value: 0.4, origin: "computed", observedAt: "2026-01-01" });
    expect(r.support).toHaveLength(1);
  });

  it("rounds to the precision", () => {
    expect(shelterRule([c(0.6), t(0.1 + 0.2)], ctx)!.value).toBe(0.3);
    expect(shelterRule([c(0.12345)], ctx)!.value).toBe(0.123);
  });

  it("confidence over the support: computed alone, confirmed by a text", () => {
    expect(shelterRule([c(0.6, { confidence: 0.6 })], ctx)!.confidence).toBe(0.6);
    // the text sets the result 0.7, the computation (0.6) does not carry it: base 0.8 × 1 of the text, no bonus
    expect(shelterRule([c(0.6, { confidence: 0.6 }), t(0.9)], ctx)!.confidence).toBe(0.8);
    // both carry 0.6: second independent source +0.15, cap 0.95
    expect(shelterRule([c(0.6, { confidence: 0.6 }), t(0.6)], ctx)!.confidence).toBe(0.95);
  });

  it("no bonus for a clamped value no input states (ruling M5-B-R2)", () => {
    const r = shelterRule([c(0.6, { confidence: 0.6 }), t(0.1, { confidence: 0.8 })], ctx)!;
    expect(r).toMatchObject({ value: 0.3, origin: "text", confidence: 0.8 });
  });

  it("a clamped basis whose value the result does not carry leaves the support (bundle B re-review)", () => {
    const r = shelterRule([c(0.6, { confidence: 0.9 }), t(0.1, { confidence: 0.5 })], ctx)!;
    // the base confidence comes from the text setting the value, not from the stronger computation the clamp moved
    expect(r).toMatchObject({ value: 0.3, origin: "text", confidence: 0.5 });
    expect(r.support.map((i) => i.origin)).toEqual(["text"]);
    // an unclamped basis carrying the result stays in the support
    expect(shelterRule([c(0.6, { confidence: 0.9 }), t(0.6)], ctx)!.support.map((i) => i.origin).sort()).toEqual(["computed", "text"]);
  });

  it("an older review is a non-ageing correction input: a newer computation or a better text cannot override it", () => {
    const rev = review({ value: 0.3, observedAt: "2025-01-01", confidence: 0.5 });
    expect(shelterRule([rev, c(0.6, { observedAt: "2026-10-19" })], ctx)).toMatchObject({ value: 0.3, origin: "review", confidence: 0.95 });
    expect(shelterRule([rev, c(0.6), t(0.9, { observedAt: "2026-06-01" })], ctx)).toMatchObject({ value: 0.3, origin: "review" });
  });

  it("a newer worse text overrides a review; texts the review saw drop out", () => {
    const rev = review({ value: 0.6, observedAt: "2025-01-01" });
    expect(shelterRule([rev, c(0.6), t(0.2, { observedAt: "2026-06-01" })], ctx)).toMatchObject({ value: 0.3, origin: "text" });
    expect(shelterRule([t(0.2, { observedAt: "2024-06-01" }), rev, c(0.6)], ctx)).toMatchObject({ value: 0.6, origin: "review", confidence: 0.95 });
  });

  it("a duplicated mention of one source changes nothing (ruling M5-P4)", () => {
    const once = shelterRule([c(0.6), t(0.5, { factId: "f1" })], ctx)!;
    const twice = shelterRule([c(0.6), t(0.5, { factId: "f1" }), t(0.5, { factId: "f2" })], ctx)!;
    expect({ value: twice.value, confidence: twice.confidence }).toEqual({ value: once.value, confidence: once.confidence });
  });

  it("the harbour floor has origin 'rule' and cites no fact (ruling M5-B-R2)", () => {
    expect(shelterRule([c(0.4), t(0.1, { confidence: 0.6 })], marinaCtx)).toEqual({
      value: 0.8,
      origin: "rule",
      confidence: 0.3,
      observedAt: null,
      support: [],
      conflict: null,
    });
  });

  it("the open side is proven by the text that sets the value, not by another one", () => {
    // the weak 0.2 text sets nothing below the floor; the proving 0.5 text sets the value
    expect(shelterRule([t(0.5, { confidence: 0.7 }), t(0.2, { confidence: 0.3, sourceKey: "source:b" })], marinaCtx)).toMatchObject({
      value: 0.5,
      origin: "text",
    });
    expect(shelterRule([c(0.4), t(0.5, { confidence: 0.7 }), t(0.1, { confidence: 0.3, sourceKey: "source:b" })], marinaCtx)!.value).toBe(0.5);
    // a review (0.95) proves an open side
    expect(shelterRule([c(0.4, { observedAt: "2026-10-19" }), review({ value: 0.3, observedAt: "2025-01-01" })], marinaCtx)!.value).toBe(0.3);
  });

  it("a marina keeps the 0.8 floor without proof of an open side", () => {
    expect(shelterRule([c(0.4)], marinaCtx)!.value).toBe(0.8);
    expect(shelterRule([c(0.4), t(0.1, { confidence: 0.6 })], marinaCtx)!.value).toBe(0.8);
    expect(shelterRule([c(0.4), t(0.6, { confidence: 0.9 })], portCtx)!.value).toBe(0.8);
    expect(shelterRule([c(0.9)], portCtx)!.value).toBe(0.9);
  });

  it("a text with confidence 0.7 proving an open side lifts the floor", () => {
    expect(shelterRule([c(0.4), t(0.1, { confidence: 0.7 })], marinaCtx)!.value).toBe(0.1);
    expect(shelterRule([c(0.4), t(0.5, { confidence: 0.7 })], portCtx)!.value).toBe(0.5);
  });

  it("a marina without any input gets 0.8 with confidence 0.3", () => {
    expect(shelterRule([], marinaCtx)).toEqual({ value: 0.8, origin: "rule", confidence: 0.3, observedAt: null, support: [], conflict: null });
  });

  it("an anchorage without any input has no value", () => {
    expect(shelterRule([], ctx)).toBeNull();
    expect(shelterRule([], ruleCtx({ place: null }))).toBeNull();
  });
});

describe("swellProtectionRule", () => {
  it("swell: text 0.7 beats computation, text 0.6 does not", () => {
    expect(swellProtectionRule([c(0.3), t(0.9, { confidence: 0.7 })], swellCtx)).toMatchObject({ value: 0.9, origin: "text" });
    expect(swellProtectionRule([c(0.3), t(0.9, { confidence: 0.6 })], swellCtx)).toMatchObject({ value: 0.3, origin: "computed" });
  });

  it("among good texts the heaviest wins; without a computation any text", () => {
    const r = swellProtectionRule(
      [c(0.3), t(0.9, { confidence: 0.7, sourceWeight: 0.5 }), t(0.5, { confidence: 0.8, sourceWeight: 0.9, sourceKey: "source:b" })],
      swellCtx,
    );
    expect(r).toMatchObject({ value: 0.5, origin: "text" });
    expect(
      swellProtectionRule([t(0.9, { confidence: 0.3, sourceWeight: 0.5 }), t(0.1, { confidence: 0.5, sourceKey: "source:b" })], swellCtx),
    ).toMatchObject({ value: 0.1, origin: "text" });
  });

  it("an older review enters with 0.95 and beats a newer computation or a weaker newer text", () => {
    const rev = review({ value: 0.9, observedAt: "2025-01-01", confidence: 0.5 });
    expect(swellProtectionRule([rev, c(0.3, { observedAt: "2026-10-19" })], swellCtx)).toMatchObject({ value: 0.9, origin: "review", confidence: 0.95 });
    expect(swellProtectionRule([rev, c(0.3), t(0.5, { confidence: 0.7, sourceWeight: 0.8, observedAt: "2026-06-01" })], swellCtx)).toMatchObject({
      value: 0.9,
      origin: "review",
    });
  });

  it("the youngest computation without good texts; no input no value", () => {
    expect(swellProtectionRule([c(0.3, { observedAt: "2025-01-01" }), c(0.7, { observedAt: "2026-01-01" })], swellCtx)!.value).toBe(0.7);
    expect(swellProtectionRule([], swellCtx)).toBeNull();
  });
});

describe("bathymetryRule", () => {
  it("two simultaneous contradicting depth texts at 0.6 keep the bathymetry", () => {
    expect(
      bathymetryRule([c(4.0, { confidence: 0.6 }), t(2.5, { confidence: 0.6 }), t(6.0, { confidence: 0.6, sourceKey: "source:b" })], depthCtx),
    ).toMatchObject({ value: 4, origin: "computed" });
  });

  it("a depth text above 0.8 corrects; a weak raster (0.3) yields to any text", () => {
    expect(bathymetryRule([c(4.0, { confidence: 0.6 }), t(2.5, { confidence: 0.85 })], depthCtx)).toMatchObject({ value: 2.5, origin: "text" });
    expect(bathymetryRule([c(4.0, { confidence: 0.6 }), t(2.5, { confidence: 0.8 })], depthCtx)).toMatchObject({ value: 4, origin: "computed" });
    expect(bathymetryRule([c(4.0, { confidence: 0.3 }), t(2.5, { confidence: 0.5 })], depthCtx)).toMatchObject({ value: 2.5, origin: "text" });
    expect(bathymetryRule([c(4.0, { confidence: 0.3 })], depthCtx)).toMatchObject({ value: 4, origin: "computed" });
  });

  it("contradicting strong depth texts: the shallower value wins with a conflict, the third value in the note", () => {
    const inputs = [
      c(4.0, { confidence: 0.6 }),
      t(3.0, { confidence: 0.9, observedAt: "2026-05-01", sourceKey: "source:a", factId: "fact-a" }),
      t(2.5, { confidence: 0.85, observedAt: "2026-05-01", sourceWeight: 0.5, sourceKey: "source:b", factId: "fact-b" }),
      t(3.5, { confidence: 0.9, observedAt: "2026-05-01", sourceWeight: 0.4, sourceKey: "source:c", factId: "fact-c" }),
    ];
    const forward = bathymetryRule(inputs, depthCtx)!;
    expect(forward).toMatchObject({ value: 2.5, origin: "text" });
    expect(forward.conflict).toMatchObject({
      attribute: "depth.anchoring_min",
      a: { value: 2.5, factIds: ["fact-b"] },
      b: { value: 3, factIds: ["fact-a"] },
      others: [{ value: 3.5, factIds: ["fact-c"] }],
    });
    expect(bathymetryRule([...inputs].reverse(), depthCtx)).toEqual(forward);
  });

  it("an older review is a strong correction: a newer computation keeps it, a newer shallower text wins with a conflict", () => {
    const rev = review({ value: 3.0, observedAt: "2025-01-01", confidence: 0.5 });
    expect(bathymetryRule([rev, c(4.0, { confidence: 0.6, observedAt: "2026-10-19" })], depthCtx)).toMatchObject({
      value: 3,
      origin: "review",
      confidence: 0.95,
      conflict: null,
    });
    const deeper = bathymetryRule([rev, c(4.0), t(5.0, { confidence: 0.9, observedAt: "2026-06-01" })], depthCtx)!;
    expect(deeper).toMatchObject({ value: 3, origin: "review" });
    expect(deeper.conflict).not.toBeNull();
    expect(bathymetryRule([rev, c(4.0), t(2.0, { confidence: 0.9, observedAt: "2026-06-01" })], depthCtx)).toMatchObject({
      value: 2,
      origin: "text",
    });
  });

  it("equal weights on a non-numeric value: the tie goes to the larger id, independent of input order", () => {
    const sand = [{ type: "sand", share: 1 }];
    const mud = [{ type: "mud", share: 1 }];
    const inputs = [
      t(sand, { confidence: 0.9, observedAt: "2026-05-01", sourceKey: "source:a", factId: "fact-1" }),
      t(mud, { confidence: 0.9, observedAt: "2026-05-01", sourceKey: "source:b", factId: "fact-2" }),
    ];
    const seabedCtx = ruleCtx({ attribute: "seabed" });
    expect(bathymetryRule(inputs, seabedCtx)).toMatchObject({ value: mud, origin: "text", conflict: null });
    expect(bathymetryRule([...inputs].reverse(), seabedCtx)!.value).toEqual(mud);
  });

  it("contradicting weak depth texts over a weak or missing raster: the shallower value with a conflict note (GR-6, SAF-6)", () => {
    const shallow = t(2.5, { confidence: 0.75, sourceKey: "source:a", factId: "fact-a" });
    const deep = t(8, { confidence: 0.78, sourceKey: "source:b", factId: "fact-b" });
    for (const inputs of [[shallow, deep], [c(6, { confidence: 0.3 }), shallow, deep]]) {
      const r = bathymetryRule(inputs, depthCtx)!;
      expect(r).toMatchObject({ value: 2.5, origin: "text" });
      expect(r.conflict).toMatchObject({ attribute: depthCtx.attribute, a: { value: 2.5 }, b: { value: 8 } });
      expect(bathymetryRule([...inputs].reverse(), depthCtx)).toEqual(r);
    }
    // one weak text: it holds, no conflict; a good raster still wins over weak texts (spec 07)
    expect(bathymetryRule([c(6, { confidence: 0.3 }), deep], depthCtx)).toMatchObject({ value: 8, conflict: null });
    expect(bathymetryRule([c(6, { confidence: 0.6 }), shallow, deep], depthCtx)).toMatchObject({ value: 6, origin: "computed", conflict: null });
  });

  it("enum-like values (seabed) pass unchanged; no input no value", () => {
    const seabed = [{ type: "sand", share: 1 }];
    expect(bathymetryRule([c(seabed, { confidence: 0.6 })], ruleCtx({ attribute: "seabed" }))!.value).toEqual(seabed);
    expect(bathymetryRule([], depthCtx)).toBeNull();
  });
});

describe("computedOnlyRule and reviewOverComputedRule", () => {
  const pos = (lon: number) => ({ lon, lat: 37.5 });

  it("computed only takes the youngest computation and ignores texts", () => {
    expect(computedOnlyRule([c(10, { observedAt: "2025-01-01" }), c(12, { observedAt: "2026-01-01" }), t(99)], ruleCtx({ attribute: "anchor_area" })))
      .toMatchObject({ value: 12, origin: "computed" });
    expect(computedOnlyRule([t(99)], ruleCtx({ attribute: "anchor_area" }))).toBeNull();
  });

  it("review anchor beats computed anchor", () => {
    const actx = ruleCtx({ attribute: "anchor_position" });
    expect(reviewOverComputedRule([c(pos(23.1234567), { observedAt: "2026-10-19" }), review({ value: pos(23.2), observedAt: "2025-01-01" })], actx))
      .toMatchObject({ value: pos(23.2), origin: "review", confidence: 0.95 });
    expect(reviewOverComputedRule([c(pos(23.1)), t(pos(23.3), { origin: "observed", observedAt: "2025-01-01" })], actx)).toMatchObject({
      value: pos(23.3),
      origin: "observed",
    });
    // coordinates keep their digits
    expect(reviewOverComputedRule([c(pos(23.1234567))], actx)).toMatchObject({ value: pos(23.1234567), origin: "computed" });
    expect(reviewOverComputedRule([], actx)).toBeNull();
  });

  it("the youngest review wins among reviews", () => {
    const actx = ruleCtx({ attribute: "anchor_position" });
    expect(
      reviewOverComputedRule([review({ value: pos(23.2), observedAt: "2025-01-01" }), review({ value: pos(23.4), observedAt: "2026-01-01" })], actx)!.value,
    ).toEqual(pos(23.4));
  });
});

describe("test fixtures", () => {
  it("ids restart in every test (first)", () => {
    expect([text().factId, computed().computationId]).toEqual(["fact-0001", "comp-0003"]);
  });

  it("ids restart in every test (second)", () => {
    expect([text().factId, computed().computationId]).toEqual(["fact-0001", "comp-0003"]);
  });
});
