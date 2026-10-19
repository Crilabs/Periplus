import type { ConsolidationRule } from "../types";
import { isTextual, strongest, youngest } from "../weights";
import { ruleResult, sameValue } from "./result";

/**
 * `depth.*`, `seabed` (spec 07): bathymetry; a text corrects only with confidence > `textMinConfidence` (the heaviest,
 * ties to the youngest). A weak raster (confidence < `weakRasterConfidence`) yields to any text.
 */
export const bathymetryRule: ConsolidationRule = (inputs, ctx) => {
  const p = ctx.cfg.rules.bathymetry;
  const texts = inputs.filter((i) => isTextual(i.origin));
  const strong = texts.filter((i) => i.confidence > p.textMinConfidence);
  const strongText = strongest(strong, ctx);
  if (strongText) return ruleResult(strongText.value, strongText.origin, sameValue(strongText, strong), ctx);
  const raster = youngest(inputs.filter((i) => i.origin === "computed"));
  if (raster && raster.confidence >= p.weakRasterConfidence) return ruleResult(raster.value, "computed", [raster], ctx);
  const anyText = strongest(texts, ctx);
  if (anyText) return ruleResult(anyText.value, anyText.origin, sameValue(anyText, texts), ctx);
  return raster ? ruleResult(raster.value, "computed", [raster], ctx) : null;
};
