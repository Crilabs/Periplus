import type { ConsolidationInput, ConsolidationRule, RuleContext, RuleName, RuleResult } from "../types";
import { roundValue, youngest } from "../weights";
import { areaWeightedRule } from "./area-weighted";
import { bathymetryRule } from "./bathymetry";
import { computedOnlyRule } from "./computed-only";
import { defaultRule } from "./default";
import { highlightRule } from "./highlight";
import { holdingRule } from "./holding";
import { latestObservationRule } from "./latest-observation";
import { occupancyRule } from "./occupancy";
import { prohibitionsRule } from "./prohibitions";
import { reviewOverComputedRule } from "./review-over-computed";
import { shelterRule } from "./shelter";
import { swellProtectionRule } from "./swell-protection";
import { unionRule } from "./union";

/** Every consolidation rule by the name the fact schema's `rule` field gives it. */
export const RULES: Record<RuleName, ConsolidationRule> = {
  shelter: shelterRule,
  swell_protection: swellProtectionRule,
  bathymetry: bathymetryRule,
  holding: holdingRule,
  latest_observation: latestObservationRule,
  highlight: highlightRule,
  occupancy: occupancyRule,
  prohibitions: prohibitionsRule,
  area_weighted: areaWeightedRule,
  union: unionRule,
  default: defaultRule,
  computed_only: computedOnlyRule,
  review_over_computed: reviewOverComputedRule,
};

/** True for a name `RULES` implements. */
export function isRuleName(name: string): name is RuleName {
  return Object.hasOwn(RULES, name);
}

/**
 * Applies the rule `rule`. Empty inputs still go through the rule (a harbour's shelter floor). When the youngest
 * review decision is not older than every other input, its value holds (origin `review`, confidence
 * `confidence.review`, no conflict); otherwise the rule decides, with the review as a non-ageing correction input that
 * supersedes the texts it saw (ruling M5-B-R3).
 */
export function applyRule(rule: RuleName, inputs: ConsolidationInput[], ctx: RuleContext): RuleResult | null {
  const decision = youngest(inputs.filter((i) => i.origin === "review"));
  if (decision && inputs.every((i) => i === decision || i.observedAt <= decision.observedAt)) {
    return {
      value: roundValue(decision.value, ctx.cfg),
      origin: "review",
      confidence: ctx.cfg.confidence.review,
      observedAt: decision.observedAt,
      support: [decision],
      conflict: null,
    };
  }
  return RULES[rule](inputs, ctx);
}
