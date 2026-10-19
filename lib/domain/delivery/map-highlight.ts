import type { HighlightBody } from "@/contract";
import type { DeliveryConfig } from "@/lib/config/schemas";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { distanceNm, round5 } from "./geo";
import { lastObserved, mapSources, mapSummary } from "./map-spot";
import type { LonLat, PoiSource } from "./types";
import { HIGHLIGHT_CATEGORY } from "./vocab";

/*
 * POI → contract highlight (spec 08, Teil B "Highlight"): category, importance and the spots where it counts, within
 * its radius of meaning (5/10/20/35/50 nm). A highlight without a spot in that radius is not delivered (Teil B
 * validation); duplicates (same normalized name, closer than `validation.highlightDuplicateM`) are merged before the
 * delivery. Pure: no database.
 */

const METRES_PER_NM = 1852;

/** A delivered spot as the highlights see it: only unmerged, not excluded spots count (ruling M6-P5). */
export type HighlightSpot = { id: string; position: LonLat; mergedInto: string | null; excluded: boolean };

export type DroppedHighlight = {
  id: string;
  /** `no_name`: the contract has no highlight without a name (ruling M6-B-R1); the build reports every drop. */
  /** `not_existing`: the profile says the place no longer exists (`exists: false`, ruling M6-C-R1). */
  reason: "no_name" | "no_profile" | "not_existing" | "no_importance" | "no_spot_in_radius" | "duplicate";
  /** The highlight a duplicate was merged into. */
  into?: string;
};

const round3 = (n: number) => Number(n.toFixed(3));
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Spot ids by distance from `from`, then id, at most `max`. */
function sortedSpotIds(ids: Iterable<string>, from: LonLat, positions: Map<string, LonLat>, max: number): string[] {
  return [...new Set(ids)]
    .map((id) => ({ id, d: distanceNm(from, positions.get(id)!) }))
    .sort((a, b) => a.d - b.d || byId(a.id, b.id))
    .slice(0, max)
    .map((e) => e.id);
}

/** Months of the POI's `open` season notes (ruling M6-P6), united and ascending; none → null (all year). */
function season(attributes: Record<string, unknown>): HighlightBody["season"] {
  const notes = Array.isArray(attributes["season_notes"]) ? attributes["season_notes"] : [];
  const months = new Set<number>();
  for (const note of notes) {
    if (!isRecord(note) || note.kind !== "open" || !Array.isArray(note.months)) continue;
    for (const m of note.months) if (Number.isInteger(m) && m >= 1 && m <= 12) months.add(m as number);
  }
  return months.size > 0 ? { months: [...months].sort((a, b) => a - b) } : null;
}

/**
 * `score.confidence` (ruling M6-P7): the profile confidence, else the confidence of the POI's `exists` value, else
 * `poiConfidence` (the configured weight of an OSM POI); POI profiles never get a profile confidence of their own.
 */
function confidence(poi: PoiSource, poiConfidence: number): number {
  const profile = poi.profile!;
  return round3(profile.confidence ?? profile.provenance["exists"]?.confidence ?? poiConfidence);
}

export function mapHighlights(
  pois: PoiSource[],
  spots: HighlightSpot[],
  ctx: { radiusNm: number[]; cfg: DeliveryConfig; poiConfidence: number; regionIdFor: (p: LonLat) => string | null },
): { highlights: HighlightBody[]; dropped: DroppedHighlight[]; forbiddenSources: Array<{ id: string; urls: string[] }> } {
  const counting = spots.filter((s) => s.mergedInto === null && !s.excluded);
  const positions = new Map(counting.map((s) => [s.id, s.position]));
  const max = ctx.cfg.highlights.maxSpotIds;
  const dropped: DroppedHighlight[] = [];
  const candidates: HighlightBody[] = [];
  const forbiddenById = new Map<string, string[]>();

  for (const poi of pois) {
    if (poi.name.trim() === "") {
      dropped.push({ id: poi.publicId, reason: "no_name" });
      continue;
    }
    if (!poi.profile) {
      dropped.push({ id: poi.publicId, reason: "no_profile" });
      continue;
    }
    const a = poi.profile.attributes;
    if (a["exists"] === false) {
      dropped.push({ id: poi.publicId, reason: "not_existing" });
      continue;
    }
    const importance = a["derived.importance"];
    if (typeof importance !== "number" || !Number.isInteger(importance) || importance < 1 || importance > ctx.radiusNm.length) {
      dropped.push({ id: poi.publicId, reason: "no_importance" });
      continue;
    }
    const position = { lat: round5(poi.position.lat), lon: round5(poi.position.lon) };
    const radius = ctx.radiusNm[importance - 1]!;
    const inRadius = counting.filter((s) => distanceNm(position, s.position) <= radius).map((s) => s.id);
    if (inRadius.length === 0) {
      dropped.push({ id: poi.publicId, reason: "no_spot_in_radius" });
      continue;
    }
    const conf = confidence(poi, ctx.poiConfidence);
    const sources = mapSources(poi.sources, ctx.cfg);
    if (sources.forbidden.length > 0) forbiddenById.set(poi.publicId, sources.forbidden);
    candidates.push(
      withoutUndefined({
        id: poi.publicId,
        name: poi.name,
        category: HIGHLIGHT_CATEGORY[poi.category],
        importance,
        position,
        spotIds: sortedSpotIds(inRadius, position, positions, max),
        regionId: ctx.regionIdFor(position),
        season: season(a),
        summary: mapSummary(poi.summary, conf, ctx.cfg),
        sources: sources.sources,
        externalRefs: { googlePlaceId: null, osmId: poi.osmId, wikidataId: poi.wikidataId },
        score: {
          confidence: conf,
          sourcesCount: poi.profile.sourcesCount,
          lastObserved: lastObserved(Object.values(poi.profile.provenance)),
        },
      }),
    );
  }

  // Duplicates: the more important one (then the smaller id) stays and takes the other's spots.
  const ranked = [...candidates].sort((a, b) => b.importance - a.importance || byId(a.id, b.id));
  const kept: Array<{ body: HighlightBody; name: string; spotIds: string[] }> = [];
  for (const body of ranked) {
    const name = normalizeName(body.name);
    const into = kept.find(
      (k) => k.name === name && distanceNm(k.body.position, body.position) * METRES_PER_NM < ctx.cfg.validation.highlightDuplicateM,
    );
    if (into) {
      into.spotIds.push(...body.spotIds);
      dropped.push({ id: body.id, reason: "duplicate", into: into.body.id });
    } else {
      kept.push({ body, name, spotIds: [...body.spotIds] });
    }
  }
  const highlights = kept
    .map((k) => ({ ...k.body, spotIds: sortedSpotIds(k.spotIds, k.body.position, positions, max) }))
    .sort((a, b) => byId(a.id, b.id));
  dropped.sort((a, b) => byId(a.id, b.id));
  // only delivered highlights matter: their values must not come from a forbidden domain (ruling M6-D-R2)
  const forbiddenSources = highlights.flatMap((h) => (forbiddenById.has(h.id) ? [{ id: h.id, urls: forbiddenById.get(h.id)! }] : []));
  return { highlights, dropped, forbiddenSources };
}

/**
 * Spot → the highlights counting it (`spot.highlightIds`), nearest first, then by id: the inverse of `spotIds`. Every
 * spot has an entry; an excluded spot always gets none (ruling M6-P5).
 */
export function highlightIdsBySpot(
  highlights: HighlightBody[],
  spots: Array<{ id: string; position: LonLat; excluded?: boolean }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const spot of spots) {
    const ids = spot.excluded
      ? []
      : highlights
          .filter((h) => h.spotIds.includes(spot.id))
          .map((h) => ({ id: h.id, d: distanceNm(spot.position, h.position) }))
          .sort((a, b) => a.d - b.d || byId(a.id, b.id))
          .map((e) => e.id);
    out.set(spot.id, ids);
  }
  return out;
}

/** Drops keys whose value is undefined, so the serialized object has only the fields it delivers. */
function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
