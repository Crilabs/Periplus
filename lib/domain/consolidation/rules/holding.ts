import type { ConsolidationRule } from "../types";
import { afterReview, pickDiscrete, strongest } from "../weights";
import { ruleResult } from "./result";

/**
 * `holding` (spec 07): text only (and review decisions); majority weighted by source weight × confidence × recency,
 * without time course; a conflict below `conflict.minRatio`.
 */
export const holdingRule: ConsolidationRule = (inputs, ctx) => {
  const texts = afterReview(inputs).filter((i) => i.origin === "text" || i.origin === "review");
  if (texts.length === 0) return null;
  const { group, conflict } = pickDiscrete(texts, ctx, { timeCourse: false });
  const lead = strongest(group.inputs, ctx)!;
  return { ...ruleResult(group.value, lead.origin, group.inputs, ctx), conflict };
};
