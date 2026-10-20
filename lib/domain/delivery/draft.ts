import type { HighlightBody, RegionBody, SpotBody } from "@/contract";
import { getConfig } from "@/lib/config";
import { consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import type { DeliveryConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { loadAreaScope } from "./load";
import { highlightIdsBySpot, mapHighlights, type DroppedHighlight } from "./map-highlight";
import { assignRegions, mapRegion, namedRegions, regionIdAt } from "./map-region";
import { mapSources, mapSpot, type SpotWarning } from "./map-spot";
import type { AreaScope, LonLat, RegionSource } from "./types";

/*
 * The contract objects of an area as the next package would deliver them, before versions (ruling M6-P27): load,
 * spots, regions and highlights mapped together, so a spot carries the region and highlights of its package. Shared by
 * the build and the place page's delivery tab. Reads only; no S3, no versions, no merged spots (those come from the
 * previous package, which only the build reads).
 */

export type OmittedSpot = { id: string; reason: "no_name" | "no_profile" | "shelter_incomplete" };
export type DraftObject<B> = { body: B; geoObjectId: string };
export type DraftSpot = DraftObject<SpotBody> & { warnings: SpotWarning[]; forbiddenSources: string[] };

export type AreaDraft = {
  scope: AreaScope;
  /** Delivered spots, by id. */
  spots: DraftSpot[];
  omittedSpots: OmittedSpot[];
  highlights: Array<DraftObject<HighlightBody>>;
  droppedHighlights: DroppedHighlight[];
  /** Forbidden-domain links behind delivered highlights (ruling M6-D-R2). */
  highlightForbiddenSources: Array<{ id: string; urls: string[] }>;
  regions: Array<DraftObject<RegionBody>>;
  /** Forbidden-domain links behind delivered regions' facts and character (final review I-2). */
  regionForbiddenSources: Array<{ id: string; urls: string[] }>;
  droppedRegions: Array<{ id: string; reason: "no_name" }>;
  /** The delivered regions as loaded (weather points), and the region of a point among them. */
  deliveredRegions: RegionSource[];
  regionIdFor: (p: LonLat) => string | null;
};

/** Defaults: the delivery configuration and the active consolidation rules. */
export type DraftOptions = {
  cfg?: DeliveryConfig;
  /** Radius of meaning per importance 1–5 (`consolidation.importance.radiusNm`). */
  radiusNm?: number[];
  /** Highlight confidence without a profile value (`consolidation.poiConfidence`, ruling M6-P7). */
  poiConfidence?: number;
  /** Test seam: changes the loaded scope (e.g. its order) before mapping. */
  scopeTransform?: (scope: AreaScope) => AreaScope;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byPublicId = <T extends { publicId: string }>(a: T, b: T) => cmp(a.publicId, b.publicId);
const byName = <T extends { lang: string; name: string }>(a: T, b: T) => cmp(a.lang, b.lang) || cmp(a.name, b.name);

/** Every list of the scope in one fixed order, so the files never depend on the order the database returned. */
function ordered(scope: AreaScope): AreaScope {
  return {
    ...scope,
    area: { ...scope.area, names: [...scope.area.names].sort(byName) },
    tiles: [...scope.tiles].sort((a, b) => cmp(a.id, b.id)),
    spots: [...scope.spots].map((s) => ({ ...s, names: [...s.names].sort(byName) })).sort(byPublicId),
    merged: [...scope.merged].sort(byPublicId),
    pois: [...scope.pois].sort(byPublicId),
    regions: [...scope.regions].map((r) => ({ ...r, names: [...r.names].sort(byName) })).sort(byPublicId),
    passages: [...scope.passages].sort((a, b) => cmp(a.geoObjectId, b.geoObjectId)),
  };
}

export async function draftArea(db: Db, areaGeoObjectId: string, today: string, opts: DraftOptions = {}): Promise<AreaDraft> {
  const cfg = opts.cfg ?? getConfig().delivery;
  const consolidation = await consolidationConfigFor(db);
  const radiusNm = opts.radiusNm ?? consolidation.importance.radiusNm;
  const poiConfidence = opts.poiConfidence ?? consolidation.poiConfidence;
  const loaded = await loadAreaScope(db, areaGeoObjectId, cfg, today);
  const scope = ordered(opts.scopeTransform ? opts.scopeTransform(loaded) : loaded);

  // Which spots the package delivers, and which of them are excluded: the context (region, highlights) does not
  // decide that, so a first pass without it finds them.
  const omittedSpots: OmittedSpot[] = [];
  const delivered: Array<{ src: AreaScope["spots"][number]; id: string; position: LonLat; excluded: boolean }> = [];
  for (const src of scope.spots) {
    const mapped = mapSpot(src, { regionId: null, highlightIds: [], cfg });
    if ("omitted" in mapped) omittedSpots.push({ id: src.publicId, reason: mapped.omitted });
    else delivered.push({ src, id: mapped.spot.id, position: mapped.spot.position, excluded: mapped.spot.exclude.excluded });
  }

  const named = namedRegions(scope.regions);
  const regionIdFor = regionIdAt(named.regions, cfg.regions.memberMarginNm);
  const { regionIdBySpot, spotIdsByRegion } = assignRegions(delivered, named.regions, cfg.regions.memberMarginNm);

  const mappedHighlights = mapHighlights(
    scope.pois,
    delivered.map((s) => ({ id: s.id, position: s.position, mergedInto: null, excluded: s.excluded })),
    { radiusNm, cfg, poiConfidence, regionIdFor },
  );
  const highlightIds = highlightIdsBySpot(mappedHighlights.highlights, delivered);

  const spots: DraftSpot[] = delivered.map((s) => {
    const mapped = mapSpot(s.src, { regionId: regionIdBySpot.get(s.id) ?? null, highlightIds: highlightIds.get(s.id) ?? [], cfg });
    if ("omitted" in mapped) throw new Error(`spot ${s.id} omitted only with its context`);
    return { body: mapped.spot, geoObjectId: s.src.geoObjectId, warnings: mapped.warnings, forbiddenSources: mapped.forbiddenSources };
  });

  // only delivered regions are parents (ruling M6-C-R2 NOTE): a nameless one is skipped to the next ancestor
  const regionPublicIds = new Map(named.regions.map((r) => [r.geoObjectId, r.publicId]));
  const regions = named.regions.map((r) => ({
    body: mapRegion(r, { areaPublicId: scope.area.publicId, regionPublicIds, spotIds: spotIdsByRegion.get(r.publicId) ?? [], cfg }),
    geoObjectId: r.geoObjectId,
  }));

  const poiGeoObjectIds = new Map(scope.pois.map((p) => [p.publicId, p.geoObjectId]));
  return {
    scope,
    spots,
    omittedSpots,
    highlights: mappedHighlights.highlights.map((body) => ({ body, geoObjectId: poiGeoObjectIds.get(body.id)! })),
    droppedHighlights: mappedHighlights.dropped,
    highlightForbiddenSources: mappedHighlights.forbiddenSources,
    regions,
    regionForbiddenSources: named.regions.flatMap((r) => {
      const urls = mapSources(r.sources, cfg).forbidden;
      return urls.length > 0 ? [{ id: r.publicId, urls }] : [];
    }),
    droppedRegions: named.dropped,
    deliveredRegions: named.regions,
    regionIdFor,
  };
}
