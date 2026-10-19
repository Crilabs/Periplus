import { canonicalJson } from "@/lib/domain/facts/schema";
import type { ConsolidationInput, InputOrigin, RuleContext, RuleResult } from "../types";
import { attributeConfidence, roundValue, sortInputs } from "../weights";

/**
 * A rule result without conflict: the value rounded, confidence over the support (the second-source bonus only from
 * `confirming`, default the support), `observedAt` its youngest date. The support is sorted by input id (ruling
 * M5-C-R2 M-5), so support and fact ids do not depend on the input order.
 */
export function ruleResult(
  value: unknown,
  origin: InputOrigin,
  support: ConsolidationInput[],
  ctx: RuleContext,
  confirming: ConsolidationInput[] = support,
): RuleResult {
  const observedAt = support.reduce<string | null>((max, i) => (max === null || i.observedAt > max ? i.observedAt : max), null);
  return {
    value: roundValue(value, ctx.cfg),
    origin,
    confidence: attributeConfidence(support, ctx, origin, confirming),
    observedAt,
    support: sortInputs(support),
    conflict: null,
  };
}

/** The inputs among `inputs` carrying the same value as `chosen` (it confirms the value), `chosen` first. */
export function sameValue(chosen: ConsolidationInput, inputs: ConsolidationInput[]): ConsolidationInput[] {
  const key = canonicalJson(chosen.value);
  return [chosen, ...inputs.filter((i) => i !== chosen && canonicalJson(i.value) === key)];
}
