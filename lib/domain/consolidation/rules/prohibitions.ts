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

const entriesOfKind = (i: ConsolidationInput, kind: string) =>
  (i.value as unknown[]).filter((e): e is TextEntry => isTextEntry(e) && e.kind === kind);

/**
 * `prohibitions` (spec 07, ruling M5-P5): the entries of the youngest computation unchanged (restricted areas, never
 * lifted by a text) ∪ the text entries: a `kind` holds until an input of document type `authority` observed after its
 * youngest mention omits it; months per kind united (`null` = all year wins); sorted by kind. Only a computation → its
 * value unchanged.
 */
export const prohibitionsRule: ConsolidationRule = (inputs, ctx) => {
  const live = afterReview(inputs);
  const basis = youngest(live.filter((i) => i.origin === "computed"));
  const texts = live.filter((i) => i.origin !== "computed");
  if (!basis && texts.length === 0) return null;
  if (texts.length === 0) return ruleResult(basis!.value, "computed", [basis!], ctx);

  const authorities = texts.filter((i) => i.sourceType === "authority");
  const mentions = new Map<string, ConsolidationInput[]>();
  for (const i of texts) {
    for (const entry of (i.value as unknown[]).filter(isTextEntry)) {
      const list = mentions.get(entry.kind) ?? [];
      list.push(i);
      mentions.set(entry.kind, list);
    }
  }

  const kept: TextEntry[] = [];
  const mentioning = new Set<ConsolidationInput>();
  const lifted = new Set<ConsolidationInput>();
  for (const [kind, by] of mentions) {
    const last = youngest(by)!;
    const lifting = authorities.filter((a) => a.observedAt > last.observedAt && entriesOfKind(a, kind).length === 0);
    if (lifting.length > 0) {
      for (const a of lifting) lifted.add(a);
      continue;
    }
    const months = by.flatMap((i) => entriesOfKind(i, kind).map((e) => e.months));
    const allYear = months.some((m) => m === null);
    kept.push({ kind, months: allYear ? null : [...new Set(months.flatMap((m) => m ?? []))].sort((a, b) => a - b) });
    for (const i of by) mentioning.add(i);
  }

  const computedEntries = basis ? (basis.value as unknown[]) : [];
  const value = [...computedEntries, ...kept].sort((a, b) => {
    const ka = kindOf(a);
    const kb = kindOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0;
  });

  // support: the computation, the mentions of kept bans and the authorities that lifted the others
  const support = [...new Set([...(basis ? [basis] : []), ...mentioning, ...lifted])];
  const origin: InputOrigin =
    mentioning.size > 0 ? strongest([...mentioning], ctx)!.origin : basis ? "computed" : strongest(support.length > 0 ? support : texts, ctx)!.origin;
  return ruleResult(value, origin, support.length > 0 ? support : texts, ctx);
};
