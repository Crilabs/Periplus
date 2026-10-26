import type { MentionsConfig, NameAffixesConfig } from "@/lib/config";

/*
 * Generic name parts (`config/name-affixes.json`, normalized like `normalizeName`): "Bucht von Kolona", "Vathy Bay",
 * "όρμο Βαθύ". Stripping one leaves the name core to match and a hint at the object type.
 */

const ONLY_DIGITS = /^[\p{N} ]+$/u;

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
