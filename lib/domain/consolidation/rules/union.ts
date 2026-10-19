import { canonicalJson } from "@/lib/domain/facts/schema";
import type { ConsolidationInput, ConsolidationRule, RuleContext, RuleResult } from "../types";
import { afterReview, inputWeight, strongest } from "../weights";
import { ruleResult } from "./result";

type Entry = Record<string, unknown>;

/** The configured identity key fields of `attribute` (exact key, else a `<prefix>.*` pattern); throws when missing. */
export function unionKeys(attribute: string, ctx: RuleContext): string[] {
  const keys = ctx.cfg.rules.union.keys;
  if (keys[attribute]) return keys[attribute];
  const pattern = Object.keys(keys).find((p) => p.endsWith(".*") && attribute.startsWith(p.slice(0, -1)));
  if (pattern) return keys[pattern];
  throw new Error(`No union key configured for ${attribute} (rules.union.keys)`);
}

/** The entries of one input's value: a list, or a single entry (`season_notes`). */
function entriesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** Months of entries with one identity: united and sorted; `null` (all year) wins. */
function uniteMonths(values: unknown[]): number[] | null {
  if (values.some((m) => m === null)) return null;
  return [...new Set(values.flatMap((m) => (Array.isArray(m) ? (m as number[]) : [])))].sort((a, b) => a - b);
}

/**
 * Unites the list entries of all inputs by an identity key (`keyOf`): entries with one key merge (their `months`
 * united, other fields from the strongest input naming it), counted once per independent source (ruling M5-P4),
 * sorted by that count descending, then key. Never a conflict; no entry is lost; every contributing input is support.
 */
export function unite(inputs: ConsolidationInput[], keyOf: (entry: unknown) => string, ctx: RuleContext): RuleResult | null {
  const live = afterReview(inputs);
  const byKey = new Map<string, { entries: { entry: unknown; input: ConsolidationInput }[]; sources: Set<string> }>();
  for (const input of live) {
    for (const entry of entriesOf(input.value)) {
      const key = keyOf(entry);
      const slot = byKey.get(key) ?? { entries: [], sources: new Set<string>() };
      slot.entries.push({ entry, input });
      slot.sources.add(input.sourceKey);
      byKey.set(key, slot);
    }
  }
  if (byKey.size === 0) return null;

  const merged = [...byKey.entries()]
    .map(([key, slot]) => {
      const lead = strongestEntry(slot.entries, ctx);
      let entry = lead;
      if (lead !== null && typeof lead === "object" && !Array.isArray(lead) && "months" in (lead as Entry)) {
        entry = { ...(lead as Entry), months: uniteMonths(slot.entries.map((e) => (e.entry as Entry).months)) };
      }
      return { key, count: slot.sources.size, entry };
    })
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const support = live.filter((i) => entriesOf(i.value).length > 0);
  const lead = strongest(support, ctx)!;
  return ruleResult(
    merged.map((m) => m.entry),
    lead.origin,
    support,
    ctx,
  );
}

function strongestEntry(entries: { entry: unknown; input: ConsolidationInput }[], ctx: RuleContext): unknown {
  let best = entries[0];
  for (const e of entries) if (inputWeight(e.input, ctx) > inputWeight(best.input, ctx)) best = e;
  return best.entry;
}

/**
 * `union` (ruling M5-P3): list attributes (`hazards`, `restricted_zones`, `wind_systems`, `season_notes`,
 * `mooring.types`, `charter_bases`, `supply_ports`) merged by the identity key of `rules.union.keys` (`[]` = the
 * element itself).
 */
export const unionRule: ConsolidationRule = (inputs, ctx) => {
  const fields = unionKeys(ctx.attribute, ctx);
  const keyOf =
    fields.length === 0
      ? (entry: unknown) => canonicalJson(entry)
      : (entry: unknown) => canonicalJson(fields.map((f) => (entry as Entry)[f] ?? null));
  return unite(inputs, keyOf, ctx);
};
