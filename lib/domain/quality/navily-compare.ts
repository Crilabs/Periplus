import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Point } from "geojson";
import type { NameAffixesConfig } from "@/lib/config";
import type { QualityConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, places, runs } from "@/lib/db/schema";
import { canonicalJson } from "@/lib/domain/facts/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
import { tileIdFor } from "@/lib/domain/tiles";
import { latestProfiles } from "@/lib/domain/timeline";
import { validAt } from "@/lib/db/valid-at";
import {
  latestComparisonResults,
  lockComparisonPlace,
  recordComparisonResults,
  StaleComparison,
  type LatestComparisonResult,
} from "./comparison-results";
import {
  COMPARISON_ATTRIBUTES,
  comparedPosition,
  comparisonValues,
  loadComparisonSubjects,
  lonLatOf,
  type ComparisonAttribute,
  type ComparisonSubject,
  type ComparisonValue,
} from "./comparison-values";
import {
  coverageOfMatches,
  matchPlacesToSpots,
  proposeResults,
  type MatchPlace,
  type NavilyMatch,
  type ProposedResult,
} from "./navily-assistant";
import { distanceM, type NavilySpot } from "./navily-sample";

/*
 * The comparison of a subdivision's set against Navily as the page `/quality/compare` shows and records it. Grundprinzip 9:
 * the spot list is passed in at request time and only lives in the returned view (rendered, never cached or stored);
 * what is recorded goes through `recordComparisonResults` (outcome, own value hash and own display only).
 */

type NavilyConfig = QualityConfig["navily"];
type Settings = { cfg: NavilyConfig; affixes: NameAffixesConfig };

/** A confirmed, valid place of the subdivision (its geo object belongs to it), with all its valid names. */
export type SubdivisionPlace = MatchPlace & { name: string | null };

/**
 * The confirmed, valid places of the subdivision (`geo_objects.subdivision_id`, nearest land); empty for an unknown
 * subdivision. Their positions are the
 * delivered ones of the newest profile (`place.position`, else the place point, and `anchor_position`), as for the
 * comparison set, so matching and coverage measure from the point the contract delivers.
 */
export async function confirmedSubdivisionPlaces(db: Db, subdivisionKey: string): Promise<SubdivisionPlace[]> {
  const sub = await subdivisionByKey(db, subdivisionKey);
  if (!sub) return [];
  const rows = await db
    .select({
      placeId: places.id,
      geoObjectId: places.geoObjectId,
      name: displayNameSql(places.geoObjectId),
      kind: places.kind,
      position: asGeoJson(places.position),
    })
    .from(places)
    .innerJoin(geoObjects, eq(geoObjects.id, places.geoObjectId))
    .where(and(eq(geoObjects.subdivisionId, sub.id), eq(places.status, "confirmed"), validAt(places)))
    .orderBy(asc(places.id));
  if (rows.length === 0) return [];
  const objectIds = rows.map((r) => r.geoObjectId);
  const nameRows = await db
    .selectDistinct({ geoObjectId: geoNames.geoObjectId, name: geoNames.name })
    .from(geoNames)
    .where(and(inArray(geoNames.geoObjectId, objectIds), validAt(geoNames)))
    .orderBy(asc(geoNames.geoObjectId), asc(geoNames.name));
  const namesOf = new Map<string, string[]>();
  for (const n of nameRows) namesOf.set(n.geoObjectId, [...(namesOf.get(n.geoObjectId) ?? []), n.name]);
  const profileOf = await latestProfiles(db, objectIds);
  return rows.map((r) => {
    const [lon, lat] = (r.position as Point).coordinates as [number, number];
    const attributes = profileOf.get(r.geoObjectId)?.attributes ?? {};
    return {
      placeId: r.placeId,
      name: r.name,
      kind: r.kind,
      status: "confirmed" as const,
      position: lonLatOf(attributes["place.position"]) ?? { lon, lat },
      anchorPosition: lonLatOf(attributes["anchor_position"]),
      names: namesOf.get(r.geoObjectId) ?? [],
    };
  });
}

/** Whether a point lies in a tile of the subdivision's run scope (`subdivisionTileIds`: coast tiles that meet its polygon). */
export async function subdivisionTilePredicate(db: Db, subdivisionKey: string): Promise<(p: { lon: number; lat: number }) => boolean> {
  const sub = await subdivisionByKey(db, subdivisionKey);
  if (!sub) return () => false;
  const ids = new Set(await subdivisionTileIds(db, sub.id));
  return (p) => ids.has(tileIdFor(p.lon, p.lat));
}

/** Whether `runId` is an evaluation run (`params.evaluation`), the only runs the page compares profiles of. */
export async function isEvaluationRun(db: Db, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), sql`${runs.params} @> '{"evaluation": true}'::jsonb`));
  return row !== undefined;
}

type Proposal = {
  match: NavilyMatch;
  spot: NavilySpot | null;
  values: Record<ComparisonAttribute, ComparisonValue>;
  proposals: Record<ComparisonAttribute, ProposedResult>;
};

/**
 * The places a set is matched with: the set's subjects and every other confirmed place of the subdivision. Matching over all
 * of them (rulings M7-B-R1 item 2 and M7-B-R2) means a spot that is nearer to a confirmed place outside the set is
 * never given to a set place, and confirmed places match before non-confirmed set members.
 */
export function matchingPlaces(subjects: ComparisonSubject[], areaPlaces: SubdivisionPlace[]): MatchPlace[] {
  const inSet = new Set(subjects.map((s) => s.placeId));
  return [...subjects, ...areaPlaces.filter((p) => !inSet.has(p.placeId))];
}

/**
 * The proposals of each subject, matched over the set and all confirmed places of the subdivision (`matchingPlaces`); also
 * returns the matching for the coverage. The page, the accept action and the CLI share this function.
 */
export function proposalsFor(
  subjects: ComparisonSubject[],
  areaPlaces: SubdivisionPlace[],
  spots: NavilySpot[],
  { cfg, affixes }: Settings,
): { proposals: Map<string, Proposal>; places: MatchPlace[]; matches: NavilyMatch[] } {
  const all = matchingPlaces(subjects, areaPlaces);
  const matches = matchPlacesToSpots(all, spots, cfg, affixes);
  const proposals = new Map(
    subjects.map((s, i) => {
      const match = matches[i]!;
      const spot = match.spotIndex === null ? null : spots[match.spotIndex]!;
      const values = comparisonValues(s, cfg);
      return [s.placeId, { match, spot, values, proposals: proposeResults(values, { position: comparedPosition(s) }, spot, cfg) }];
    }),
  );
  return { proposals, places: all, matches };
}

/**
 * The digest of the proposals a page shows for a place: per attribute in `COMPARISON_ATTRIBUTES` order the own value
 * hash and the proposed outcome (no Navily value). Accepting is refused when the recomputed digest differs.
 */
export function proposalDigest(rows: Array<{ attribute: ComparisonAttribute; valueHash: string; proposal: ProposedResult }>): string {
  const byAttribute = new Map(rows.map((r) => [r.attribute, r]));
  const ordered = COMPARISON_ATTRIBUTES.map((a) => {
    const r = byAttribute.get(a);
    if (!r) throw new Error(`the digest needs every compared attribute, ${a} is missing`);
    return [a, r.valueHash, r.proposal];
  });
  return createHash("sha256").update(canonicalJson(ordered)).digest("hex").slice(0, 16);
}

const digestOf = (p: Proposal) =>
  proposalDigest(COMPARISON_ATTRIBUTES.map((attribute) => ({ attribute, valueHash: p.values[attribute].hash, proposal: p.proposals[attribute] })));

/**
 * Inside the write transaction: takes the place's comparison lock, then loads the comparison set (so the subject is
 * the one the outcome is recorded for, ruling M7-B-R2) and finds the place in it.
 */
async function lockedSubjects(tx: Db, subdivisionKey: string, placeId: string, evaluationRunId?: string) {
  await lockComparisonPlace(tx, placeId);
  const subjects = await loadComparisonSubjects(tx, subdivisionKey, { evaluationRunId });
  const subject = subjects.find((s) => s.placeId === placeId);
  if (!subject) throw new Error(`place ${placeId} is not in the comparison set of subdivision ${subdivisionKey}`);
  return { subjects, subject };
}

/**
 * Records one outcome a person gave for the current own value (method `manual`); a `valueHash` that is not the current
 * value's hash fails with `StaleComparison` and writes nothing. The subject is loaded inside the write transaction.
 */
export async function recordManualComparison(
  db: Db,
  input: {
    placeId: string;
    subdivisionKey: string;
    attribute: ComparisonAttribute;
    result: "match" | "deviation" | "not_at_navily";
    valueHash: string;
    evaluationRunId?: string;
    checkedBy: string;
    cfg: NavilyConfig;
  },
): Promise<{ written: number; tasks: number }> {
  return db.transaction(async (tx) => {
    const { subject } = await lockedSubjects(tx, input.subdivisionKey, input.placeId, input.evaluationRunId);
    return recordComparisonResults(tx, {
      subject,
      entries: [{ attribute: input.attribute, result: input.result, valueHash: input.valueHash, profileVersion: subject.profileVersion }],
      evaluationRunId: input.evaluationRunId,
      method: "manual",
      checkedBy: input.checkedBy,
      cfg: input.cfg,
    });
  });
}

/**
 * Confirms the proposals of one place that the admin saw (method `proposal_confirmed`). Values and proposals are
 * recomputed here, inside the write transaction, from the current profile and the spots (never taken from a client);
 * `digest` is the `proposalDigest` of the shown proposals, and any difference fails with `StaleComparison`, nothing
 * written. An attribute whose newest outcome for its current value was set by hand (`manual`) and differs from the
 * proposal is kept, never overwritten (`skippedManual` counts them); review outcomes are kept by
 * `recordComparisonResults` (ruling M7-P16).
 */
export async function acceptNavilyProposals(
  db: Db,
  input: { placeId: string; subdivisionKey: string; evaluationRunId?: string; spots: NavilySpot[]; digest: string; checkedBy: string } & Settings,
): Promise<{ written: number; tasks: number; skippedManual: number }> {
  return db.transaction(async (tx) => {
    const { subjects, subject } = await lockedSubjects(tx, input.subdivisionKey, input.placeId, input.evaluationRunId);
    const areaPlaces = await confirmedSubdivisionPlaces(tx, input.subdivisionKey);
    const proposal = proposalsFor(subjects, areaPlaces, input.spots, input).proposals.get(subject.placeId)!;
    if (digestOf(proposal) !== input.digest) throw new StaleComparison(subject.placeId, "proposals");
    const latest = await latestComparisonResults(tx, [subject.placeId]);
    let skippedManual = 0;
    const entries = COMPARISON_ATTRIBUTES.flatMap((attribute) => {
      const valueHash = proposal.values[attribute].hash;
      const result = proposal.proposals[attribute];
      const previous = latest.get(`${subject.placeId}|${attribute}|${valueHash}`);
      if (previous?.method === "manual" && previous.result !== result) {
        skippedManual++;
        return [];
      }
      return [{ attribute, result, valueHash, profileVersion: subject.profileVersion }];
    });
    const out = await recordComparisonResults(tx, {
      subject,
      entries,
      evaluationRunId: input.evaluationRunId,
      method: "proposal_confirmed",
      checkedBy: input.checkedBy,
      cfg: input.cfg,
    });
    return { ...out, skippedManual };
  });
}

export type ComparisonRow = {
  attribute: ComparisonAttribute;
  value: ComparisonValue;
  /** Null without a Navily file. */
  proposal: ProposedResult | null;
  /** The newest outcome for the current own value; null when it is still open. */
  stored: (LatestComparisonResult & { carried: boolean }) | null;
};

export type PlaceComparison = {
  subject: ComparisonSubject;
  rows: ComparisonRow[];
  /** Attributes without an outcome for their current value. */
  open: number;
  /** Runtime only: the matched spot and the distance of the compared position to it. */
  spot: NavilySpot | null;
  match: NavilyMatch | null;
  positionDistanceM: number | null;
  /** `proposalDigest` of the shown proposals, posted back on „Alle Vorschläge übernehmen“; null without spots. */
  digest: string | null;
};

export type UnmatchedSpot = { spot: NavilySpot; nearest: { placeId: string; name: string | null; distanceM: number } | null };

export type SubdivisionComparisonView = {
  places: PlaceComparison[];
  checked: number;
  total: number;
  /** Null without a Navily file. */
  coverage: { spots: number; matched: number; ratio: number | null } | null;
  /** Runtime only: spots in the subdivision no confirmed place matches. */
  unmatchedSpots: UnmatchedSpot[];
};

/**
 * The comparison of the subdivision's set: own values, proposals (with spots) and their digest, the newest outcome per
 * current value hash (`carried` when it was recorded on another profile version or evaluation run) and the coverage
 * of the subdivision's spots from the same matching the proposals use (set plus all confirmed places of the subdivision).
 */
export async function subdivisionComparisonView(
  db: Db,
  input: { subdivisionKey: string; evaluationRunId?: string; spots: NavilySpot[] | null } & Settings,
): Promise<SubdivisionComparisonView> {
  const subjects = await loadComparisonSubjects(db, input.subdivisionKey, { evaluationRunId: input.evaluationRunId });
  const latest = await latestComparisonResults(db, subjects.map((s) => s.placeId));
  const areaPlaces = input.spots ? await confirmedSubdivisionPlaces(db, input.subdivisionKey) : [];
  const matching = input.spots ? proposalsFor(subjects, areaPlaces, input.spots, input) : null;
  const proposals = matching?.proposals ?? null;
  const evaluationRunId = input.evaluationRunId ?? null;

  const placeViews = subjects.map((subject): PlaceComparison => {
    const values = proposals?.get(subject.placeId)?.values ?? comparisonValues(subject, input.cfg);
    const p = proposals?.get(subject.placeId) ?? null;
    const rows = COMPARISON_ATTRIBUTES.map((attribute): ComparisonRow => {
      const value = values[attribute];
      const stored = latest.get(`${subject.placeId}|${attribute}|${value.hash}`) ?? null;
      return {
        attribute,
        value,
        proposal: p?.proposals[attribute] ?? null,
        stored: stored && {
          ...stored,
          carried: stored.profileVersion !== subject.profileVersion || stored.evaluationRunId !== evaluationRunId,
        },
      };
    });
    return {
      subject,
      rows,
      open: rows.filter((r) => r.stored === null).length,
      spot: p?.spot ?? null,
      match: p?.match ?? null,
      positionDistanceM: p?.spot ? distanceM(comparedPosition(subject), p.spot) : null,
      digest: p ? digestOf(p) : null,
    };
  });

  let coverage: SubdivisionComparisonView["coverage"] = null;
  let unmatchedSpots: UnmatchedSpot[] = [];
  if (input.spots && matching) {
    const spots = input.spots;
    const inArea = await subdivisionTilePredicate(db, input.subdivisionKey);
    const c = coverageOfMatches(matching.places, matching.matches, spots, inArea, new Set(areaPlaces.map((p) => p.placeId)));
    coverage = { spots: c.spots, matched: c.matched, ratio: c.ratio };
    unmatchedSpots = c.unmatchedSpotIndexes.map((i) => {
      const spot = spots[i]!;
      let nearest: UnmatchedSpot["nearest"] = null;
      for (const p of areaPlaces) {
        const d = distanceM(comparedPosition(p), spot);
        if (!nearest || d < nearest.distanceM) nearest = { placeId: p.placeId, name: p.name, distanceM: d };
      }
      return { spot, nearest };
    });
  }

  return {
    places: placeViews,
    checked: placeViews.reduce((n, p) => n + p.rows.length - p.open, 0),
    total: placeViews.length * COMPARISON_ATTRIBUTES.length,
    coverage,
    unmatchedSpots,
  };
}
