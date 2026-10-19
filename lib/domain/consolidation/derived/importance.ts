import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { PoiCategory } from "@/lib/db/schema/geo";
import { roundTo } from "../weights";

/*
 * `importance` 1–5 of a POI (spec 07): from the number and weight of its sources, Wikidata sitelinks and its category;
 * thresholds and radii in `cfg.importance` (radius of meaning 5/10/20/35/50 nm, spec 08).
 */

export type ImportanceInput = { sources: Array<{ key: string; weight: number }>; sitelinks: number | null; category: PoiCategory };

export type Importance = { importance: 1 | 2 | 3 | 4 | 5; score: number; radiusNm: number };

/**
 * Score = the sum of the source weights (each `key` once, its largest weight) + `min(sitelinks / sitelinksPerPoint,
 * maxSitelinkPoints)` + `categoryBonus[category]`, rounded; importance = 1 + the number of thresholds ≤ score; the
 * radius is the importance's entry of `radiusNm`.
 */
export function importanceOf(i: ImportanceInput, cfg: ConsolidationConfig): Importance {
  const c = cfg.importance;
  const perKey = new Map<string, number>();
  for (const s of i.sources) perKey.set(s.key, Math.max(perKey.get(s.key) ?? 0, s.weight));
  // summed in key order: floating-point sums must not depend on the input order
  const sources = [...perKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).reduce((s, [, w]) => s + w, 0);
  const sitelinks = i.sitelinks === null ? 0 : Math.min(i.sitelinks / c.sitelinksPerPoint, c.maxSitelinkPoints);
  const score = roundTo(sources + sitelinks + c.categoryBonus[i.category], cfg.precision);
  const importance = (1 + c.thresholds.filter((t) => t <= score).length) as Importance["importance"];
  return { importance, score, radiusNm: c.radiusNm[importance - 1] };
}

/** Candidate places within `radiusNm`, nearest first (ties by id), at most `max` ids. */
export function spotIdsWithin(candidates: Array<{ placeId: string; distanceNm: number }>, radiusNm: number, max: number): string[] {
  return candidates
    .filter((c) => c.distanceNm <= radiusNm)
    .sort((a, b) => a.distanceNm - b.distanceNm || (a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0))
    .slice(0, max)
    .map((c) => c.placeId);
}
