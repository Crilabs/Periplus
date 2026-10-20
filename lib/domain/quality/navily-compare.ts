import { and, asc, eq, inArray } from "drizzle-orm";
import type { Point } from "geojson";
import type { NameAffixesConfig } from "@/lib/config";
import type { QualityConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import { geoNames, places, tiles } from "@/lib/db/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { tileIdFor } from "@/lib/domain/tiles";
import { validAt } from "@/lib/domain/timeline";
import { areaGeoObjectId } from "@/lib/pipeline/tile-scope";
import { latestComparisonResults, recordComparisonResults, type LatestComparisonResult } from "./comparison-results";
import {
  COMPARISON_ATTRIBUTES,
  comparedPosition,
  comparisonValues,
  loadComparisonSubjects,
  type ComparisonAttribute,
  type ComparisonSubject,
  type ComparisonValue,
} from "./comparison-values";
import { matchPlacesToSpots, navilyCoverage, proposeResults, type NavilyMatch, type ProposedResult } from "./navily-assistant";
import { distanceM, type NavilySpot } from "./navily-sample";

/*
 * The comparison of an area's set against Navily as the page `/quality/compare` shows and records it. Grundprinzip 9:
 * the spot list is passed in at request time and only lives in the returned view (rendered, never cached or stored);
 * what is recorded goes through `recordComparisonResults` (outcome, own value hash and own display only).
 */

type NavilyConfig = QualityConfig["navily"];
type Settings = { cfg: NavilyConfig; affixes: NameAffixesConfig };

/** A confirmed, valid place of the area (in a tile labelled with it), with all its valid names. */
export type AreaPlace = Pick<ComparisonSubject, "placeId" | "kind" | "position" | "names"> & { name: string | null };

/** The confirmed, valid places in the tiles labelled with the area; empty for an unknown area. */
export async function confirmedAreaPlaces(db: Db, areaKey: string): Promise<AreaPlace[]> {
  const areaId = await areaGeoObjectId(db, areaKey);
  if (!areaId) return [];
  const rows = await db
    .select({
      placeId: places.id,
      geoObjectId: places.geoObjectId,
      name: displayNameSql(places.geoObjectId),
      kind: places.kind,
      position: asGeoJson(places.position),
    })
    .from(places)
    .innerJoin(tiles, eq(tiles.id, places.tileId))
    .where(and(eq(tiles.areaId, areaId), eq(places.status, "confirmed"), validAt(places)))
    .orderBy(asc(places.id));
  if (rows.length === 0) return [];
  const nameRows = await db
    .selectDistinct({ geoObjectId: geoNames.geoObjectId, name: geoNames.name })
    .from(geoNames)
    .where(and(inArray(geoNames.geoObjectId, rows.map((r) => r.geoObjectId)), validAt(geoNames)));
  const namesOf = new Map<string, string[]>();
  for (const n of nameRows) namesOf.set(n.geoObjectId, [...(namesOf.get(n.geoObjectId) ?? []), n.name]);
  return rows.map((r) => {
    const [lon, lat] = (r.position as Point).coordinates as [number, number];
    return { placeId: r.placeId, name: r.name, kind: r.kind, position: { lon, lat }, names: namesOf.get(r.geoObjectId) ?? [] };
  });
}

/** Whether a point lies in a tile labelled with the area (the scope the area's places come from). */
export async function areaTilePredicate(db: Db, areaKey: string): Promise<(p: { lon: number; lat: number }) => boolean> {
  const areaId = await areaGeoObjectId(db, areaKey);
  if (!areaId) return () => false;
  const ids = new Set((await db.select({ id: tiles.id }).from(tiles).where(eq(tiles.areaId, areaId))).map((t) => t.id));
  return (p) => ids.has(tileIdFor(p.lon, p.lat));
}

/** The proposals of each subject against the spots (matched over the given subjects); null without spots. */
export function proposalsFor(
  subjects: ComparisonSubject[],
  spots: NavilySpot[],
  { cfg, affixes }: Settings,
): Map<string, { match: NavilyMatch; spot: NavilySpot | null; values: Record<ComparisonAttribute, ComparisonValue>; proposals: Record<ComparisonAttribute, ProposedResult> }> {
  const matches = matchPlacesToSpots(subjects, spots, cfg, affixes);
  return new Map(
    subjects.map((s, i) => {
      const match = matches[i]!;
      const spot = match.spotIndex === null ? null : spots[match.spotIndex]!;
      const values = comparisonValues(s, cfg);
      return [s.placeId, { match, spot, values, proposals: proposeResults(values, { position: comparedPosition(s) }, spot, cfg) }];
    }),
  );
}

async function subjectsAndOne(db: Db, areaKey: string, placeId: string, evaluationRunId?: string) {
  const subjects = await loadComparisonSubjects(db, areaKey, { evaluationRunId });
  const subject = subjects.find((s) => s.placeId === placeId);
  if (!subject) throw new Error(`place ${placeId} is not in the comparison set of area ${areaKey}`);
  return { subjects, subject };
}

/**
 * Records one outcome a person gave for the current own value (method `manual`); a `valueHash` that is not the current
 * value's hash fails with `StaleComparison` and writes nothing.
 */
export async function recordManualComparison(
  db: Db,
  input: {
    placeId: string;
    areaKey: string;
    attribute: ComparisonAttribute;
    result: "match" | "deviation" | "not_at_navily";
    valueHash: string;
    evaluationRunId?: string;
    checkedBy: string;
    cfg: NavilyConfig;
  },
): Promise<{ written: number; tasks: number }> {
  const { subject } = await subjectsAndOne(db, input.areaKey, input.placeId, input.evaluationRunId);
  return recordComparisonResults(db, {
    subject,
    entries: [{ attribute: input.attribute, result: input.result, valueHash: input.valueHash, profileVersion: subject.profileVersion }],
    evaluationRunId: input.evaluationRunId,
    method: "manual",
    checkedBy: input.checkedBy,
    cfg: input.cfg,
  });
}

/**
 * Confirms the proposals of one place, recomputed here from the current values and the spots (never taken from a
 * client), one outcome per compared attribute with method `proposal_confirmed`.
 */
export async function acceptNavilyProposals(
  db: Db,
  input: { placeId: string; areaKey: string; evaluationRunId?: string; spots: NavilySpot[]; checkedBy: string } & Settings,
): Promise<{ written: number; tasks: number }> {
  const { subjects, subject } = await subjectsAndOne(db, input.areaKey, input.placeId, input.evaluationRunId);
  const { values, proposals } = proposalsFor(subjects, input.spots, input).get(subject.placeId)!;
  return recordComparisonResults(db, {
    subject,
    entries: COMPARISON_ATTRIBUTES.map((attribute) => ({
      attribute,
      result: proposals[attribute],
      valueHash: values[attribute].hash,
      profileVersion: subject.profileVersion,
    })),
    evaluationRunId: input.evaluationRunId,
    method: "proposal_confirmed",
    checkedBy: input.checkedBy,
    cfg: input.cfg,
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
};

export type UnmatchedSpot = { spot: NavilySpot; nearest: { placeId: string; name: string | null; distanceM: number } | null };

export type AreaComparisonView = {
  places: PlaceComparison[];
  checked: number;
  total: number;
  /** Null without a Navily file. */
  coverage: { spots: number; matched: number; ratio: number | null } | null;
  /** Runtime only: spots in the area no confirmed place matches. */
  unmatchedSpots: UnmatchedSpot[];
};

/**
 * The comparison of the area's set: own values, proposals (with spots), the newest outcome per current value hash
 * (`carried` when it was recorded on another profile version or evaluation run) and the coverage of the area's spots
 * against all its confirmed places.
 */
export async function areaComparisonView(
  db: Db,
  input: { areaKey: string; evaluationRunId?: string; spots: NavilySpot[] | null } & Settings,
): Promise<AreaComparisonView> {
  const subjects = await loadComparisonSubjects(db, input.areaKey, { evaluationRunId: input.evaluationRunId });
  const latest = await latestComparisonResults(db, subjects.map((s) => s.placeId));
  const proposals = input.spots ? proposalsFor(subjects, input.spots, input) : null;
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
    };
  });

  let coverage: AreaComparisonView["coverage"] = null;
  let unmatchedSpots: UnmatchedSpot[] = [];
  if (input.spots) {
    const spots = input.spots;
    const areaPlaces = await confirmedAreaPlaces(db, input.areaKey);
    const inArea = await areaTilePredicate(db, input.areaKey);
    const c = navilyCoverage(areaPlaces, spots, inArea, input.cfg, input.affixes);
    coverage = { spots: c.spots, matched: c.matched, ratio: c.ratio };
    unmatchedSpots = c.unmatchedSpotIndexes.map((i) => {
      const spot = spots[i]!;
      let nearest: UnmatchedSpot["nearest"] = null;
      for (const p of areaPlaces) {
        const d = distanceM(p.position, spot);
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
