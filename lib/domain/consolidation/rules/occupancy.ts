import type { ConsolidationInput, ConsolidationRule } from "../types";
import { afterReview, strongest, valueGroups } from "../weights";
import { ruleResult } from "./result";

export const OCCUPANCY_MONTHS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] as const;
export type OccupancyLevel = "empty" | "moderate" | "full" | "unknown";

/**
 * `occupancy` (spec 07): all twelve months; per month the weighted majority of the inputs naming that month (one input
 * per source and level, ruling M5-P4; ties by level name), a month without data `unknown`. Never a conflict.
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
    const [top] = valueGroups(naming, ctx);
    value[month] = top.value as OccupancyLevel;
    for (const m of top.inputs) support.add(back.get(m)!);
  }
  const list = [...support];
  if (list.length === 0) return null;
  const lead = strongest(list, ctx)!;
  return ruleResult(value, lead.origin, list, ctx);
};
