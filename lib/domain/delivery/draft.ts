import type { HighlightBody, RegionBody, SpotBody } from "@/contract/v3_0";
import { getConfig } from "@/lib/config";
import { consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import type { DeliveryConfig, ImagesConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { loadSubdivisionScope } from "./load";
import { imageFiles, type ImageFile } from "./map-image";
import { mapHighlights, type DroppedHighlight } from "./map-highlight";
import { assignRegions, mapRegion, namedRegions, regionIdAt } from "./map-region";
import { mapSpot, type SpotWarning } from "./map-spot";
import type { LonLat, RegionSource, SubdivisionScope } from "./types";

/*
 * The contract objects of a subdivision as the next package would deliver them, before versions (ruling M6-P27): load,
 * spots, regions and highlights mapped together, so a spot carries the region and highlights of its package. Shared by
 * the build and the place page's delivery tab. Reads only; no S3, no versions, no merged spots (those come from the
 * previous package, which only the build reads).
 */

export type OmittedSpot = { id: string; reason: "no_name" | "no_state" | "incomplete_core" };
export type DraftObject<B> = { body: B; geoObjectId: string };
/** `asOf`: the date of the berth state the spot was built from (contract 4.0), null for an excluded spot without one. */
export type DraftSpot = DraftObject<SpotBody> & { asOf: string | null; warnings: SpotWarning[] };

export type SubdivisionDraft = {
  scope: SubdivisionScope;
  /** Delivered spots, by id. */
  spots: DraftSpot[];
  omittedSpots: OmittedSpot[];
  highlights: Array<DraftObject<HighlightBody>>;
  droppedHighlights: DroppedHighlight[];
  /** Forbidden-domain links behind delivered highlights (ruling M6-D-R2). */
  highlightForbiddenSources: Array<{ id: string; urls: string[] }>;
  /** Per delivered highlight every delivered spot selecting it (the validation's `highlightSelectors`, spec 16). */
  highlightSelectors: Map<string, string[]>;
  regions: Array<DraftObject<RegionBody>>;
  droppedRegions: Array<{ id: string; reason: "no_name" }>;
  /** The delivered regions as loaded (weather points), and the region of a point among them. */
  deliveredRegions: RegionSource[];
  regionIdFor: (p: LonLat) => string | null;
  /** The image files of the delivered spots and highlights (their bytes come from the archive, `fileKey`). */
  imageFiles: ImageFile[];
};

/** Defaults: the delivery configuration and the active consolidation rules. */
export type DraftOptions = {
  cfg?: DeliveryConfig;
  /** Highlight confidence without a profile value (`consolidation.poiConfidence`, ruling M6-P7). */
  poiConfidence?: number;
  /** Which sources' images are delivered (`images.delivery`); default the configuration. */
  images?: ImagesConfig;
  /** Test seam: changes the loaded scope (e.g. its order) before mapping. */
  scopeTransform?: (scope: SubdivisionScope) => SubdivisionScope;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byPublicId = <T extends { publicId: string }>(a: T, b: T) => cmp(a.publicId, b.publicId);
const byName = <T extends { lang: string; name: string }>(a: T, b: T) => cmp(a.lang, b.lang) || cmp(a.name, b.name);

/** Every list of the scope in one fixed order, so the files never depend on the order the database returned. */
function ordered(scope: SubdivisionScope): SubdivisionScope {
  return {
    ...scope,
    subdivision: { ...scope.subdivision, names: [...scope.subdivision.names].sort(byName) },
    areas: [...scope.areas].map((a) => ({ ...a, names: [...a.names].sort(byName) })).sort(byPublicId),
    tiles: [...scope.tiles].sort((a, b) => cmp(a.id, b.id)),
    spots: [...scope.spots].map((s) => ({ ...s, names: [...s.names].sort(byName) })).sort(byPublicId),
    merged: [...scope.merged].sort(byPublicId),
    pois: [...scope.pois].sort(byPublicId),
    regions: [...scope.regions].map((r) => ({ ...r, names: [...r.names].sort(byName) })).sort(byPublicId),
    passages: [...scope.passages].sort((a, b) => cmp(a.geoObjectId, b.geoObjectId)),
  };
}

export async function draftSubdivision(db: Db, subdivisionId: string, today: string, opts: DraftOptions = {}): Promise<SubdivisionDraft> {
  const cfg = opts.cfg ?? getConfig().delivery;
  const consolidation = await consolidationConfigFor(db);
  const poiConfidence = opts.poiConfidence ?? consolidation.poiConfidence;
  const loaded = await loadSubdivisionScope(db, subdivisionId, cfg, today, opts.images);
  const scope = ordered(opts.scopeTransform ? opts.scopeTransform(loaded) : loaded);

  // Which spots the package delivers, and which of them are excluded: the context (region, highlights) does not
  // decide that, so a first pass without it finds them.
  const omittedSpots: OmittedSpot[] = [];
  const delivered: Array<{ src: SubdivisionScope["spots"][number]; id: string; geoObjectId: string; position: LonLat; excluded: boolean }> = [];
  for (const src of scope.spots) {
    const mapped = mapSpot(src, { regionId: null, cfg });
    if ("omitted" in mapped) omittedSpots.push({ id: src.publicId, reason: mapped.omitted });
    else delivered.push({ src, id: mapped.spot.id, geoObjectId: src.geoObjectId, position: mapped.spot.position, excluded: mapped.spot.exclude.excluded });
  }

  const named = namedRegions(scope.regions);
  const regionIdFor = regionIdAt(named.regions, cfg.regions.memberMarginNm);
  const { regionIdBySpot, spotIdsByRegion } = assignRegions(delivered, named.regions, cfg.regions.memberMarginNm);

  const mappedHighlights = mapHighlights(
    scope.pois,
    delivered.map((s) => ({ id: s.id, geoObjectId: s.geoObjectId, position: s.position, mergedInto: null, excluded: s.excluded })),
    { cfg, poiConfidence, regionIdFor },
  );

  const spots: DraftSpot[] = delivered.map((s) => {
    const mapped = mapSpot(s.src, { regionId: regionIdBySpot.get(s.id) ?? null, cfg });
    if ("omitted" in mapped) throw new Error(`spot ${s.id} omitted only with its context`);
    return { body: mapped.spot, geoObjectId: s.src.geoObjectId, asOf: mapped.asOf, warnings: mapped.warnings };
  });

  // only delivered regions are parents (ruling M6-C-R2 NOTE): a nameless one is skipped to the next ancestor
  const regionPublicIds = new Map(named.regions.map((r) => [r.geoObjectId, r.publicId]));
  const regions = named.regions.map((r) => ({
    body: mapRegion(r, { regionPublicIds, spotIds: spotIdsByRegion.get(r.publicId) ?? [], cfg }),
    geoObjectId: r.geoObjectId,
  }));

  const poiGeoObjectIds = new Map(scope.pois.map((p) => [p.publicId, p.geoObjectId]));
  const deliveredImages = new Map<string, ImageFile[]>([
    ...scope.spots.map((s): [string, ImageFile[]] => [s.publicId, imageFiles(s.publicId, s.images)]),
    ...scope.pois.map((p): [string, ImageFile[]] => [p.publicId, imageFiles(p.publicId, p.images)]),
  ]);
  return {
    scope,
    spots,
    omittedSpots,
    highlights: mappedHighlights.highlights.map((body) => ({ body, geoObjectId: poiGeoObjectIds.get(body.id)! })),
    droppedHighlights: mappedHighlights.dropped,
    highlightForbiddenSources: mappedHighlights.forbiddenSources,
    highlightSelectors: mappedHighlights.selectors,
    regions,
    droppedRegions: named.dropped,
    deliveredRegions: named.regions,
    regionIdFor,
    imageFiles: [...spots.map((s) => s.body.id), ...mappedHighlights.highlights.map((h) => h.id)].flatMap((id) => deliveredImages.get(id) ?? []),
  };
}
