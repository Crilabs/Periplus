import { canonicalJson } from "@/lib/domain/facts/schema";
import type { ConsolidationInput, ConsolidationRule, RuleContext, RuleResult } from "../types";
import { afterReview, attributeIn, independentCount, inputConfidence, pickDiscrete, strongest, valueGroups } from "../weights";
import { ruleResult } from "./result";

/**
 * Standard rule (spec 07): the youngest observation among the inputs with confidence ≥ `latestMinConfidence`
 * (`pickDiscrete`, conflicts included); without such an input the heaviest value group of all inputs, without conflict.
 * Attributes of `rules.default.fieldwise` (`contact`, ruling M5-C-R2 I-1) merge field by field instead.
 */
export const defaultRule: ConsolidationRule = (inputs, ctx) => {
  const live = afterReview(inputs);
  if (live.length === 0) return null;
  const eligible = live.filter((i) => inputConfidence(i, ctx.cfg) >= ctx.cfg.rules.default.latestMinConfidence);
  if (attributeIn(ctx.attribute, ctx.cfg.rules.default.fieldwise)) return fieldwise(eligible.length > 0 ? eligible : live, ctx);
  if (eligible.length > 0) {
    const { group, conflict } = pickDiscrete(eligible, ctx);
    const lead = strongest(group.inputs, ctx)!;
    return { ...ruleResult(group.value, lead.origin, group.inputs, ctx), conflict };
  }
  const [group] = valueGroups(live, ctx);
  const lead = strongest(group.inputs, ctx)!;
  return ruleResult(group.value, lead.origin, group.inputs, ctx);
};

type Fields = Record<string, unknown>;

/**
 * An object merged field by field: each field from the latest input carrying it (not null), in the same month the
 * stronger one; a field no input carries is null. Partial objects of different sources (a VHF channel here, a phone
 * there) complete each other and never conflict. The support is the inputs supplying a field plus those agreeing with
 * every field they carry; the second-source bonus only when two independent sources carry one field's value.
 */
function fieldwise(pool: ConsolidationInput[], ctx: RuleContext): RuleResult {
  const fields = [...new Set(pool.flatMap((i) => Object.keys(i.value as object)))].sort();
  const value: Fields = {};
  const suppliers = new Set<ConsolidationInput>();
  for (const f of fields) {
    const carriers = pool.filter((i) => (i.value as Fields)[f] != null);
    if (carriers.length === 0) {
      value[f] = null;
      continue;
    }
    const month = carriers.map((i) => i.observedAt.slice(0, 7)).sort().at(-1)!;
    const chosen = strongest(carriers.filter((i) => i.observedAt.slice(0, 7) === month), ctx)!;
    value[f] = (chosen.value as Fields)[f];
    suppliers.add(chosen);
  }
  const agrees = (i: ConsolidationInput) =>
    Object.entries(i.value as Fields).every(([f, v]) => v == null || canonicalJson(v) === canonicalJson(value[f]));
  const agreeing = pool.filter(agrees);
  // a field confirmed by two independent sources gives the bonus; fields from one source each do not
  const confirming = fields.flatMap((f) => {
    const carriers = agreeing.filter((i) => (i.value as Fields)[f] != null);
    return independentCount(carriers) >= 2 ? carriers : [];
  });
  const support = [...new Set([...suppliers, ...agreeing])];
  const lead = strongest(suppliers.size > 0 ? [...suppliers] : pool, ctx)!;
  return ruleResult(value, lead.origin, support.length > 0 ? support : pool, ctx, [...new Set(confirming)]);
}
