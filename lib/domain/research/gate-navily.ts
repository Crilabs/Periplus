import type { AppConfig } from "@/lib/config";
import type { PlaceStatus } from "@/lib/db/schema";
import { coverageOfMatches, kindCompatible, matchPlacesToSpots, type MatchPlace } from "@/lib/domain/quality/navily-assistant";
import type { NavilySpot } from "@/lib/domain/quality/navily-sample";
import type { Verdict } from "./confirmation";

/*
 * The gate evaluation (plan N3): the confirmed places of each threshold against the reference spots, and why a spot
 * has no confirmed place. Pure; the spots live in memory only and never leave as names, ids or values, only as indexes
 * into the loaded list (Grundprinzip 9). The reference is never a source: it only measures.
 */

export type GateRow = {
  threshold: number;
  confirmed: number;
  correct: number;
  wrongKind: number;
  conflicts: number;
  decidedNotBerth: number;
  /** `correct / confirmed`; null when nothing is confirmed. */
  correctness: number | null;
};

export type MissReason = "no_candidate" | "unnamed_candidate" | "no_hits" | "too_few_sources" | "negative" | "restricted" | "rejected";

export type GatePlace = MatchPlace & { verdicts: Map<number, Verdict>; hasNames: boolean; hasHits: boolean; status: PlaceStatus };

export type GateMiss = { spotIndex: number; reason: MissReason; placeId: string | null };

/** Why the nearest candidate of a spot is not confirmed at the threshold. */
function reasonOf(p: GatePlace, threshold: number): MissReason {
  if (p.status === "rejected" || p.status === "abandoned") return "rejected";
  if (p.status === "no_anchoring") return "restricted";
  const verdict = p.verdicts.get(threshold);
  if (verdict && (verdict.status === "no_anchoring" || verdict.blockingSignalId !== null)) return "negative";
  if (!p.hasNames) return "unnamed_candidate";
  if (!p.hasHits) return "no_hits";
  return "too_few_sources";
}

/**
 * Each threshold's own matching of the places it confirms (`matchPlacesToSpots`). A confirmed place is correct when
 * matched to a spot of a compatible kind, or when a human decided it a berth; `decidedNotBerth` when a human decided it
 * no berth; `wrongKind` when matched to a spot of another kind and not decided; else a conflict (open). A human decision
 * settles a place only where the matching did not already find a spot of its kind.
 *
 * Misses: the spots no confirmed place of the threshold matched (`coverageOfMatches`; the caller passes the spots of the
 * area). Each is matched alone against every place that has no spot at this threshold, whatever its status; the
 * nearest candidate gives the reason, none gives `no_candidate`.
 */
export function evaluateGate(
  input: { places: GatePlace[]; spots: NavilySpot[]; decisions: Map<string, "berth" | "not_berth"> },
  cfg: Pick<AppConfig, "quality" | "nameAffixes">,
): { rows: GateRow[]; misses: Map<number, GateMiss[]>; conflicts: Map<number, string[]> } {
  const { places, spots, decisions } = input;
  const navily = cfg.quality.navily;
  const thresholds = [...new Set(places.flatMap((p) => [...p.verdicts.keys()]))].sort((a, b) => a - b);
  const rows: GateRow[] = [];
  const misses = new Map<number, GateMiss[]>();
  const conflicts = new Map<number, string[]>();

  for (const threshold of thresholds) {
    const confirmed = places.filter((p) => p.verdicts.get(threshold)?.status === "confirmed").map((p) => ({ ...p, status: "confirmed" as const }));
    const matches = matchPlacesToSpots(confirmed, spots, navily, cfg.nameAffixes);
    const row: GateRow = { threshold, confirmed: confirmed.length, correct: 0, wrongKind: 0, conflicts: 0, decidedNotBerth: 0, correctness: null };
    const open: string[] = [];
    for (const [i, p] of confirmed.entries()) {
      const spotIndex = matches[i]!.spotIndex;
      const spot = spotIndex === null ? null : spots[spotIndex]!;
      const decision = decisions.get(p.placeId);
      if (spot && kindCompatible(p.kind, spot.kind)) row.correct += 1;
      else if (decision === "berth") row.correct += 1;
      else if (decision === "not_berth") row.decidedNotBerth += 1;
      else if (spot) row.wrongKind += 1;
      else {
        row.conflicts += 1;
        open.push(p.placeId);
      }
    }
    row.correctness = row.confirmed === 0 ? null : row.correct / row.confirmed;
    rows.push(row);
    conflicts.set(threshold, open);

    const matchedPlaces = new Set(matches.filter((m) => m.spotIndex !== null).map((m) => m.placeId));
    const pool = places.filter((p) => !matchedPlaces.has(p.placeId)).map((p) => ({ ...p, status: "candidate" as const }));
    const byId = new Map(places.map((p) => [p.placeId, p]));
    const coverage = coverageOfMatches(confirmed, matches, spots, () => true);
    misses.set(
      threshold,
      coverage.unmatchedSpotIndexes.map((spotIndex): GateMiss => {
        const near = matchPlacesToSpots(pool, [spots[spotIndex]!], navily, cfg.nameAffixes).find((m) => m.spotIndex !== null);
        const candidate = near ? byId.get(near.placeId)! : null;
        return { spotIndex, reason: candidate ? reasonOf(candidate, threshold) : "no_candidate", placeId: candidate?.placeId ?? null };
      }),
    );
  }
  return { rows, misses, conflicts };
}
