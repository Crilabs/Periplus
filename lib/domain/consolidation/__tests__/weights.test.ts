import { describe, expect, it } from "vitest";
import { computed, review, ruleCtx, text } from "@/test/fixtures/consolidation/scenarios";
import {
  attributeConfidence,
  classMidpoint,
  confidenceClass,
  independentCount,
  inputWeight,
  lowerClass,
  pickDiscrete,
  recency,
  roundTo,
  valueGroups,
} from "../weights";

const ctx = ruleCtx({ today: "2026-10-19", attribute: "mooring.buoys" });
const { cfg } = ctx;

describe("recency and weights", () => {
  it("recency halves every three years", () => {
    expect(recency("2023-10-19", "2026-10-19", 3)).toBeCloseTo(0.5, 3);
    expect(recency("2020-10-19", "2026-10-19", 3)).toBeCloseTo(0.25, 3);
    expect(recency("2026-10-19", "2026-10-19", 3)).toBe(1);
    expect(recency("2027-01-01", "2026-10-19", 3)).toBe(1);
  });

  it("input weight = source weight × confidence × recency, recency only for text and observations", () => {
    expect(inputWeight(text({ sourceWeight: 0.6, confidence: 0.5 }), ctx)).toBeCloseTo(0.3, 9);
    expect(inputWeight(text({ sourceWeight: 1, confidence: 1, observedAt: "2023-10-19" }), ctx)).toBeCloseTo(0.5, 3);
    expect(inputWeight(text({ origin: "observed", sourceWeight: 1, confidence: 1, observedAt: "2023-10-19" }), ctx)).toBeCloseTo(0.5, 3);
    expect(inputWeight(computed({ confidence: 0.6, observedAt: "2016-01-01" }), ctx)).toBeCloseTo(0.6, 9);
    expect(inputWeight(review({ confidence: 0.95, observedAt: "2016-01-01" }), ctx)).toBeCloseTo(0.95, 9);
    // a review enters with confidence.review (0.95), whatever its stored confidence
    expect(inputWeight(review({ confidence: 0.5, observedAt: "2016-01-01" }), ctx)).toBeCloseTo(0.95, 9);
  });

  it("two documents of one source count once", () => {
    expect(independentCount([text({ sourceKey: "source:a" }), text({ sourceKey: "source:a" }), text({ sourceKey: "source:b" })])).toBe(2);
    expect(independentCount([])).toBe(0);
  });

  it("rounds to the precision", () => {
    expect(roundTo(0.1 + 0.2, 3)).toBe(0.3);
    expect(roundTo(0.6305, 3)).toBe(0.631);
    expect(roundTo(4, 3)).toBe(4);
  });
});

describe("attribute confidence", () => {
  it("confidence: text 0.8 × weight 0.6, second source +0.15, cap 0.95", () => {
    expect(attributeConfidence([text({ confidence: 0.8, sourceWeight: 0.6, observedAt: "2026-10-19" })], ctx)).toBe(0.48);
    expect(
      attributeConfidence(
        [
          text({ confidence: 0.8, sourceWeight: 0.6, sourceKey: "source:a", observedAt: "2026-10-19" }),
          text({ confidence: 0.5, sourceWeight: 0.6, sourceKey: "source:b", observedAt: "2026-10-19" }),
        ],
        ctx,
      ),
    ).toBe(0.63);
    expect(attributeConfidence([review(), text({ sourceKey: "source:b" })], ctx)).toBe(0.95);
  });

  it("a second document of the same source gives no bonus", () => {
    expect(
      attributeConfidence(
        [text({ confidence: 0.8, sourceWeight: 0.6 }), text({ confidence: 0.5, sourceWeight: 0.6, sourceKey: "source:a" })],
        ctx,
      ),
    ).toBe(0.48);
  });

  it("text confidence ages with the youngest text; computed confidence does not age", () => {
    expect(attributeConfidence([text({ confidence: 1, sourceWeight: 0.8, observedAt: "2023-10-19" })], ctx)).toBe(0.4);
    expect(attributeConfidence([computed({ confidence: 0.6, observedAt: "2016-01-01" })], ctx)).toBe(0.6);
    // computed base from a computation: the old text in the support does not age it
    expect(attributeConfidence([computed({ confidence: 0.7 }), text({ confidence: 0.5, sourceWeight: 0.6, observedAt: "2016-01-01" })], ctx, "computed")).toBe(0.85);
    // the value comes from the text: aged with the youngest text
    expect(attributeConfidence([computed({ confidence: 0.6 }), text({ confidence: 1, sourceWeight: 0.8, observedAt: "2023-10-19" })], ctx, "text")).toBe(0.475);
  });

  it("no support has confidence 0", () => {
    expect(attributeConfidence([], ctx)).toBe(0);
  });
});

describe("confidence classes", () => {
  it("classes by minimum, one class lower, midpoints", () => {
    expect(confidenceClass(0.95, cfg)).toBe("high");
    expect(confidenceClass(0.7, cfg)).toBe("high");
    expect(confidenceClass(0.699, cfg)).toBe("medium");
    expect(confidenceClass(0.4, cfg)).toBe("medium");
    expect(confidenceClass(0.1, cfg)).toBe("low");
    expect(confidenceClass(0, cfg)).toBe("low");
    expect(lowerClass("high")).toBe("medium");
    expect(lowerClass("medium")).toBe("low");
    expect(lowerClass("low")).toBe("low");
    expect(classMidpoint("high", cfg)).toBe(0.85);
    expect(classMidpoint("medium", cfg)).toBe(0.55);
    expect(classMidpoint("low", cfg)).toBe(0.2);
  });
});

describe("value groups and the discrete pick", () => {
  const yes = (over: Parameters<typeof text>[0] = {}) => text({ value: true, confidence: 1, ...over });
  const no = (over: Parameters<typeof text>[0] = {}) => text({ value: false, confidence: 1, ...over });

  it("groups by canonical value, weight = strongest input per source, sorted by weight then key", () => {
    const groups = valueGroups(
      [
        text({ value: { a: 1, b: 2 }, sourceKey: "source:a", sourceWeight: 0.5, confidence: 1, observedAt: "2024-05-01" }),
        text({ value: { b: 2, a: 1 }, sourceKey: "source:a", sourceWeight: 0.4, confidence: 1, observedAt: "2026-06-01" }),
        text({ value: { b: 2, a: 1 }, sourceKey: "source:b", sourceWeight: 0.3, confidence: 1, observedAt: "2026-06-01" }),
        text({ value: "x", sourceKey: "source:c", sourceWeight: 0.9, confidence: 1, observedAt: ctx.today, dateKnown: false }),
      ],
      ctx,
    );
    expect(groups.map((g) => g.key)).toEqual(['"x"', '{"a":1,"b":2}']);
    expect(groups[0]).toMatchObject({ weight: 0.9, allDatesKnown: false, years: [2026] });
    // source:a counts its strongest input once, plus source:b
    const june = recency("2026-06-01", ctx.today, 3);
    expect(groups[1].weight).toBeCloseTo(Math.max(0.5 * recency("2024-05-01", ctx.today, 3), 0.4 * june) + 0.3 * june, 9);
    expect(groups[1]).toMatchObject({ from: "2024-05-01", to: "2026-06-01", years: [2024, 2026], allDatesKnown: true });
    expect(groups[1].inputs).toHaveLength(3);
  });

  it("duplicated mentions of one source do not add weight (ruling M5-P4)", () => {
    const one = valueGroups([yes({ sourceWeight: 0.6 })], ctx);
    const twice = valueGroups([yes({ sourceWeight: 0.6 }), yes({ sourceWeight: 0.6 })], ctx);
    expect(twice[0].weight).toBe(one[0].weight);
  });

  it("one group is picked without conflict", () => {
    const r = pickDiscrete([yes(), yes({ sourceKey: "source:b" })], ctx);
    expect(r.group.value).toBe(true);
    expect(r.conflict).toBeNull();
  });

  it("a time course 2019 → 2024 picks 2024 without conflict", () => {
    const r = pickDiscrete(
      [yes({ observedAt: "2019-07-01", sourceWeight: 0.9 }), yes({ observedAt: "2019-08-01", sourceKey: "source:b", sourceWeight: 0.9 }), no({ observedAt: "2024-07-01", sourceKey: "source:c", sourceWeight: 0.4 })],
      ctx,
    );
    expect(r.group.value).toBe(false);
    expect(r.conflict).toBeNull();
  });

  it("the time course can be switched off", () => {
    const r = pickDiscrete(
      [yes({ observedAt: "2019-07-01", sourceWeight: 0.9 }), no({ observedAt: "2024-07-01", sourceKey: "source:c", sourceWeight: 0.2 })],
      ctx,
      { timeCourse: false },
    );
    expect(r.group.value).toBe(true);
  });

  it("same season year with weights 1.0 vs 0.7 is a conflict, 1.0 vs 0.6 is not", () => {
    // same observation date: both age alike, the ratio is the ratio of the source weights
    const date = "2026-07-15";
    const r = recency(date, ctx.today, 3);
    const a = yes({ observedAt: date, sourceWeight: 1 });
    const conflicting = pickDiscrete([a, no({ observedAt: date, sourceKey: "source:b", sourceWeight: 0.7 })], ctx);
    expect(conflicting.group.value).toBe(true);
    expect(conflicting.conflict).toMatchObject({
      attribute: "mooring.buoys",
      a: { value: true, weight: roundTo(r, 3), sourceKeys: ["source:a"], observedFrom: date, observedTo: date },
      b: { value: false, weight: roundTo(0.7 * r, 3), sourceKeys: ["source:b"], observedFrom: date, observedTo: date },
    });
    expect(conflicting.conflict!.key).toMatch(/^[0-9a-f]{16}$/);
    expect(conflicting.conflict!.a.factIds).toEqual([a.factId]);

    const clear = pickDiscrete([a, no({ observedAt: date, sourceKey: "source:b", sourceWeight: 0.6 })], ctx);
    expect(clear.group.value).toBe(true);
    expect(clear.conflict).toBeNull();
  });

  it("the conflict key is over the two value groups: another fact on either side or swapped sides keep it (M5-B-R2)", () => {
    const date = "2026-07-15";
    const a = yes({ observedAt: date, sourceWeight: 1 });
    const b = no({ observedAt: date, sourceKey: "source:b", sourceWeight: 0.8 });
    const key = pickDiscrete([a, b], ctx).conflict!.key;
    const moreYes = pickDiscrete([a, b, yes({ observedAt: date, sourceKey: "source:c", sourceWeight: 0.1 })], ctx).conflict!;
    const moreNo = pickDiscrete([a, b, no({ observedAt: date, sourceKey: "source:d", sourceWeight: 0.15 })], ctx).conflict!;
    expect(moreYes.key).toBe(key);
    expect(moreNo.key).toBe(key);
    // b heavier than a: the sides swap, the key stays
    const swapped = pickDiscrete([a, no({ observedAt: date, sourceKey: "source:b", sourceWeight: 0.9 }), no({ observedAt: date, sourceKey: "source:e", sourceWeight: 0.2 })], ctx).conflict!;
    expect(swapped.a.value).toBe(false);
    expect(swapped.key).toBe(key);
    // another attribute with the same values has another key
    expect(pickDiscrete([a, b], { ...ctx, attribute: "services.water" }).conflict!.key).not.toBe(key);
  });

  it("an unknown date (dateKnown false) never counts as time course", () => {
    const later = no({ observedAt: "2026-07-01", sourceKey: "source:b", sourceWeight: 0.6 });
    const unknown = pickDiscrete([yes({ observedAt: "2025-07-01", sourceWeight: 1, dateKnown: false }), later], ctx);
    expect(unknown.group.value).toBe(true);
    expect(unknown.conflict).not.toBeNull();
    // the same inputs with a known date form a time course
    expect(pickDiscrete([yes({ observedAt: "2025-07-01", sourceWeight: 1 }), later], ctx).group.value).toBe(false);
  });

  it("overlapping years are no time course", () => {
    const r = pickDiscrete(
      [
        yes({ observedAt: "2024-03-01", sourceWeight: 1 }),
        yes({ observedAt: "2026-07-01", sourceKey: "source:c", sourceWeight: 0.1 }),
        no({ observedAt: "2026-08-01", sourceKey: "source:b", sourceWeight: 0.5 }),
      ],
      ctx,
    );
    expect(r.group.value).toBe(true);
  });

  it("the conflict key does not depend on input order", () => {
    const inputs = [
      yes({ sourceWeight: 1 }),
      yes({ sourceKey: "source:c", sourceWeight: 0.2 }),
      no({ sourceKey: "source:b", sourceWeight: 0.9 }),
      computed({ value: false, sourceKey: "computed", confidence: 0.1 }),
    ];
    const forward = pickDiscrete(inputs, ctx).conflict;
    const backward = pickDiscrete([...inputs].reverse(), ctx).conflict;
    expect(forward).not.toBeNull();
    expect(backward).toEqual(forward);
  });

  it("a third value group is recorded in the conflict note", () => {
    const r = pickDiscrete(
      [yes({ sourceWeight: 1 }), no({ sourceKey: "source:b", sourceWeight: 0.9 }), text({ value: "seasonal", confidence: 1, sourceKey: "source:c", sourceWeight: 0.8 })],
      ctx,
    );
    expect(r.conflict).toMatchObject({ a: { value: true }, b: { value: false }, others: [{ value: "seasonal", sourceKeys: ["source:c"] }] });
    expect(pickDiscrete([yes(), no({ sourceKey: "source:b", sourceWeight: 0.9 })], ctx).conflict!.others).toEqual([]);
  });

  it("an empty input list is an error", () => {
    expect(() => pickDiscrete([], ctx)).toThrow();
  });
});
