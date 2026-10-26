import type { NameAffixesConfig } from "@/lib/config";
import type { NAME_AFFIX_HINTS } from "@/lib/config/schemas";

export type Hint = (typeof NAME_AFFIX_HINTS)[number];

const sortedByConfig = new WeakMap<NameAffixesConfig, NameAffixesConfig>();

/** Affixes longest first, so "bucht von" wins over a shorter affix of the same form; sorted once per config list. */
function byLength(affixes: NameAffixesConfig): NameAffixesConfig {
  let sorted = sortedByConfig.get(affixes);
  if (!sorted) {
    sorted = [...affixes].sort((a, b) => b.affix.length - a.affix.length);
    sortedByConfig.set(affixes, sorted);
  }
  return sorted;
}

/**
 * Strips one prefix or suffix affix (as whole words) from a normalized form; `null` when the form has none or nothing
 * but the affix would remain.
 */
export function stripAffix(form: string, affixes: NameAffixesConfig): { core: string; hint: Hint } | null {
  for (const a of byLength(affixes)) {
    let core: string | null = null;
    if (a.position === "prefix" && form.startsWith(`${a.affix} `)) core = form.slice(a.affix.length + 1);
    if (a.position === "suffix" && form.endsWith(` ${a.affix}`)) core = form.slice(0, form.length - a.affix.length - 1);
    if (core !== null && core.trim().length > 0) return { core: core.trim(), hint: a.hint };
  }
  return null;
}
