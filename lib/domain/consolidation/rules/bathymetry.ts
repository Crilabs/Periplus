import type { ConsolidationInput, ConsolidationRule, RuleContext, RuleResult } from "../types";
import { conflictNote, corrections, inputConfidence, strongest, valueGroups, youngest } from "../weights";
import { ruleResult, sameValue } from "./result";

/**
 * `depth.*`, `seabed` (spec 07): bathymetry; a correction (text, observation or review decision, the review with
 * `confidence.review`) overrides only with confidence > `textMinConfidence`. A weak raster (confidence <
 * `weakRasterConfidence`) yields to any correction.
 */
export const bathymetryRule: ConsolidationRule = (inputs, ctx) => {
  const p = ctx.cfg.rules.bathymetry;
  const texts = corrections(inputs);
  const strong = texts.filter((i) => inputConfidence(i, ctx.cfg) > p.textMinConfidence);
  if (strong.length > 0) return strongCorrection(strong, ctx);
  const raster = youngest(inputs.filter((i) => i.origin === "computed"));
  if (raster && raster.confidence >= p.weakRasterConfidence) return ruleResult(raster.value, "computed", [raster], ctx);
  const anyText = strongest(texts, ctx);
  if (anyText) return ruleResult(anyText.value, anyText.origin, sameValue(anyText, texts), ctx);
  return raster ? ruleResult(raster.value, "computed", [raster], ctx) : null;
};

/**
 * The strong corrections decide. Contradicting numeric values (depths): the shallower value wins for safety (ruling
 * M5-B-R2) with a conflict note against the heaviest other value; otherwise the heaviest input (ties to the youngest).
 */
function strongCorrection(strong: ConsolidationInput[], ctx: RuleContext): RuleResult {
  const groups = valueGroups(strong, ctx);
  if (groups.length < 2 || !groups.every((g) => typeof g.value === "number")) {
    const chosen = strongest(strong, ctx)!;
    return ruleResult(chosen.value, chosen.origin, sameValue(chosen, strong), ctx);
  }
  const shallow = groups.reduce((a, g) => ((g.value as number) < (a.value as number) ? g : a));
  const chosen = strongest(shallow.inputs, ctx)!;
  const result = ruleResult(chosen.value, chosen.origin, sameValue(chosen, shallow.inputs), ctx);
  return { ...result, conflict: conflictNote(ctx.attribute, shallow, groups.filter((g) => g !== shallow), ctx.cfg) };
}
