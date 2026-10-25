import type { HighlightBody } from "@/contract/v3_0";
import type { DeliveryConfig } from "@/lib/config/schemas";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { distanceNm, round5 } from "./geo";
import { mapImages } from "./map-image";
import { lastObserved, mapSources, mapSummary } from "./map-spot";
import type { LonLat, PoiSource } from "./types";
import { HIGHLIGHT_CATEGORY } from "./vocab";

/*
 * POI → contract highlight (spec 08, Teil B "Highlight"; spec 16): category, importance and the spots that selected it
 * (`highlight_selections`). A POI no delivered spot selects is not delivered (`not_selected`); duplicates (same
 * normalized name, closer than `validation.highlightDuplicateM`) are merged before the delivery. Pure: no database.
 */

const METRES_PER_NM = 1852;
const MAX_IMPORTANCE = 5;

/** A delivered spot as the highlights see it: only unmerged, not excluded spots count (ruling M6-P5). */
export type HighlightSpot = { id: string; geoObjectId: string; position: LonLat; mergedInto: string | null; excluded: boolean };

export type DroppedHighlight = {
  id: string;
  /** `no_name`: the contract has no highlight without a name (ruling M6-B-R1); the build reports every drop. */
  /** `not_existing`: the profile says the place no longer exists (`exists: false`, ruling M6-C-R1). */
  /** `not_selected`: no delivered, unmerged, not excluded spot selected it (spec 16). */
  reason: "no_name" | "no_profile" | "not_existing" | "no_importance" | "not_selected" | "duplicate";
  /** The highlight a duplicate was merged into. */
  into?: string;
};

const round3 = (n: number) => Number(n.toFixed(3));
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Spot ids by the selection's distance, then id. */
function byDistance(distanceKm: Map<string, number>): string[] {
  return [...distanceKm].sort((a, b) => a[1] - b[1] || byId(a[0], b[0])).map(([id]) => id);
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

/**
 * `selectors`: per delivered highlight every delivered, unmerged, not excluded spot selecting it (a merged duplicate's
 * included) by distance, uncapped: what the validation `highlight_selected` holds `spotIds` to.
 */
export function mapHighlights(
  pois: PoiSource[],
  spots: HighlightSpot[],
  ctx: { cfg: DeliveryConfig; poiConfidence: number; regionIdFor: (p: LonLat) => string | null },
): {
  highlights: HighlightBody[];
  dropped: DroppedHighlight[];
  forbiddenSources: Array<{ id: string; urls: string[] }>;
  selectors: Map<string, string[]>;
} {
  const counting = new Map(spots.filter((s) => s.mergedInto === null && !s.excluded).map((s) => [s.geoObjectId, s.id]));
  const max = ctx.cfg.highlights.maxSpotIds;
  const dropped: DroppedHighlight[] = [];
  const candidates: HighlightBody[] = [];
  const forbiddenById = new Map<string, string[]>();
  // per candidate: selecting spot id → the selection's distance (km)
  const selectedById = new Map<string, Map<string, number>>();

  for (const poi of pois) {
    const selecting = new Map<string, number>();
    for (const { placeGeoObjectId, distanceKm } of poi.selectedBy) {
      const spotId = counting.get(placeGeoObjectId);
      if (spotId !== undefined) selecting.set(spotId, Math.min(distanceKm, selecting.get(spotId) ?? Infinity));
    }
    // first: an unselected POI is no highlight at all, whatever else it lacks (it has no full profile, spec 16)
    if (selecting.size === 0) {
      dropped.push({ id: poi.publicId, reason: "not_selected" });
      continue;
    }
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
    if (typeof importance !== "number" || !Number.isInteger(importance) || importance < 1 || importance > MAX_IMPORTANCE) {
      dropped.push({ id: poi.publicId, reason: "no_importance" });
      continue;
    }
    const position = { lat: round5(poi.position.lat), lon: round5(poi.position.lon) };
    selectedById.set(poi.publicId, selecting);
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
        spotIds: byDistance(selecting).slice(0, max),
        regionId: ctx.regionIdFor(position),
        season: season(a),
        summary: mapSummary(poi.summary, conf, ctx.cfg),
        images: mapImages(poi.publicId, poi.images),
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
  const kept: Array<{ body: HighlightBody; name: string; selecting: Map<string, number> }> = [];
  for (const body of ranked) {
    const name = normalizeName(body.name);
    const into = kept.find(
      (k) => k.name === name && distanceNm(k.body.position, body.position) * METRES_PER_NM < ctx.cfg.validation.highlightDuplicateM,
    );
    if (into) {
      for (const [spotId, km] of selectedById.get(body.id)!) into.selecting.set(spotId, Math.min(km, into.selecting.get(spotId) ?? Infinity));
      dropped.push({ id: body.id, reason: "duplicate", into: into.body.id });
    } else {
      kept.push({ body, name, selecting: new Map(selectedById.get(body.id)!) });
    }
  }
  const selectors = new Map(kept.map((k) => [k.body.id, byDistance(k.selecting)]));
  const highlights = kept
    .map((k) => ({ ...k.body, spotIds: selectors.get(k.body.id)!.slice(0, max) }))
    .sort((a, b) => byId(a.id, b.id));
  dropped.sort((a, b) => byId(a.id, b.id));
  // only delivered highlights matter: their values must not come from a forbidden domain (ruling M6-D-R2)
  const forbiddenSources = highlights.flatMap((h) => (forbiddenById.has(h.id) ? [{ id: h.id, urls: forbiddenById.get(h.id)! }] : []));
  return { highlights, dropped, forbiddenSources, selectors };
}

/**
 * Spot → the highlights counting it (`spot.highlightIds`): the inverse of `spotIds`, in the spot's own order `ranked`
 * (its `derived.highlights`, categories sorted, each in rank order, see `rankedHighlightIds`), the rest by id. Every
 * spot has an entry; an excluded spot always gets none (ruling M6-P5).
 */
export function highlightIdsBySpot(
  highlights: HighlightBody[],
  spots: Array<{ id: string; excluded?: boolean; ranked?: string[] }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const spot of spots) {
    const rank = new Map((spot.ranked ?? []).map((id, i) => [id, i] as const));
    const position = (id: string) => rank.get(id) ?? Infinity;
    const ids = spot.excluded
      ? []
      : highlights
          .filter((h) => h.spotIds.includes(spot.id))
          .map((h) => h.id)
          .sort((a, b) => position(a) - position(b) || byId(a, b));
    out.set(spot.id, ids);
  }
  return out;
}

/**
 * The POIs a place selected (its profile's `derived.highlights`, spec 16) as highlight ids: categories sorted by
 * name, each in rank order; ids through `publicIdOf` (a geo object id → its delivered highlight id, a
 * merged duplicate → the one it went into), unknown ones skipped, each once.
 */
export function rankedHighlightIds(value: unknown, publicIdOf: (geoObjectId: string) => string | undefined): string[] {
  if (!isRecord(value)) return [];
  const out = new Set<string>();
  for (const category of Object.keys(value).sort(byId)) {
    const entry = value[category];
    const ids = isRecord(entry) && Array.isArray(entry.ids) ? entry.ids : [];
    for (const id of ids) {
      const publicId = typeof id === "string" ? publicIdOf(id) : undefined;
      if (publicId !== undefined) out.add(publicId);
    }
  }
  return [...out];
}

/** Drops keys whose value is undefined, so the serialized object has only the fields it delivers. */
function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
