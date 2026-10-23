import type { AppConfig } from "@/lib/config";
import type { PlaceStatus } from "@/lib/db/schema";
import { coverageOfMatches, kindCompatible, matchPlacesToSpots, type MatchPlace } from "@/lib/domain/quality/navily-assistant";
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
  conflicts: number;
  decidedNotBerth: number;
  /** `correct / confirmed`; null when nothing is confirmed. */
  correctness: number | null;
};

export type MissReason = "no_candidate" | "matched_elsewhere" | "admin" | "unnamed_candidate" | "no_hits" | "too_few_sources" | "negative" | "restricted" | "rejected";

export type GatePlace = MatchPlace & { verdicts: Map<number, Verdict>; hasNames: boolean; hasHits: boolean; status: PlaceStatus; statusReason: string | null };

/** A confirmed place counted as an error: a spot of another kind, or a human "no berth" decision (`spotIndex` null without a spot). */
export type GateError = { placeId: string; kind: "wrong_kind" | "not_berth"; spotIndex: number | null; distanceM: number | null };

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
 * `matchPlacesToSpots`). A confirmed place matched to a spot of another kind is `wrongKind`, an error whatever a human
 * decided and not a conflict. Otherwise a human "no berth" decision is `decidedNotBerth` (an error, also when a spot
 * matches), else it is correct when matched to a spot of its kind or decided a berth, else a conflict (unmatched and undecided: the gate is not passed yet).
 *
 * Misses: the spots no confirmed place of the threshold matched (`coverageOfMatches`; the caller passes the spots of the
 * area). Each is matched alone against every place that has no spot at this threshold, whatever its status; the first
 * by matching order (kind, name, distance) gives the reason. Without one, a place that already has another spot gives
 * `matched_elsewhere`, else `no_candidate`.
 */
export function evaluateGate(
  input: { thresholds: number[]; places: GatePlace[]; spots: NavilySpot[]; decisions: Map<string, "berth" | "not_berth"> },
  cfg: Pick<AppConfig, "quality" | "nameAffixes">,
): { rows: GateRow[]; misses: Map<number, GateMiss[]>; conflicts: Map<number, string[]>; errors: Map<number, GateError[]> } {
  const { thresholds, places, spots, decisions } = input;
  const navily = cfg.quality.navily;
  const rows: GateRow[] = [];
  const misses = new Map<number, GateMiss[]>();
  const conflicts = new Map<number, string[]>();
  const errors = new Map<number, GateError[]>();

  for (const threshold of thresholds) {
    const confirmed = places.filter((p) => p.verdicts.get(threshold)?.status === "confirmed").map((p) => ({ ...p, status: "confirmed" as const }));
    const matches = matchPlacesToSpots(confirmed, spots, navily, cfg.nameAffixes);
    const row: GateRow = { threshold, confirmed: confirmed.length, correct: 0, wrongKind: 0, conflicts: 0, decidedNotBerth: 0, correctness: null };
    const open: string[] = [];
    const errs: GateError[] = [];
    for (const [i, p] of confirmed.entries()) {
      const spotIndex = matches[i]!.spotIndex;
      const spot = spotIndex === null ? null : spots[spotIndex]!;
      const decision = decisions.get(p.placeId);
      const at = { spotIndex, distanceM: matches[i]!.distanceM };
      if (spot && !kindCompatible(p.kind, spot.kind)) {
        row.wrongKind += 1;
        errs.push({ placeId: p.placeId, kind: "wrong_kind", ...at });
      } else if (decision === "not_berth") {
        row.decidedNotBerth += 1;
        errs.push({ placeId: p.placeId, kind: "not_berth", ...at });
      } else if (spot || decision === "berth") row.correct += 1;
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
    const coverage = coverageOfMatches(confirmed, matches, spots, () => true);
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
