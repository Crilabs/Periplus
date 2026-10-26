import type { ConsolidationRule } from "./types";
import { afterReview, attributeIn, pickDiscrete, strongest } from "./weights";
import { fillFields, pickPresence } from "./presence";
import { ruleResult } from "./result";

/**
 * `services.*`, `mooring.buoys`, `exists`, `dinghy_access` (spec 07): the youngest observation wins, in the same month
 * the stronger value (a time course 2019 yes / 2024 no, or June yes / August no, is a change, no conflict; ruling
 * M5-C-R1 (3)); `observedAt` = the newest date of the picked value. Inputs a younger review decision saw drop out
 * behind it. Attributes of `rules.latest_observation.presence` (`mooring.buoys`, ruling M5-C-R2 I-1) are picked on
 * `present` alone, like `highlight`; their other fields (`count`, `paid`) come from the strongest input of the picked
 * group carrying them, so sources agreeing on presence never conflict and no field is lost.
 */
export const latestObservationRule: ConsolidationRule = (inputs, ctx) => {
  const live = afterReview(inputs);
  if (live.length === 0) return null;
  if (attributeIn(ctx.attribute, ctx.cfg.rules.latest_observation.presence)) {
    const complete = (present: boolean, group: typeof live) => fillFields(present, group, ctx);
    const pick = pickPresence(live, ctx, complete);
    const lead = strongest(pick.inputs, ctx)!;
    const value = complete(pick.present, pick.inputs);
    return { ...ruleResult(value, lead.origin, pick.inputs, ctx), observedAt: pick.observedAt, conflict: pick.conflict };
  }
  const { group, conflict } = pickDiscrete(live, ctx, { granularity: "month" });
  const lead = strongest(group.inputs, ctx)!;
  return { ...ruleResult(group.value, lead.origin, group.inputs, ctx), observedAt: group.to, conflict };
};
