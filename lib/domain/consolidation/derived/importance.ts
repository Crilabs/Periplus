import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { HighlightCategory } from "@/lib/db/schema/geo";
import { roundTo } from "@/lib/domain/rules/weights";

/*
 * `importance` 1–5 of a POI (spec 07): from the number and weight of its sources, Wikidata sitelinks and its category;
 * thresholds and radii in `cfg.importance` (radius of meaning 5/10/20/35/50 nm, spec 08).
 */

export type ImportanceInput = {
  sources: Array<{ key: string; weight: number }>;
  sitelinks: number | null;
  category: HighlightCategory;
  /** The POI's kinds (`poiKinds`): `<key>=<value>` OSM tags and `wikidata:<Qid>` (spec 16). */
  kinds: string[];
};

export type Importance = { importance: 1 | 2 | 3 | 4 | 5; score: number; radiusNm: number };

/**
 * Score = the sum of the source weights (each `key` once, its largest weight) + `min(sitelinks / sitelinksPerPoint,
 * maxSitelinkPoints)` + `categoryBonus[category]` + the largest `tagBonus` of its kinds (once, not summed; none without a
 * matching kind or without `tagBonus`), rounded; importance = 1 + the number of thresholds ≤ score; the
 * radius is the importance's entry of `radiusNm`.
 */
export function importanceOf(i: ImportanceInput, cfg: ConsolidationConfig): Importance {
  const c = cfg.importance;
  const perKey = new Map<string, number>();
  for (const s of i.sources) perKey.set(s.key, Math.max(perKey.get(s.key) ?? 0, s.weight));
  // summed in key order: floating-point sums must not depend on the input order
  const sources = [...perKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).reduce((s, [, w]) => s + w, 0);
  const sitelinks = i.sitelinks === null ? 0 : Math.min(i.sitelinks / c.sitelinksPerPoint, c.maxSitelinkPoints);
  const kind = i.kinds.reduce((max, k) => Math.max(max, c.tagBonus?.[k] ?? 0), 0);
  const score = roundTo(sources + sitelinks + c.categoryBonus[i.category] + kind, cfg.precision);
  const importance = (1 + c.thresholds.filter((t) => t <= score).length) as Importance["importance"];
  return { importance, score, radiusNm: c.radiusNm[importance - 1] };
}

/** OSM tag keys whose values are POI kinds (spec 16). */
const KIND_KEYS = ["historic", "tourism", "man_made", "natural", "amenity"] as const;

/**
 * The kinds of a POI from its `geo_objects.tags`: `<key>=<value>` for the kind keys (an OSM value list `a;b` gives
 * each), plus `wikidata:<Qid>` for `wikidata_class`. Non-string and empty values are skipped.
 */
export function poiKinds(tags: Record<string, unknown>): string[] {
  const kinds: string[] = [];
  for (const key of KIND_KEYS) {
    const value = tags[key];
    if (typeof value !== "string") continue;
    for (const v of value.split(";").map((x) => x.trim())) if (v.length > 0) kinds.push(`${key}=${v}`);
  }
  const cls = tags.wikidata_class;
  if (typeof cls === "string" && cls.trim().length > 0) kinds.push(`wikidata:${cls.trim()}`);
  return kinds;
}

/** Candidate places within `radiusNm`, nearest first (ties by id), at most `max` ids. */
export function spotIdsWithin(candidates: Array<{ placeId: string; distanceNm: number }>, radiusNm: number, max: number): string[] {
  return candidates
    .filter((c) => c.distanceNm <= radiusNm)
    .sort((a, b) => a.distanceNm - b.distanceNm || (a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0))
    .slice(0, max)
    .map((c) => c.placeId);
}
