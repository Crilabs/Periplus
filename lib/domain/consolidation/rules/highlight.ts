import type { ConsolidationInput, ConsolidationRule, RuleContext } from "../types";
import { afterReview, strongest } from "../weights";
import { pickPresence } from "./presence";
import { ruleResult } from "./result";

type Highlight = { present: boolean; names: string[] };

/** Names of the inputs, sorted by independent sources naming them (a source counts once, M5-P4), then name. */
function namesOf(inputs: ConsolidationInput[], ctx: RuleContext): string[] {
  const sources = new Map<string, Set<string>>();
  for (const i of inputs) {
    for (const name of (i.value as Highlight).names ?? []) {
      const set = sources.get(name) ?? new Set<string>();
      set.add(i.sourceKey);
      sources.set(name, set);
    }
  }
  return [...sources.entries()]
    .sort(([a, sa], [b, sb]) => sb.size - sa.size || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, ctx.cfg.rules.highlight.maxNames)
    .map(([name]) => name);
}

/**
 * `highlight.<category>` (spec 07): `present` like `latest_observation` (picked on `{ present }` alone, month time
 * course); `names` = the names of every input of the picked group with `present = true`, sorted by the number of
 * independent sources naming them, then name, at most `maxNames`; `present = false` → no names. Conflict sides carry
 * `{ present, names }` (ruling M5-C-R1 (6)).
 */
export const highlightRule: ConsolidationRule = (inputs, ctx) => {
  const live = afterReview(inputs);
  if (live.length === 0) return null;
  const complete = (present: boolean, group: ConsolidationInput[]): Highlight => ({
    present,
    names: present ? namesOf(group, ctx) : [],
  });
  const pick = pickPresence(live, ctx, complete);
  const lead = strongest(pick.inputs, ctx)!;
  return {
    ...ruleResult(complete(pick.present, pick.inputs), lead.origin, pick.inputs, ctx),
    observedAt: pick.observedAt,
    conflict: pick.conflict,
  };
};
