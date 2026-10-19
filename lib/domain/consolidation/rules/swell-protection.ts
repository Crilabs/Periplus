import type { ConsolidationRule } from "../types";
import { isTextual, strongest, youngest } from "../weights";
import { ruleResult, sameValue } from "./result";

/**
 * `swell_protection` (spec 07): text before computation when a text (or observation) with confidence ≥
 * `textMinConfidence` exists — the heaviest of them; otherwise the youngest computation; otherwise the heaviest text.
 */
export const swellProtectionRule: ConsolidationRule = (inputs, ctx) => {
  const texts = inputs.filter((i) => isTextual(i.origin));
  const good = texts.filter((i) => i.confidence >= ctx.cfg.rules.swell_protection.textMinConfidence);
  const strongText = strongest(good, ctx);
  if (strongText) return ruleResult(strongText.value, strongText.origin, sameValue(strongText, good), ctx);
  const basis = youngest(inputs.filter((i) => i.origin === "computed"));
  if (basis) return ruleResult(basis.value, "computed", [basis], ctx);
  const anyText = strongest(texts, ctx);
  return anyText ? ruleResult(anyText.value, anyText.origin, sameValue(anyText, texts), ctx) : null;
};
