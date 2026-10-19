import type { ConsolidationRule } from "../types";
import { afterReview, pickDiscrete, strongest } from "../weights";
import { ruleResult } from "./result";

/**
 * `services.*`, `mooring.buoys`, `exists`, `dinghy_access` (spec 07): the youngest observation wins, in the same season
 * year the stronger value (a time course 2019 yes / 2024 no is a change, no conflict); `observedAt` = the newest date of
 * the picked value. Inputs a younger review decision saw drop out behind it.
 */
export const latestObservationRule: ConsolidationRule = (inputs, ctx) => {
  const live = afterReview(inputs);
  if (live.length === 0) return null;
  const { group, conflict } = pickDiscrete(live, ctx);
  const lead = strongest(group.inputs, ctx)!;
  return { ...ruleResult(group.value, lead.origin, group.inputs, ctx), observedAt: group.to, conflict };
};
