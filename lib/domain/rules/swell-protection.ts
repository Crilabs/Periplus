import type { ConsolidationRule } from "./types";
import { corrections, inputConfidence, strongest, youngest } from "./weights";
import { ruleResult, sameValue } from "./result";

/**
 * `swell_protection` (spec 07): text before computation when a correction (text, observation or review decision, the
 * review with `confidence.review`) with confidence ≥ `textMinConfidence` exists — the heaviest of them; otherwise the
 * youngest computation; otherwise the heaviest correction.
 */
export const swellProtectionRule: ConsolidationRule = (inputs, ctx) => {
  const texts = corrections(inputs);
  const good = texts.filter((i) => inputConfidence(i, ctx.cfg) >= ctx.cfg.rules.swell_protection.textMinConfidence);
  const strongText = strongest(good, ctx);
  if (strongText) return ruleResult(strongText.value, strongText.origin, sameValue(strongText, good), ctx);
  const basis = youngest(inputs.filter((i) => i.origin === "computed"));
  if (basis) return ruleResult(basis.value, "computed", [basis], ctx);
  const anyText = strongest(texts, ctx);
  return anyText ? ruleResult(anyText.value, anyText.origin, sameValue(anyText, texts), ctx) : null;
};
