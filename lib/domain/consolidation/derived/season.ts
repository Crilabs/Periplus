import type { RuleResult } from "../types";

/*
 * Season hints (spec 07 "aus observed_at-Monaten und Text-Facts mit Monatsangaben"): the `season_notes` result per
 * kind, and the observation months of the inputs supporting a `highlight.*` / `services.*` value.
 */

export type SeasonHint = { kind: string; months: number[] };

/** Attributes whose provenance lists the observation months of their supporting inputs. */
export function hasObservedMonths(attribute: string): boolean {
  return attribute.startsWith("highlight.") || attribute.startsWith("services.");
}

/** From `results["season_notes"]` (a list of `{ kind, months }`, or one entry): months united per kind, sorted by kind. */
export function seasonHints(results: Record<string, RuleResult | null>): SeasonHint[] {
  const value = results["season_notes"]?.value;
  if (value === undefined || value === null) return [];
  const byKind = new Map<string, Set<number>>();
  for (const entry of (Array.isArray(value) ? value : [value]) as Array<{ kind?: unknown; months?: unknown }>) {
    if (typeof entry?.kind !== "string" || !Array.isArray(entry.months)) continue;
    const months = byKind.get(entry.kind) ?? new Set<number>();
    for (const m of entry.months) if (typeof m === "number") months.add(m);
    byKind.set(entry.kind, months);
  }
  return [...byKind.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, months]) => ({ kind, months: [...months].sort((a, b) => a - b) }));
}

/**
 * The months (1–12, ascending) of the observation dates of the inputs supporting `result`; inputs without an
 * observation date (`dateKnown false`, POI imports) do not count.
 */
export function observedMonths(result: RuleResult): number[] {
  const months = new Set(result.support.filter((i) => i.dateKnown).map((i) => Number(i.observedAt.slice(5, 7))));
  return [...months].sort((a, b) => a - b);
}
