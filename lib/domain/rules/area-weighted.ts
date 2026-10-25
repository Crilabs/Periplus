import { canonicalJson } from "@/lib/domain/facts/schema";
import type { ConsolidationInput, ConsolidationRule } from "./types";
import { afterReview, inputWeight, pickDiscrete, roundTo, strongest } from "./weights";
import { ruleResult } from "./result";
import { unite } from "./union";

/**
 * Area and island facts (spec 07 "Revier-Facts"): numbers → mean weighted by `inputWeight`, one input per
 * (source, value) (ruling M5-P4), summed in a fixed order, rounded; the second-source bonus only from inputs closer
 * than `rules.area_weighted.agreeWithin` to the mean (half a step of the exposure scale: the same scale word). Enums
 * and other values → weighted majority without time course; lists → united by their canonical element (list
 * attributes normally use `union`, ruling M5-P3).
 */
export const areaWeightedRule: ConsolidationRule = (inputs, ctx) => {
  const live = afterReview(inputs);
  if (live.length === 0) return null;

  if (live.every((i) => typeof i.value === "number")) {
    const perPair = new Map<string, { input: ConsolidationInput; weight: number }>();
    for (const i of live) {
      const key = `${i.sourceKey}\u0000${canonicalJson(i.value)}`;
      const w = inputWeight(i, ctx);
      const prev = perPair.get(key);
      if (!prev || w > prev.weight) perPair.set(key, { input: i, weight: w });
    }
    // summed in key order: floating-point sums must not depend on the input order (ruling M5-C-R2 M-8)
    const pairs = [...perPair.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, p]) => p);
    const total = pairs.reduce((s, p) => s + p.weight, 0);
    const mean =
      total > 0
        ? pairs.reduce((s, p) => s + (p.input.value as number) * p.weight, 0) / total
        : pairs.reduce((s, p) => s + (p.input.value as number), 0) / pairs.length;
    // only inputs within `agreeWithin` of the mean confirm it (ruling M5-C-R1 (4), like M5-B-R2)
    const agree = ctx.cfg.rules.area_weighted.agreeWithin;
    const confirming = live.filter((i) => roundTo(Math.abs((i.value as number) - mean), ctx.cfg.precision) < agree);
    const lead = strongest(live, ctx)!;
    return ruleResult(mean, lead.origin, live, ctx, confirming);
  }

  if (live.every((i) => Array.isArray(i.value))) return unite(live, (entry) => canonicalJson(entry), ctx);

  const { group, conflict } = pickDiscrete(live, ctx, { timeCourse: false });
  const lead = strongest(group.inputs, ctx)!;
  return { ...ruleResult(group.value, lead.origin, group.inputs, ctx), conflict };
};
