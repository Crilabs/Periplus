import type { AppConfig } from "@/lib/config";
import type { PlaceStatus } from "@/lib/db/schema";
import { coverageOfMatches, kindCompatible, matchPlacesToSpots, type MatchPlace } from "@/lib/domain/quality/navily-assistant";
import type { LonLat } from "@/lib/domain/geometry/water";
import type { NavilySpot } from "@/lib/domain/quality/navily-sample";
import { ADMIN_SET_REASON, RESTRICTED_REASON, type Verdict } from "./confirmation";

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
  /** Matched to a spot of its kind, but farther from it than `gate.maxPositionDeviationM`. */
  wrongPosition: number;
  conflicts: number;
  decidedNotBerth: number;
  /** `correct / confirmed`; null when nothing is confirmed. */
  correctness: number | null;
};

export type MissReason = "no_candidate" | "matched_elsewhere" | "admin" | "unnamed_candidate" | "no_hits" | "too_few_sources" | "negative" | "restricted" | "rejected";

export type GatePlace = MatchPlace & { verdicts: Map<number, Verdict>; hasNames: boolean; hasHits: boolean; status: PlaceStatus; statusReason: string | null };

/**
 * A confirmed place counted as an error: a spot of another kind matched by name, a spot of its kind too far away, or a
 * human "no berth" decision (`spotIndex` null without a spot).
 */
export type GateError = { placeId: string; kind: GateErrorKind; spotIndex: number | null; distanceM: number | null };
export type GateErrorKind = "wrong_kind" | "position" | "not_berth";

export type GateMiss = { spotIndex: number; reason: MissReason; placeId: string | null };

/** Why the candidate of a spot is not confirmed at the threshold. */
function reasonOf(p: GatePlace, threshold: number): MissReason {
  if (p.status === "rejected" || p.status === "abandoned") return "rejected";
  if (p.status === "no_anchoring") return p.statusReason?.startsWith("restricted:") ? "restricted" : "negative";
  const verdict = p.verdicts.get(threshold);
  if (verdict?.status === "no_anchoring") return verdict.reason === RESTRICTED_REASON ? "restricted" : "negative";
  if (verdict?.reason === ADMIN_SET_REASON) return "admin";
  if (verdict && verdict.blockingSignalId !== null) return "negative";
  if (!p.hasNames) return "unnamed_candidate";
  if (!p.hasHits) return "no_hits";
  return "too_few_sources";
}

/**
 * Each threshold's own matching of the places it confirms there (a missing verdict is not confirmed;
 * `matchPlacesToSpots`). Per confirmed place, the first that applies:
 * - `wrongKind` (an error whatever a human decided): matched by name (similarity ≥ `quality.navily.nameMin`) to a spot
 *   whose kind is known and incompatible (revised ruling: a match by distance only, or to a spot of unknown kind, says
 *   nothing about the kind and is a conflict instead);
 * - `wrongPosition` (an error whatever a human decided): matched to a spot of its kind farther than
 *   `research.gate.maxPositionDeviationM`;
 * - `decidedNotBerth` (an error, also when a spot matches): a human "no berth" decision;
 * - correct: matched to a spot of its kind, or decided a berth;
 * - else a conflict (unmatched, or matched to a spot of unknown or another kind without a name match; undecided: the
 *   gate is not passed yet).
 *
 * Misses: the spots in the area (`inArea`, default all) no confirmed place of the threshold matched
 * (`coverageOfMatches`); the caller passes the spots of the area plus a border buffer, so a place near the edge still
 * finds its spot just outside, which is matched but never counted as a miss. Each miss is matched alone against every
 * place that has no spot at this threshold, whatever its status; the first by matching order (kind, name, distance)
 * gives the reason. Without one, a place that already has another spot gives `matched_elsewhere`, else `no_candidate`.
 */
export function evaluateGate(
  input: { thresholds: number[]; places: GatePlace[]; spots: NavilySpot[]; decisions: Map<string, "berth" | "not_berth">; inArea?: (p: LonLat) => boolean },
  cfg: Pick<AppConfig, "quality" | "nameAffixes" | "research">,
): { rows: GateRow[]; misses: Map<number, GateMiss[]>; conflicts: Map<number, string[]>; errors: Map<number, GateError[]> } {
  const { thresholds, places, spots, decisions } = input;
  const inArea = input.inArea ?? (() => true);
  const navily = cfg.quality.navily;
  const maxDeviation = cfg.research.gate.maxPositionDeviationM;
  const rows: GateRow[] = [];
  const misses = new Map<number, GateMiss[]>();
  const conflicts = new Map<number, string[]>();
  const errors = new Map<number, GateError[]>();

  for (const threshold of thresholds) {
    const confirmed = places.filter((p) => p.verdicts.get(threshold)?.status === "confirmed").map((p) => ({ ...p, status: "confirmed" as const }));
    const matches = matchPlacesToSpots(confirmed, spots, navily, cfg.nameAffixes);
    const row: GateRow = { threshold, confirmed: confirmed.length, correct: 0, wrongKind: 0, wrongPosition: 0, conflicts: 0, decidedNotBerth: 0, correctness: null };
    const open: string[] = [];
    const errs: GateError[] = [];
    for (const [i, p] of confirmed.entries()) {
      const match = matches[i]!;
      const spot = match.spotIndex === null ? null : spots[match.spotIndex]!;
      const compatible = spot !== null && kindCompatible(p.kind, spot.kind);
      const decision = decisions.get(p.placeId);
      const at = { spotIndex: match.spotIndex, distanceM: match.distanceM };
      if (spot && spot.kind !== null && !compatible && (match.nameSimilarity ?? 0) >= navily.nameMin) {
        row.wrongKind += 1;
        errs.push({ placeId: p.placeId, kind: "wrong_kind", ...at });
      } else if (compatible && match.distanceM! > maxDeviation) {
        row.wrongPosition += 1;
        errs.push({ placeId: p.placeId, kind: "position", ...at });
      } else if (decision === "not_berth") {
        row.decidedNotBerth += 1;
        errs.push({ placeId: p.placeId, kind: "not_berth", ...at });
      } else if (compatible || decision === "berth") row.correct += 1;
      else {
        row.conflicts += 1;
        open.push(p.placeId);
      }
    }
    row.correctness = row.confirmed === 0 ? null : row.correct / row.confirmed;
    rows.push(row);
    conflicts.set(threshold, open);
    errors.set(threshold, errs);

    const matchedPlaces = new Set(matches.filter((m) => m.spotIndex !== null).map((m) => m.placeId));
    const pool = places.filter((p) => !matchedPlaces.has(p.placeId)).map((p) => ({ ...p, status: "candidate" as const }));
    const matchedPool = places.filter((p) => matchedPlaces.has(p.placeId)).map((p) => ({ ...p, status: "candidate" as const }));
    const byId = new Map(places.map((p) => [p.placeId, p]));
    const coverage = coverageOfMatches(confirmed, matches, spots, inArea);
    misses.set(
      threshold,
      coverage.unmatchedSpotIndexes.map((spotIndex): GateMiss => {
        const near = matchPlacesToSpots(pool, [spots[spotIndex]!], navily, cfg.nameAffixes).find((m) => m.spotIndex !== null);
        if (near) return { spotIndex, reason: reasonOf(byId.get(near.placeId)!, threshold), placeId: near.placeId };
        const taken = matchPlacesToSpots(matchedPool, [spots[spotIndex]!], navily, cfg.nameAffixes).find((m) => m.spotIndex !== null);
        return { spotIndex, reason: taken ? "matched_elsewhere" : "no_candidate", placeId: taken?.placeId ?? null };
      }),
    );
  }
  return { rows, misses, conflicts, errors };
}
