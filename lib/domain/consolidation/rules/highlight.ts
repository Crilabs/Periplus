import type { ConsolidationInput, ConsolidationRule } from "../types";
import { afterReview, pickDiscrete, strongest } from "../weights";
import { ruleResult } from "./result";

type Highlight = { present: boolean; names: string[] };

/**
 * `highlight.<category>` (spec 07): `present` like `latest_observation` (picked on `{ present }` alone); `names` = the
 * names of every input with `present = true`, sorted by the number of independent sources naming them (a source counts
 * once, ruling M5-P4), then name, at most `maxNames`; `present = false` → no names.
 */
export const highlightRule: ConsolidationRule = (inputs, ctx) => {
  const live = afterReview(inputs);
  if (live.length === 0) return null;
  const original = new Map<ConsolidationInput, ConsolidationInput>();
  const presence = live.map((i) => {
    const p = { ...i, value: { present: (i.value as Highlight).present } };
    original.set(p, i);
    return p;
  });
  const { group, conflict } = pickDiscrete(presence, ctx);
  const support = group.inputs.map((p) => original.get(p)!);
  const present = (group.value as { present: boolean }).present;

  const sources = new Map<string, Set<string>>();
  if (present) {
    for (const i of support) {
      for (const name of (i.value as Highlight).names ?? []) {
        const set = sources.get(name) ?? new Set<string>();
        set.add(i.sourceKey);
        sources.set(name, set);
      }
    }
  }
  const names = [...sources.entries()]
    .sort(([a, sa], [b, sb]) => sb.size - sa.size || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, ctx.cfg.rules.highlight.maxNames)
    .map(([name]) => name);

  const lead = strongest(support, ctx)!;
  return { ...ruleResult({ present, names }, lead.origin, support, ctx), observedAt: group.to, conflict };
};
