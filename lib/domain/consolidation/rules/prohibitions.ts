import { canonicalJson } from "@/lib/domain/facts/schema";
import type { ConsolidationInput, ConsolidationRule, InputOrigin } from "../types";
import { afterReview, strongest, youngest } from "../weights";
import { ruleResult } from "./result";

type TextEntry = { kind: string; months: number[] | null };

/** A text entry `{ kind, months }` (computed entries carry `restrictedAreaId`). */
function isTextEntry(entry: unknown): entry is TextEntry {
  return entry !== null && typeof entry === "object" && "months" in entry && !("restrictedAreaId" in entry);
}

const kindOf = (entry: unknown) => String((entry as { kind: unknown }).kind);

function byKind(a: unknown, b: unknown): number {
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  const ca = canonicalJson(a);
  const cb = canonicalJson(b);
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

/**
 * `prohibitions` (spec 07): the entries of the youngest computation unchanged (restricted areas; a newer computation
 * without an area removes it, a text never does) ∪ the text entries `{ kind, months }`, months per kind united (`null`
 * = all year wins); always sorted by kind, then entry (ruling M5-C-R2 M-4).
 *
 * Ruling M5-C-R2 I-2 overrides the omission rule of ruling M5-P5 (and the plan): a ban is never lifted by omission.
 * Text inputs only add kinds and months, also a younger `authority` text naming other kinds. A text kind is removed
 * only by a review decision (it supersedes the texts it saw, `afterReview`; the youngest decision holds outright in
 * `applyRule`). Cost if wrong: an outdated ban stays until an admin lifts it.
 */
export const prohibitionsRule: ConsolidationRule = (inputs, ctx) => {
  const live = afterReview(inputs);
  const basis = youngest(live.filter((i) => i.origin === "computed"));
  const texts = live.filter((i) => i.origin !== "computed");
  if (!basis && texts.length === 0) return null;

  const months = new Map<string, (number[] | null)[]>();
  const mentioning = new Set<ConsolidationInput>();
  for (const i of texts) {
    for (const entry of (i.value as unknown[]).filter(isTextEntry)) {
      months.set(entry.kind, [...(months.get(entry.kind) ?? []), entry.months]);
      mentioning.add(i);
    }
  }
  const kept: TextEntry[] = [...months].map(([kind, list]) => ({
    kind,
    months: list.some((m) => m === null) ? null : [...new Set(list.flatMap((m) => m ?? []))].sort((a, b) => a - b),
  }));
  const value = [...(basis ? (basis.value as unknown[]) : []), ...kept].sort(byKind);

  // support: the computation, the texts naming a kind and the review decision that superseded older texts
  const decisions = texts.filter((i) => i.origin === "review");
  const support = [...new Set([...(basis ? [basis] : []), ...mentioning, ...decisions])];
  const origin: InputOrigin =
    mentioning.size > 0 ? strongest([...mentioning], ctx)!.origin : basis ? "computed" : strongest(texts, ctx)!.origin;
  return ruleResult(value, origin, support.length > 0 ? support : texts, ctx);
};
