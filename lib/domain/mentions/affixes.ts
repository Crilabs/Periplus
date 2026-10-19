import type { MentionsConfig, NameAffixesConfig } from "@/lib/config";
import type { NAME_AFFIX_HINTS } from "@/lib/config/schemas";

/*
 * Generic name parts (`config/name-affixes.json`, normalized like `normalizeName`): "Bucht von Kolona", "Vathy Bay",
 * "όρμο Βαθύ". Stripping one leaves the name core to match and a hint at the object type.
 */

export type Hint = (typeof NAME_AFFIX_HINTS)[number];

const ONLY_DIGITS = /^[\p{N} ]+$/u;

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

/**
 * A normalized form that never forms a mention on its own: a configured stop name, an affix alone, shorter than
 * `exactMinChars`, or digits only.
 */
export function isStopName(form: string, cfg: MentionsConfig, affixes: NameAffixesConfig): boolean {
  return (
    cfg.stopNames.includes(form) ||
    affixes.some((a) => a.affix === form) ||
    form.length < cfg.exactMinChars ||
    ONLY_DIGITS.test(form)
  );
}
