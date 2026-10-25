import type { AppConfig } from "@/lib/config";
import { COMPARISON_ATTRIBUTES, type ComparisonAttribute, type PlaceStatus } from "@/lib/db/schema";
import type { BerthStateNearby, BerthStateValue } from "@/lib/db/schema/research-state";
import { attributesFromState, comparedPosition, comparisonValues } from "@/lib/domain/quality/comparison-values";
import { coverageOfMatches, kindCompatible, matchPlacesToSpots, proposeResults, type MatchPlace } from "@/lib/domain/quality/navily-assistant";
import type { LonLat } from "@/lib/domain/geometry/water";
import { distanceM, type NavilySpot } from "@/lib/domain/quality/navily-sample";
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
  /** Matched to a spot of its kind, but delivered a sector as clearly protected (≥ `gate.shelterErrorMin`) that the reference lists as not protected. */
  wrongShelter: number;
  /** Matched to a spot whose type is an anchoring ban (`quality.navily.prohibitedTypes`). */
  wrongProhibited: number;
  conflicts: number;
  decidedNotBerth: number;
  /** `correct / confirmed`; null when nothing is confirmed. */
  correctness: number | null;
  /** Spots in the area (without `quality.navily.excludedTypes`) that a correct place covers, over all of them; null without such a spot. */
  coverage: number | null;
};

export type MissReason = "no_candidate" | "matched_elsewhere" | "admin" | "unnamed_candidate" | "no_hits" | "too_few_sources" | "negative" | "restricted" | "rejected";

/** The current state of a berth as far as the gate reads it; null for a place without a `berth_states` row. */
export type GateState = { core: Record<string, BerthStateValue>; nearby: BerthStateNearby[] };

export type GatePlace = MatchPlace & {
  verdicts: Map<number, Verdict>;
  hasNames: boolean;
  hasHits: boolean;
  status: PlaceStatus;
  statusReason: string | null;
  state?: GateState | null;
};

/** The core values compared against the reference; existence and position the gate checks anyway, depth and food the reference does not have. */
export const GATE_CORE_ATTRIBUTES: readonly ComparisonAttribute[] = COMPARISON_ATTRIBUTES.filter((a) => !["existence", "position", "depth", "highlight.food"].includes(a));

/** Per core attribute over the confirmed places with a reference spot: how their own value stands against it. */
export type CoreAgreementCount = { match: number; deviation: number; gap: number; notAtNavily: number; noState: number };
export type CoreAgreement = Record<ComparisonAttribute, CoreAgreementCount>;

export const emptyAgreement = (): CoreAgreement =>
  Object.fromEntries(COMPARISON_ATTRIBUTES.map((a) => [a, { match: 0, deviation: 0, gap: 0, notAtNavily: 0, noState: 0 }])) as CoreAgreement;

/**
 * A confirmed place counted as an error: a spot of another kind matched by name, a spot of its kind too far away, a
 * sector delivered as protected that the reference does not list, a place matched to an anchoring-ban spot, or a human "no berth" decision (`spotIndex` null without a spot).
 */
export type GateError = { placeId: string; kind: GateErrorKind; spotIndex: number | null; distanceM: number | null };
export type GateErrorKind = "wrong_kind" | "position" | "not_berth" | "shelter" | "prohibited";

export type GateMiss = { spotIndex: number; reason: MissReason; placeId: string | null };

/** Whether the spot's type is one of `quality.navily.excludedTypes` (no berth to find: not counted, never a hit). */
export const isExcludedSpot = (s: NavilySpot, navily: Pick<AppConfig["quality"]["navily"], "excludedTypes">): boolean => s.type !== null && navily.excludedTypes.includes(s.type);

/**
 * The first sector the place claims as clearly protected (shelter value ≥ `gate.shelterErrorMin`) that the spot's
 * protection list lacks (case-insensitive); false without a state or without a list at the spot (nothing to compare).
 */
function claimsFalseShelter(state: GateState | null | undefined, spot: NavilySpot, minValue: number): boolean {
  if (!state || spot.prot === null) return false;
  const listed = new Set(spot.prot.map((p) => p.toLowerCase()));
  return COMPARISON_ATTRIBUTES.some((a) => {
    if (!a.startsWith("shelter.")) return false;
    const v = state.core[a]?.value;
    return typeof v === "number" && v >= minValue && !listed.has(a.slice("shelter.".length).toLowerCase());
  });
}

/** Counts the core attributes of one place against its spot; a missing own value where the reference has one is a gap (not a deviation). */
function countCore(into: CoreAgreement, p: GatePlace, spot: NavilySpot, navily: AppConfig["quality"]["navily"]): void {
  if (!p.state) {
    for (const a of GATE_CORE_ATTRIBUTES) into[a].noState += 1;
    return;
  }
  const subject = {
    placeId: p.placeId, publicId: null, name: null, names: p.names, kind: p.kind, status: p.status, position: p.position, anchorPosition: p.anchorPosition,
    attributes: attributesFromState(p.state.core, p.state.nearby), profileVersion: null,
  };
  const values = comparisonValues(subject, navily);
  const proposed = proposeResults(values, { position: p.position }, spot, navily);
  for (const a of GATE_CORE_ATTRIBUTES) {
    const r = proposed[a];
    if (r === "match") into[a].match += 1;
    else if (r === "not_at_navily") into[a].notAtNavily += 1;
    else if (values[a].value === null) into[a].gap += 1;
    else into[a].deviation += 1;
  }
}

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
 * - `wrongProhibited` (checked first, an error whatever a human decided): a spot of a prohibited type within
 *   `gate.maxPositionDeviationM` of the compared position (the anchor position for a field place), or matched to one;
 * - `wrongKind` (an error whatever a human decided): matched by name (similarity ≥ `quality.navily.nameMin`) to a spot
 *   whose kind is known and incompatible (revised ruling: a match by distance only, or to a spot of unknown kind, says
 *   nothing about the kind and is a conflict instead);
 * - `wrongPosition` (an error whatever a human decided): matched to a spot of its kind farther than
 *   `research.gate.maxPositionDeviationM`;
 * - `decidedNotBerth` (an error, also when a spot matches): a human "no berth" decision;
 * - correct: matched to a spot of its kind, or decided a berth; a spot of an excluded type (dry berthing) is no hit;
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
): { rows: GateRow[]; misses: Map<number, GateMiss[]>; conflicts: Map<number, string[]>; errors: Map<number, GateError[]>; core: Map<number, CoreAgreement> } {
  const { thresholds, places, spots, decisions } = input;
  const inArea = input.inArea ?? (() => true);
  const navily = cfg.quality.navily;
  const maxDeviation = cfg.research.gate.maxPositionDeviationM;
  const isExcluded = (s: NavilySpot) => isExcludedSpot(s, navily);
  const isProhibited = (s: NavilySpot) => s.type !== null && navily.prohibitedTypes.includes(s.type);
  const nearestProhibited = (p: GatePlace): { spotIndex: number; distanceM: number } | null => {
    const at = comparedPosition(p);
    let best: { spotIndex: number; distanceM: number } | null = null;
    for (const [i, s] of spots.entries()) {
      if (!isProhibited(s)) continue;
      const d = distanceM(at, s);
      if (d <= maxDeviation && (best === null || d < best.distanceM)) best = { spotIndex: i, distanceM: d };
    }
    return best;
  };
  const rows: GateRow[] = [];
  const misses = new Map<number, GateMiss[]>();
  const conflicts = new Map<number, string[]>();
  const errors = new Map<number, GateError[]>();
  const core = new Map<number, CoreAgreement>();

  for (const threshold of thresholds) {
    const confirmed = places.filter((p) => p.verdicts.get(threshold)?.status === "confirmed").map((p) => ({ ...p, status: "confirmed" as const }));
    const matches = matchPlacesToSpots(confirmed, spots, navily, cfg.nameAffixes);
    const row: GateRow = { threshold, confirmed: confirmed.length, correct: 0, wrongKind: 0, wrongPosition: 0, wrongShelter: 0, wrongProhibited: 0, conflicts: 0, decidedNotBerth: 0, correctness: null, coverage: null };
    const covered = new Set<number>();
    const agreement = emptyAgreement();
    const open: string[] = [];
    const errs: GateError[] = [];
    for (const [i, p] of confirmed.entries()) {
      const match = matches[i]!;
      const spot = match.spotIndex === null ? null : spots[match.spotIndex]!;
      const kindOk = spot !== null && kindCompatible(p.kind, spot.kind);
      // a spot of an excluded type (dry berthing, ban) is never a hit
      const compatible = kindOk && !isExcluded(spot);
      const decision = decisions.get(p.placeId);
      if (compatible) countCore(agreement, p, spot, navily);
      const at = { spotIndex: match.spotIndex, distanceM: match.distanceM };
      // independent of the matching: a prohibited spot within reach of the place's compared position is an error, whichever spot the match took
      const ban = nearestProhibited(p) ?? (spot && isProhibited(spot) && match.distanceM !== null ? { spotIndex: match.spotIndex!, distanceM: match.distanceM } : null);
      if (ban) {
        row.wrongProhibited += 1;
        errs.push({ placeId: p.placeId, kind: "prohibited", spotIndex: ban.spotIndex, distanceM: ban.distanceM });
      } else if (spot && spot.kind !== null && !kindOk && !isExcluded(spot) && (match.nameSimilarity ?? 0) >= navily.nameMin) {
        row.wrongKind += 1;
        errs.push({ placeId: p.placeId, kind: "wrong_kind", ...at });
      } else if (compatible && match.distanceM! > maxDeviation) {
        row.wrongPosition += 1;
        errs.push({ placeId: p.placeId, kind: "position", ...at });
      } else if (decision === "not_berth") {
        row.decidedNotBerth += 1;
        errs.push({ placeId: p.placeId, kind: "not_berth", ...at });
      } else if (compatible && claimsFalseShelter(p.state, spot, cfg.research.gate.shelterErrorMin)) {
        row.wrongShelter += 1;
        errs.push({ placeId: p.placeId, kind: "shelter", ...at });
      } else if (compatible || decision === "berth") {
        // a human "berth" decision stays correct on a spot of an excluded type (dry berthing), but covers nothing
        row.correct += 1;
        if (compatible) covered.add(match.spotIndex!);
      }
      else {
        row.conflicts += 1;
        open.push(p.placeId);
      }
    }
    row.correctness = row.confirmed === 0 ? null : row.correct / row.confirmed;
    const counted = spots.flatMap((s, i) => (inArea(s) && !isExcluded(s) ? [i] : []));
    row.coverage = counted.length === 0 ? null : counted.filter((i) => covered.has(i)).length / counted.length;
    rows.push(row);
    conflicts.set(threshold, open);
    errors.set(threshold, errs);
    core.set(threshold, agreement);

    const matchedPlaces = new Set(matches.filter((m) => m.spotIndex !== null).map((m) => m.placeId));
    const pool = places.filter((p) => !matchedPlaces.has(p.placeId)).map((p) => ({ ...p, status: "candidate" as const }));
    const matchedPool = places.filter((p) => matchedPlaces.has(p.placeId)).map((p) => ({ ...p, status: "candidate" as const }));
    const byId = new Map(places.map((p) => [p.placeId, p]));
    const coverage = coverageOfMatches(confirmed, matches, spots, inArea);
    misses.set(
      threshold,
      coverage.unmatchedSpotIndexes.filter((i) => !isExcluded(spots[i]!)).map((spotIndex): GateMiss => {
        const near = matchPlacesToSpots(pool, [spots[spotIndex]!], navily, cfg.nameAffixes).find((m) => m.spotIndex !== null);
        if (near) return { spotIndex, reason: reasonOf(byId.get(near.placeId)!, threshold), placeId: near.placeId };
        const taken = matchPlacesToSpots(matchedPool, [spots[spotIndex]!], navily, cfg.nameAffixes).find((m) => m.spotIndex !== null);
        return { spotIndex, reason: taken ? "matched_elsewhere" : "no_candidate", placeId: taken?.placeId ?? null };
      }),
    );
  }
  return { rows, misses, conflicts, errors, core };
}
