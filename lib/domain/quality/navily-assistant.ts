import type { NameAffixesConfig } from "@/lib/config";
import type { QualityConfig } from "@/lib/config/schemas";
import type { SeabedType } from "@/lib/db/schema";
import { getEnv, type Env } from "@/lib/env";
import { normalizeName, transliterateElot743 } from "@/lib/domain/gazetteer/names";
import type { LonLat } from "@/lib/domain/geometry/water";
import { stripAffix } from "@/lib/domain/mentions/affixes";
import { COMPARISON_ATTRIBUTES, type ComparisonAttribute, type ComparisonSubject, type ComparisonValue } from "./comparison-values";
import { distanceM, loadNavilySpots, NAVILY_SEABED, type NavilySpot } from "./navily-sample";
import { similarityOfSets, trigrams } from "./trigram";

/*
 * The Navily assistant (spec 10): matches the places of an area to the spots of the Navily file and proposes an
 * outcome per compared attribute. Grundprinzip 9: everything here is pure and runs at request or CLI time; the spot
 * list lives in memory only, and what leaves this module is an outcome per attribute, a distance, a similarity or an
 * index into the loaded list (meaningful only while the list is loaded), never a Navily name, id, url or value.
 */

type NavilyConfig = QualityConfig["navily"];
type MatchPlace = Pick<ComparisonSubject, "placeId" | "kind" | "position" | "names">;
export type ProposedResult = "match" | "deviation" | "not_at_navily";

/** A place and the spot matched to it; `spotIndex` indexes the loaded spot list (runtime only), null without a match. */
export type NavilyMatch = { placeId: string; spotIndex: number | null; distanceM: number | null; nameSimilarity: number | null };

/** The core of a name: transliterated (ELOT 743), normalised, a generic affix („Ormos“, „Bay“) stripped when one is. */
function nameCore(name: string, affixes: NameAffixesConfig): string {
  const form = normalizeName(transliterateElot743(name));
  return stripAffix(form, affixes)?.core ?? form;
}

/** Best trigram similarity between the cores of the own names and the spot's name; 0 without a spot name. */
export function nameSimilarity(ownNames: string[], spotName: string | null, affixes: NameAffixesConfig): number {
  if (spotName === null) return 0;
  const spot = trigrams(nameCore(spotName, affixes));
  return Math.max(0, ...ownNames.map((n) => similarityOfSets(trigrams(nameCore(n, affixes)), spot)));
}

/** Harbours (`port`, `marina`) pair with a Navily `port`, all other kinds with a Navily `mooring`. */
function kindCompatible(kind: MatchPlace["kind"], navilyKind: NavilySpot["kind"]): boolean {
  return navilyKind === (kind === "port" || kind === "marina" ? "port" : "mooring");
}

/** Metres per degree of latitude on the haversine sphere, rounded down (a cheap prefilter only). */
const METRES_PER_DEGREE_LAT = 111_000;

/**
 * Matches places to spots. A spot is a candidate of a place within `maxRadiusM` when its name is strongly similar
 * (≥ `nameStrongMin`), similar (≥ `nameMin`) within `nameRadiusM`, or it lies within `nearRadiusM` whatever its name.
 * Candidates are taken greedily over all places by name similarity (descending), kind compatibility, then distance
 * (ascending); each spot and each place is matched at most once. One match per place, in input order.
 */
export function matchPlacesToSpots(
  places: MatchPlace[],
  spots: NavilySpot[],
  cfg: NavilyConfig,
  affixes: NameAffixesConfig,
): NavilyMatch[] {
  const spotTrigrams = new Map<number, Set<string> | null>();
  const trigramsOfSpot = (i: number) => {
    if (!spotTrigrams.has(i)) {
      const name = spots[i]!.name;
      spotTrigrams.set(i, name === null ? null : trigrams(nameCore(name, affixes)));
    }
    return spotTrigrams.get(i)!;
  };
  const maxLatDelta = cfg.maxRadiusM / METRES_PER_DEGREE_LAT;

  type Candidate = { place: number; spot: number; distance: number; similarity: number; compatible: boolean };
  const candidates: Candidate[] = [];
  places.forEach((p, pi) => {
    const own = p.names.map((n) => trigrams(nameCore(n, affixes)));
    spots.forEach((s, si) => {
      if (Math.abs(s.lat - p.position.lat) > maxLatDelta) return;
      const distance = distanceM(p.position, s);
      if (distance > cfg.maxRadiusM) return;
      const spotSet = trigramsOfSpot(si);
      const similarity = spotSet === null ? 0 : Math.max(0, ...own.map((o) => similarityOfSets(o, spotSet)));
      const candidate =
        similarity >= cfg.nameStrongMin ||
        (similarity >= cfg.nameMin && distance <= cfg.nameRadiusM) ||
        distance <= cfg.nearRadiusM;
      if (candidate) candidates.push({ place: pi, spot: si, distance, similarity, compatible: kindCompatible(p.kind, s.kind) });
    });
  });
  candidates.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      Number(b.compatible) - Number(a.compatible) ||
      a.distance - b.distance ||
      a.place - b.place ||
      a.spot - b.spot,
  );

  const matched = new Map<number, Candidate>();
  const taken = new Set<number>();
  for (const c of candidates) {
    if (matched.has(c.place) || taken.has(c.spot)) continue;
    matched.set(c.place, c);
    taken.add(c.spot);
  }
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

  const navilySeabed = new Set((spot.seabeds ?? []).flatMap((s) => NAVILY_SEABED[s.toLowerCase()] ?? []));
  if (navilySeabed.size > 0) {
    const ownSeabed = (values.seabed.value as SeabedType[] | null) ?? [];
    out.seabed = ownSeabed.some((t) => navilySeabed.has(t)) ? "match" : "deviation";
  }

  out["mooring.buoys"] = compare(values["mooring.buoys"].value, spot.type === "buoy" ? true : null);
  out["services.water"] = compare(values["services.water"].value, spot.water);
  out["highlight.supply"] = compare(values["highlight.supply"].value, spot.shop);
  return out;
}

/**
 * Navily coverage of an area: the spots inside the area (`inArea`) matched against all given places (the area's
 * confirmed places, not only the comparison set). `unmatchedSpotIndexes` index the given spot list (runtime only).
 */
export function navilyCoverage(
  places: MatchPlace[],
  spots: NavilySpot[],
  inArea: (p: LonLat) => boolean,
  cfg: NavilyConfig,
  affixes: NameAffixesConfig,
): { spots: number; matched: number; ratio: number | null; unmatchedSpotIndexes: number[] } {
  const inside = spots.flatMap((s, i) => (inArea(s) ? [i] : []));
  const matches = matchPlacesToSpots(places, inside.map((i) => spots[i]!), cfg, affixes);
  const matchedLocal = new Set(matches.flatMap((m) => (m.spotIndex === null ? [] : [m.spotIndex])));
  return {
    spots: inside.length,
    matched: matchedLocal.size,
    ratio: inside.length === 0 ? null : matchedLocal.size / inside.length,
    unmatchedSpotIndexes: inside.filter((_, local) => !matchedLocal.has(local)),
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
