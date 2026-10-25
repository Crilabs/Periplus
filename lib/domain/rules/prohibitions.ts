import { canonicalJson } from "@/lib/domain/facts/schema";
import type { ConsolidationInput, ConsolidationRule, InputOrigin } from "./types";
import { inputId, strongest, youngest } from "./weights";
import { ruleResult } from "./result";

type TextEntry = { kind: string; months: number[] | null };

/** A text entry `{ kind, months }` (computed entries carry `restrictedAreaId`). */
function isTextEntry(entry: unknown): entry is TextEntry {
  return entry !== null && typeof entry === "object" && "months" in entry && !("restrictedAreaId" in entry);
}

/** A computed entry of `prohibitions`: a restricted area (`restrictedAreaId`), which only its computation removes. */
export const isComputedProhibition = (entry: unknown): boolean =>
  entry !== null && typeof entry === "object" && "restrictedAreaId" in entry;

const kindOf = (entry: unknown) => String((entry as { kind: unknown }).kind);

/** The identity key of one entry: a text entry by `kind`, a computed one by `<kind>:<restrictedAreaId>`. */
export function prohibitionEntryKey(entry: unknown): string {
  const e = entry as { kind: unknown; restrictedAreaId?: unknown };
  return isTextEntry(entry) ? kindOf(entry) : `${kindOf(entry)}:${String(e.restrictedAreaId)}`;
}

/** The order of a `prohibitions` list: by kind, then entry. */
export function compareProhibitions(a: unknown, b: unknown): number {
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  const ca = canonicalJson(a);
  const cb = canonicalJson(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

/**
 * A review decision removing text kinds from `prohibitions`: value `{ remove: { kind } }` (ruling M5-FIN-R1 I-1,
 * the counterpart of `UnionRemoval`), or `{ remove: [{ kind }, …] }` when an accepted `uncertain_change` drops several
 * kinds at once (one fact per decision, GR-1). „Eintrag entfernen“ writes the single shape; any other review value adds
 * its text entries like a text.
 */
export type ProhibitionRemoval = { remove: { kind: string } | { kind: string }[] };

function isRemoval(i: ConsolidationInput): boolean {
  if (i.origin !== "review" || i.value === null || typeof i.value !== "object" || Array.isArray(i.value)) return false;
  const remove = (i.value as { remove?: unknown }).remove;
  const isKind = (r: unknown) => r !== null && typeof r === "object" && !Array.isArray(r) && "kind" in r;
  return Array.isArray(remove) ? remove.length > 0 && remove.every(isKind) : isKind(remove);
}

/** The kinds a removal decision removes. */
function removedKinds(r: ConsolidationInput): string[] {
  const remove = (r.value as ProhibitionRemoval).remove;
  return (Array.isArray(remove) ? remove : [remove]).map((e) => String(e.kind));
}

/**
 * `prohibitions` (spec 07): the entries of the youngest computation unchanged (restricted areas; a newer computation
 * without an area removes it, a text never does) ∪ the text entries `{ kind, months }`, months per kind united (`null`
 * = all year wins); always sorted by kind, then entry (ruling M5-C-R2 M-4).
 *
 * Ruling M5-C-R2 I-2 overrides the omission rule of ruling M5-P5 (and the plan): a ban is never lifted by omission.
 * Text inputs only add kinds and months, also a younger `authority` text naming other kinds. A review never supersedes
 * a text (ruling M5-FIN-R1 I-1): a review list adds its text entries like a text, and a text kind is removed only by a
 * removal decision `{ remove: { kind } }` (`ProhibitionRemoval`), and only while no input naming that kind was observed
 * after it (a younger text brings it back; a guide found later but dated earlier adds its own kinds and does not
 * bring back the removed one). `applyRule` never takes the review shortcut for it (ruling M5-C-R4). Cost if wrong: an
 * outdated ban stays until an admin lifts it.
 *
 * `entryFactIds` (ruling M5-E-R3 I-3): per entry (`prohibitionEntryKey`), the input ids naming it. The support also
 * holds the basis and the effective removals, so a stale text-only entry never expires (ruling M5-E-R3 M-4, accepted
 * for a safety list that is never lifted by omission).
 */
export const prohibitionsRule: ConsolidationRule = (inputs, ctx) => {
  const removals = inputs.filter(isRemoval);
  const basis = youngest(inputs.filter((i) => i.origin === "computed"));
  const texts = inputs.filter((i) => i.origin !== "computed" && !isRemoval(i));
  if (!basis && texts.length === 0 && removals.length === 0) return null;

  const named = new Map<string, { input: ConsolidationInput; months: number[] | null }[]>();
  for (const i of texts) {
    for (const entry of (i.value as unknown[]).filter(isTextEntry)) {
      named.set(entry.kind, [...(named.get(entry.kind) ?? []), { input: i, months: entry.months }]);
    }
  }
  const effective = new Set<ConsolidationInput>();
  // kinds a removal decision took out, also those no current input names any more, with the youngest removal's date
  // (GR-1: change detection lets a text entry leave the profile only through such a decision; GR-12: and only while
  // no fact the previous profile cites for it is younger)
  const removedEntries: Record<string, string> = {};
  for (const r of removals) {
    for (const kind of removedKinds(r)) {
      const naming = named.get(kind);
      if (naming?.some((n) => n.input.observedAt > r.observedAt)) continue;
      if (!(kind in removedEntries) || r.observedAt > removedEntries[kind]!) removedEntries[kind] = r.observedAt;
      if (!naming) continue;
      named.delete(kind);
      effective.add(r);
    }
  }
  if (!basis && texts.length === 0) return { ...ruleResult(null, "review", removals, ctx), removedEntries };

  const naming = new Map<string, Set<string>>();
  const cite = (key: string, i: ConsolidationInput) => naming.set(key, (naming.get(key) ?? new Set<string>()).add(inputId(i)));
  const mentioning = new Set<ConsolidationInput>();
  const kept: TextEntry[] = [...named].map(([kind, list]) => {
    for (const n of list) {
      mentioning.add(n.input);
      cite(kind, n.input);
    }
    const months = list.map((n) => n.months);
    return {
      kind,
      months: months.some((m) => m === null) ? null : [...new Set(months.flatMap((m) => m ?? []))].sort((a, b) => a - b),
    };
  });
  for (const entry of basis ? (basis.value as unknown[]) : []) cite(prohibitionEntryKey(entry), basis!);
  const value = [...(basis ? (basis.value as unknown[]) : []), ...kept].sort(compareProhibitions);

  // support: the computation, the inputs naming a kept kind and the removals that took effect
  const support = [...new Set([...(basis ? [basis] : []), ...mentioning, ...effective])];
  const origin: InputOrigin =
    mentioning.size > 0 ? strongest([...mentioning], ctx)!.origin : basis ? "computed" : effective.size > 0 ? "review" : strongest(texts, ctx)!.origin;
  // per-entry provenance of the safety list (ruling M5-E-R3 I-3): which input names which ban
  const entryFactIds = Object.fromEntries(
    value.map((entry) => {
      const key = prohibitionEntryKey(entry);
      return [key, [...(naming.get(key) ?? [])].sort()];
    }),
  );
  return { ...ruleResult(value, origin, support.length > 0 ? support : texts, ctx), entryFactIds, removedEntries };
};
