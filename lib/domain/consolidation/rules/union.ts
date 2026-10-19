import { canonicalJson } from "@/lib/domain/facts/schema";
import type { ConsolidationInput, ConsolidationRule, RuleContext, RuleResult } from "../types";
import { inputWeight, strongest } from "../weights";
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

/** The identity key of one list entry of `ctx.attribute` (`[]` keys = the element itself); `entryFactIds` uses it. */
export function unionEntryKey(entry: unknown, ctx: RuleContext): string {
  return entryKey(unionKeys(ctx.attribute, ctx), entry);
}

function entryKey(fields: string[], entry: unknown): string {
  return fields.length === 0 ? canonicalJson(entry) : canonicalJson(fields.map((f) => (entry as Entry)[f] ?? null));
}

/**
 * A review decision removing one entry from a union list: value `{ remove: <entry> }` (ruling M5-C-R2 M-3). Bundle I:
 * the review action writes this shape; any other review value adds its entries like a text.
 */
export type UnionRemoval = { remove: unknown };

function isRemoval(i: ConsolidationInput): boolean {
  return i.origin === "review" && i.value !== null && typeof i.value === "object" && !Array.isArray(i.value) && "remove" in i.value;
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
 * sorted by that count descending, then key. Never a conflict, and no entry is lost behind a review (ruling M5-C-R2
 * M-3): a review adds its entries like a text; only a removal decision `{ remove: <entry> }` drops one entry, and an
 * input observed after the decision naming it brings it back. `entryFactIds` maps each entry key to the sorted fact
 * ids naming it (ruling M5-C-R1 (5)). The second-source bonus only when two independent sources name one entry
 * (ruling M5-C-R2 M-1). Callers that apply `afterReview` first (`area_weighted` lists) keep that supersession.
 */
export function unite(inputs: ConsolidationInput[], keyOf: (entry: unknown) => string, ctx: RuleContext): RuleResult | null {
  const removals = inputs.filter(isRemoval);
  const byKey = new Map<string, { entries: { entry: unknown; input: ConsolidationInput }[]; sources: Set<string> }>();
  for (const input of inputs) {
    if (isRemoval(input)) continue;
    for (const entry of entriesOf(input.value)) {
      const key = keyOf(entry);
      const slot = byKey.get(key) ?? { entries: [], sources: new Set<string>() };
      slot.entries.push({ entry, input });
      slot.sources.add(input.sourceKey);
      byKey.set(key, slot);
    }
  }
  if (byKey.size === 0) return null;

  const effective = new Set<ConsolidationInput>();
  for (const r of removals) {
    const key = keyOf((r.value as UnionRemoval).remove);
    const slot = byKey.get(key);
    if (!slot || slot.entries.some((e) => e.input.observedAt > r.observedAt)) continue;
    byKey.delete(key);
    effective.add(r);
  }

  const merged = [...byKey.entries()]
    .map(([key, slot]) => {
      const lead = strongestEntry(slot.entries, ctx);
      let entry = lead;
      if (lead !== null && typeof lead === "object" && !Array.isArray(lead) && "months" in (lead as Entry)) {
        entry = { ...(lead as Entry), months: uniteMonths(slot.entries.map((e) => (e.entry as Entry).months)) };
      }
      return { key, slot, count: slot.sources.size, entry };
    })
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const entryFactIds: Record<string, string[]> = {};
  for (const m of merged) {
    entryFactIds[m.key] = [...new Set(m.slot.entries.flatMap((e) => (e.input.factId ? [e.input.factId] : [])))].sort();
  }
  const naming = [...new Set(merged.flatMap((m) => m.slot.entries.map((e) => e.input)))];
  // inputs of entries named by two independent sources: only they give the second-source bonus
  const confirming = [...new Set(merged.filter((m) => m.count >= 2).flatMap((m) => m.slot.entries.map((e) => e.input)))];
  const support = [...naming, ...effective];
  const lead = strongest(naming.length > 0 ? naming : support, ctx)!;
  const result = ruleResult(
    merged.map((m) => m.entry),
    lead.origin,
    support,
    ctx,
    confirming,
  );
  return { ...result, entryFactIds };
}

function strongestEntry(entries: { entry: unknown; input: ConsolidationInput }[], ctx: RuleContext): unknown {
  let best = entries[0];
  for (const e of entries) if (inputWeight(e.input, ctx) > inputWeight(best.input, ctx)) best = e;
  return best.entry;
}

/**
 * `union` (ruling M5-P3): list attributes (`hazards`, `restricted_zones`, `wind_systems`, `season_notes`,
 * `mooring.types`, `charter_bases`, `supply_ports`) merged by the identity key of `rules.union.keys` (`[]` = the
 * element itself). `applyRule` never takes the review shortcut for it (ruling M5-C-R2 M-3).
 */
export const unionRule: ConsolidationRule = (inputs, ctx) => {
  const fields = unionKeys(ctx.attribute, ctx);
  return unite(inputs, (entry) => entryKey(fields, entry), ctx);
};
