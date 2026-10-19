import type { ConsolidationRule } from "../types";
import { afterReview, inputConfidence, pickDiscrete, strongest, valueGroups } from "../weights";
import { ruleResult } from "./result";

/**
 * Standard rule (spec 07): the youngest observation among the inputs with confidence ≥ `latestMinConfidence`
 * (`pickDiscrete`, conflicts included); without such an input the heaviest value group of all inputs, without conflict.
 */
export const defaultRule: ConsolidationRule = (inputs, ctx) => {
  const live = afterReview(inputs);
  if (live.length === 0) return null;
  const eligible = live.filter((i) => inputConfidence(i, ctx.cfg) >= ctx.cfg.rules.default.latestMinConfidence);
  if (eligible.length > 0) {
    const { group, conflict } = pickDiscrete(eligible, ctx);
    const lead = strongest(group.inputs, ctx)!;
    return { ...ruleResult(group.value, lead.origin, group.inputs, ctx), conflict };
  }
  const [group] = valueGroups(live, ctx);
  const lead = strongest(group.inputs, ctx)!;
  return ruleResult(group.value, lead.origin, group.inputs, ctx);
};
