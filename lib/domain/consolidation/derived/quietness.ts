import type { ConsolidationConfig } from "@/lib/config/schemas";
import { roundTo } from "@/lib/domain/rules/weights";

/*
 * `quietness` 0–1 (spec 07): distances to settlement and road (the quietness computation), occupancy in the
 * configured months, the text value of `quietness` and ferry traffic; formula parameters in `cfg.quietness`.
 */

export type OccupancyWord = "empty" | "moderate" | "full" | "unknown";
export type QuietnessWord = "quiet" | "moderate" | "busy" | "noisy";

export type QuietnessParts = {
  settlementDistanceM: number | null;
  roadDistanceM: number | null;
  /** Occupancy of the configured months (`quietness.occupancyMonths`); `unknown` months do not count. */
  occupancy: OccupancyWord[];
  text: QuietnessWord | null;
  /** Ferry part 0–1, already mapped (ferry lane nearby, or the parent's ferry traffic). */
  ferry: number | null;
};

/**
 * The parts `min(settlement / settlementFullM, 1)`, `min(road / roadFullM, 1)`, the mean of the known occupancy
 * levels, the text level and the ferry part; missing parts drop out and the weights of the others are renormalized.
 * Fewer than `quietness.minParts` known parts → `value` null (ruling M5-E-R2: no value from one part alone, e.g. only
 * the ferry part with 10 % of the formula; the profile lists it as a gap). `parts` holds the known parts, rounded.
 */
export function quietnessScore(
  p: QuietnessParts,
  cfg: ConsolidationConfig,
): { value: number | null; parts: Record<string, number> } {
  const q = cfg.quietness;
  const known = p.occupancy.filter((o): o is Exclude<OccupancyWord, "unknown"> => o !== "unknown");
  const raw: Record<keyof typeof q.weights, number | null> = {
    settlement: p.settlementDistanceM === null ? null : Math.min(p.settlementDistanceM / q.settlementFullM, 1),
    road: p.roadDistanceM === null ? null : Math.min(p.roadDistanceM / q.roadFullM, 1),
    occupancy: known.length === 0 ? null : known.reduce((s, o) => s + q.occupancy[o], 0) / known.length,
    text: p.text === null ? null : q.text[p.text],
    ferry: p.ferry,
  };
  const parts: Record<string, number> = {};
  let weighted = 0;
  let weights = 0;
  // fixed key order: the sum must not depend on how the parts were assembled
  for (const key of ["settlement", "road", "occupancy", "text", "ferry"] as const) {
    const v = raw[key];
    if (v === null) continue;
    parts[key] = roundTo(v, cfg.precision);
    weighted += q.weights[key] * v;
    weights += q.weights[key];
  }
  const enough = Object.keys(parts).length >= q.minParts && weights > 0;
  return { value: enough ? roundTo(weighted / weights, cfg.precision) : null, parts };
}
