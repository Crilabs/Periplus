import type { ConsolidationInput, ConsolidationRule, RuleContext } from "../types";
import { afterReview, roundTo, strongest, type ValueGroup, valueGroups } from "../weights";
import { ruleResult } from "./result";

export const OCCUPANCY_MONTHS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] as const;
export type OccupancyLevel = "empty" | "moderate" | "full" | "unknown";

/** Levels from the fullest: a tie goes to the fuller level (the conservative choice for `quietness`). */
const FULLEST_FIRST: readonly string[] = ["full", "moderate", "empty"];

/** Among the groups of the largest weight (at profile precision), the fullest level (ruling M5-C-R2 M-6). */
function fullestOfHeaviest(groups: ValueGroup[], ctx: RuleContext): ValueGroup {
  const top = roundTo(groups[0].weight, ctx.cfg.precision);
  const tied = groups.filter((g) => roundTo(g.weight, ctx.cfg.precision) === top);
  return tied.reduce((best, g) => (FULLEST_FIRST.indexOf(g.value as string) < FULLEST_FIRST.indexOf(best.value as string) ? g : best));
}

/**
 * `occupancy` (spec 07): all twelve months; per month the weighted majority of the inputs naming that month (one input
 * per source and level, ruling M5-P4; a tie goes to the fuller level), a month without data `unknown`. Never a conflict.
 */
export const occupancyRule: ConsolidationRule = (inputs, ctx) => {
  const live = afterReview(inputs);
  if (live.length === 0) return null;
  const value = {} as Record<(typeof OCCUPANCY_MONTHS)[number], OccupancyLevel>;
  const support = new Set<ConsolidationInput>();
  for (const month of OCCUPANCY_MONTHS) {
    const naming: ConsolidationInput[] = [];
    const back = new Map<ConsolidationInput, ConsolidationInput>();
    for (const i of live) {
      const level = (i.value as Partial<Record<string, string>>)[month];
      if (level === undefined) continue;
      const m = { ...i, value: level };
      back.set(m, i);
      naming.push(m);
    }
    if (naming.length === 0) {
      value[month] = "unknown";
      continue;
    }
    const top = fullestOfHeaviest(valueGroups(naming, ctx), ctx);
    value[month] = top.value as OccupancyLevel;
    for (const m of top.inputs) support.add(back.get(m)!);
  }
  const list = [...support];
  if (list.length === 0) return null;
  const lead = strongest(list, ctx)!;
  return ruleResult(value, lead.origin, list, ctx);
};
