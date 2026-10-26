import type { NameAffixesConfig } from "@/lib/config";
import type { QualityConfig } from "@/lib/config/schemas";
import type { SeabedType } from "@/lib/db/schema";
import { getEnv, type Env } from "@/lib/env";
import { normalizeName, transliterateElot743 } from "@/lib/domain/gazetteer/names";
import type { LonLat } from "@/lib/domain/geometry/water";
import { stripAffix } from "@/lib/domain/research/util/affixes";
import {
  COMPARISON_ATTRIBUTES,
  comparedPosition,
  type ComparisonAttribute,
  type ComparisonSubject,
  type ComparisonValue,
} from "./comparison-values";
import { distanceM, loadNavilySpots, navilySeabedTypes, type NavilySpot } from "./navily-sample";
import { similarityOfSets, trigrams } from "./trigram";

/*
 * The Navily assistant (spec 10): matches the places of a subdivision to the spots of the Navily file and proposes an
 * outcome per compared attribute. Grundprinzip 9: everything here is pure and runs at request or CLI time; the spot
 * list lives in memory only, and what leaves this module is an outcome per attribute, a distance, a similarity or an
 * index into the loaded list (meaningful only while the list is loaded), never a Navily name, id, url or value.
 */

type NavilyConfig = QualityConfig["navily"];
/** A place as matched: its delivered point (`comparedPosition`) and names; confirmed places match before all others. */
export type MatchPlace = Pick<ComparisonSubject, "placeId" | "kind" | "status" | "position" | "anchorPosition" | "names">;
export type ProposedResult = "match" | "deviation" | "not_at_navily";

/** A place and the spot matched to it; `spotIndex` indexes the loaded spot list (runtime only), null without a match. */
export type NavilyMatch = { placeId: string; spotIndex: number | null; distanceM: number | null; nameSimilarity: number | null };

/** The forms a name is compared in: the full form (transliterated per ELOT 743, normalised) and its core. */
type NameForms = { full: Set<string>; core: Set<string> | null };

/** The core of a name is the full form with a generic affix („Ormos“, „Bay“, „Porto“) stripped, when it has one. */
function nameForms(name: string, affixes: NameAffixesConfig): NameForms {
  const form = normalizeName(transliterateElot743(name));
  const core = stripAffix(form, affixes)?.core;
  return { full: trigrams(form), core: core && core !== form ? trigrams(core) : null };
}

/**
 * Similarity of two names: the better of the full forms and the cores (ruling M7-B-R2). The cores alone lose the
 * shared affix trigrams, so a short core with a spelling variant falls below `nameMin` („Porto Cheli“ vs „Porto Heli“
 * 0.375 on the cores, 0.643 on the full forms); the full forms alone miss a differing affix („Ormos Vathy“ vs
 * „Vathy Bay“).
 */
function formsSimilarity(a: NameForms, b: NameForms): number {
  return Math.max(similarityOfSets(a.full, b.full), similarityOfSets(a.core ?? a.full, b.core ?? b.full));
}

/** Best similarity between the own names and the spot's name; 0 without a spot name. */
export function nameSimilarity(ownNames: string[], spotName: string | null, affixes: NameAffixesConfig): number {
  if (spotName === null) return 0;
  const spot = nameForms(spotName, affixes);
  return Math.max(0, ...ownNames.map((n) => formsSimilarity(nameForms(n, affixes), spot)));
}

/** Harbours (`port`, `marina`) pair with a Navily `port`, all other kinds with a Navily `mooring`. */
export function kindCompatible(kind: MatchPlace["kind"], navilyKind: NavilySpot["kind"]): boolean {
  return navilyKind === (kind === "port" || kind === "marina" ? "port" : "mooring");
}

/** Metres per degree of latitude on the haversine sphere, rounded down (a cheap prefilter only). */
const METRES_PER_DEGREE_LAT = 111_000;

/**
 * Matches places to spots on each place's delivered point (`comparedPosition`: the anchor position of a bay, the
 * place point of a harbour). A spot is a candidate of a place within `maxRadiusM` when its name is strongly similar
 * (≥ `nameStrongMin`), similar (≥ `nameMin`) within `nameRadiusM`, or it lies within `nearRadiusM` whatever its name.
 *
 * Two passes (ruling M7-B-R2): the confirmed places first, then all others against the spots left over, so a
 * rejected or candidate duplicate never takes the spot of a confirmed place. Within a pass candidates are taken
 * greedily by kind compatibility, similarity class (strong, named, none), distance (ascending), then place and spot
 * index (ruling M7-B-R3: a bay never prefers an incompatible port over a compatible mooring, whatever the names);
 * each spot and each place is matched at most once. One match per place, in input order.
 */
export function matchPlacesToSpots(
  places: MatchPlace[],
  spots: NavilySpot[],
  cfg: NavilyConfig,
  affixes: NameAffixesConfig,
): NavilyMatch[] {
  const spotForms = new Map<number, NameForms | null>();
  const formsOfSpot = (i: number) => {
    if (!spotForms.has(i)) {
      const name = spots[i]!.name;
      spotForms.set(i, name === null ? null : nameForms(name, affixes));
    }
    return spotForms.get(i)!;
  };
  const maxLatDelta = cfg.maxRadiusM / METRES_PER_DEGREE_LAT;
  const classOf = (similarity: number) => (similarity >= cfg.nameStrongMin ? 2 : similarity >= cfg.nameMin ? 1 : 0);

  type Candidate = { place: number; spot: number; distance: number; similarity: number; compatible: boolean };
  const candidatesOf = (pi: number): Candidate[] => {
    const p = places[pi]!;
    const at = comparedPosition(p);
    const own = p.names.map((n) => nameForms(n, affixes));
    const out: Candidate[] = [];
    spots.forEach((s, si) => {
      if (Math.abs(s.lat - at.lat) > maxLatDelta) return;
      const distance = distanceM(at, s);
      if (distance > cfg.maxRadiusM) return;
      const forms = formsOfSpot(si);
      const similarity = forms === null ? 0 : Math.max(0, ...own.map((o) => formsSimilarity(o, forms)));
      const candidate =
        similarity >= cfg.nameStrongMin ||
        (similarity >= cfg.nameMin && distance <= cfg.nameRadiusM) ||
        distance <= cfg.nearRadiusM;
      if (candidate) out.push({ place: pi, spot: si, distance, similarity, compatible: kindCompatible(p.kind, s.kind) });
    });
    return out;
  };

  const matched = new Map<number, Candidate>();
  const taken = new Set<number>();
  const pass = (indexes: number[]) => {
    const candidates = indexes.flatMap(candidatesOf);
    candidates.sort(
      (a, b) =>
        Number(b.compatible) - Number(a.compatible) ||
        classOf(b.similarity) - classOf(a.similarity) ||
        a.distance - b.distance ||
        a.place - b.place ||
        a.spot - b.spot,
    );
    for (const c of candidates) {
      if (matched.has(c.place) || taken.has(c.spot)) continue;
      matched.set(c.place, c);
      taken.add(c.spot);
    }
  };
  const indexes = places.map((_, i) => i);
  pass(indexes.filter((i) => places[i]!.status === "confirmed"));
  pass(indexes.filter((i) => places[i]!.status !== "confirmed"));

  return places.map((p, pi) => {
    const c = matched.get(pi);
    return c
      ? { placeId: p.placeId, spotIndex: c.spot, distanceM: c.distance, nameSimilarity: c.similarity }
      : { placeId: p.placeId, spotIndex: null, distanceM: null, nameSimilarity: null };
  });
}

/** Own value vs a Navily statement: no statement → not at Navily; no own value → deviation; else equal or not. */
function compare(own: unknown, navily: boolean | null): ProposedResult {
  if (navily === null) return "not_at_navily";
  if (typeof own !== "boolean") return "deviation";
  return own === navily ? "match" : "deviation";
}

/**
 * The proposed outcome per compared attribute of a place against its matched spot (pure). `own.position` is the
 * position the place is compared on (`comparedPosition`).
 *
 * - existence: the place exists at Navily iff a spot is matched; it matches when that equals the own value (a
 *   confirmed place without a spot is a deviation);
 * - position: match within `positionToleranceM`;
 * - shelter per sector: protected at Navily iff the lower-case sector is in `prot`; no `prot` → not at Navily;
 * - seabed: Navily `algae` = `weed`; match when the type sets intersect; no Navily seabed → not at Navily;
 * - buoys: comparable only at a Navily spot of type `buoy` (buoys present); water vs `water`, supply vs `shop`;
 * - depth and food: never at Navily (Navily has no depth and no taverns).
 *
 * A missing own value where Navily states one is a deviation.
 */
export function proposeResults(
  values: Record<ComparisonAttribute, ComparisonValue>,
  own: { position: LonLat },
  spot: NavilySpot | null,
  cfg: NavilyConfig,
): Record<ComparisonAttribute, ProposedResult> {
  const out = Object.fromEntries(COMPARISON_ATTRIBUTES.map((a) => [a, "not_at_navily"])) as Record<ComparisonAttribute, ProposedResult>;
  out.existence = compare(values.existence.value, spot !== null);
  if (spot === null) return out;

  out.position = distanceM(own.position, spot) <= cfg.positionToleranceM ? "match" : "deviation";

  if (spot.prot !== null) {
    const prot = new Set(spot.prot.map((p) => p.toLowerCase()));
    for (const a of COMPARISON_ATTRIBUTES) {
      if (!a.startsWith("shelter.")) continue;
      const v = values[a].value as { protected: boolean } | null;
      out[a] = compare(v?.protected ?? null, prot.has(a.slice("shelter.".length).toLowerCase()));
    }
  }

  const navilySeabed = new Set(navilySeabedTypes(spot.seabeds));
  if (navilySeabed.size > 0) {
    const ownSeabed = (values.seabed.value as SeabedType[] | null) ?? [];
    out.seabed = ownSeabed.some((t) => navilySeabed.has(t)) ? "match" : "deviation";
  }

  out["mooring.buoys"] = compare(values["mooring.buoys"].value, spot.type === "buoy" ? true : null);
  out["services.water"] = compare(values["services.water"].value, spot.water);
  out["highlight.supply"] = compare(values["highlight.supply"].value, spot.shop);
  return out;
}

export type NavilyCoverage = { spots: number; matched: number; ratio: number | null; unmatchedSpotIndexes: number[] };

/**
 * Navily coverage from a matching (`matches` of `matchPlacesToSpots(places, spots)`, same order as `places`): the spots
 * inside the subdivision (`inArea`) that a confirmed place matched. With `areaPlaceIds` (the subdivision's confirmed, valid places),
 * only a match to one of those counts: a set member that is ended or belongs to another subdivision does not cover a
 * spot (bundle C review). `unmatchedSpotIndexes` index `spots` (runtime only).
 */
export function coverageOfMatches(
  places: MatchPlace[],
  matches: NavilyMatch[],
  spots: NavilySpot[],
  inArea: (p: LonLat) => boolean,
  areaPlaceIds?: ReadonlySet<string>,
): NavilyCoverage {
  const counts = (p: MatchPlace) => p.status === "confirmed" && (!areaPlaceIds || areaPlaceIds.has(p.placeId));
  const confirmedSpots = new Set(matches.flatMap((m, i) => (m.spotIndex !== null && counts(places[i]!) ? [m.spotIndex] : [])));
  const inside = spots.flatMap((s, i) => (inArea(s) ? [i] : []));
  const matched = inside.filter((i) => confirmedSpots.has(i)).length;
  return {
    spots: inside.length,
    matched,
    ratio: inside.length === 0 ? null : matched / inside.length,
    unmatchedSpotIndexes: inside.filter((i) => !confirmedSpots.has(i)),
  };
}

/**
 * The Navily spots from `NAVILY_SPOTS_PATH`, read at call time (never at module level: env-less build); null when the
 * variable is not set. A missing or broken file fails with its path, never with its content.
 */
export async function loadNavilyFromEnv(env: Pick<Env, "NAVILY_SPOTS_PATH"> = getEnv()): Promise<NavilySpot[] | null> {
  const file = env.NAVILY_SPOTS_PATH;
  if (!file) return null;
  try {
    return await loadNavilySpots(file);
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    throw new Error(missing ? `Navily file not found: ${file}` : `Navily file ${file} cannot be read or is not a valid spot array`);
  }
}
