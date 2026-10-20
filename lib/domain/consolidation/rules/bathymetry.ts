import type { ConsolidationInput, ConsolidationRule, RuleContext, RuleResult } from "../types";
import { conflictNote, corrections, inputConfidence, strongest, valueGroups, youngest } from "../weights";
import { ruleResult, sameValue } from "./result";

/**
 * `depth.*`, `seabed` (spec 07): bathymetry; a correction (text, observation or review decision, the review with
 * `confidence.review`) overrides only with confidence > `textMinConfidence`. A weak raster (confidence <
 * `weakRasterConfidence`) yields to any correction. Corrections that contradict each other on a number give the
 * shallower value with a conflict note, the strong ones over a raster and the weak ones over a weak or missing raster
 * alike, also on a first profile (ruling M5-B-R2, GR-6).
 */
export const bathymetryRule: ConsolidationRule = (inputs, ctx) => {
  const p = ctx.cfg.rules.bathymetry;
  const texts = corrections(inputs);
  const strong = texts.filter((i) => inputConfidence(i, ctx.cfg) > p.textMinConfidence);
  if (strong.length > 0) return correction(strong, ctx);
  const raster = youngest(inputs.filter((i) => i.origin === "computed"));
  if (raster && raster.confidence >= p.weakRasterConfidence) return ruleResult(raster.value, "computed", [raster], ctx);
  if (texts.length > 0) return correction(texts, ctx);
  return raster ? ruleResult(raster.value, "computed", [raster], ctx) : null;
};

/**
 * The corrections decide. Contradicting numeric values (depths): the shallower value wins for safety (ruling M5-B-R2,
 * GR-6) with a conflict note against the heaviest other value; otherwise the heaviest input (ties to the youngest).
 */
function correction(strong: ConsolidationInput[], ctx: RuleContext): RuleResult {
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
