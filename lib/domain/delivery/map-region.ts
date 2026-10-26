import type { RegionBody } from "@/contract/v2";
import type { z } from "zod";
import type { regionType } from "@/contract/v2";
import { distanceNm, distanceToPolygonNm, round5 } from "./geo";
import type { LonLat, RegionSource } from "./types";

/*
 * Gazetteer regions → contract regions (spec 08, Teil B "Region"): type, the parent in the package, the spots inside.
 * Region facts and character stay out until a source for them exists (no profiles any more). Pure: no database.
 */

type ContractRegionType = z.infer<typeof regionType>;
/** The geo object types delivered as regions (`regions.types`). */
export type RegionKind = "island" | "archipelago" | "coast_section" | "gulf" | "channel";

export const REGION_TYPE: Record<RegionKind, ContractRegionType> = {
  island: "island",
  archipelago: "archipelago",
  coast_section: "coast",
  gulf: "gulf",
  channel: "channel",
};

/** The smallest radius the contract takes (`radiusNm` > 0): a tiny polygon never rounds to 0 (ruling M6-B-R1). */
const MIN_RADIUS_NM = 0.1;
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A region without a valid name is not delivered (ruling M6-B-R1); the build reports it as a warning. */
export function namedRegions(regions: RegionSource[]): {
  regions: RegionSource[];
  dropped: Array<{ id: string; reason: "no_name" }>;
} {
  return {
    regions: regions.filter((r) => r.name.trim() !== ""),
    dropped: regions.filter((r) => r.name.trim() === "").map((r) => ({ id: r.publicId, reason: "no_name" as const })),
  };
}

/**
 * Inside the polygon or within `marginNm` of it (the bays of an island, whose polygon is land; ruling M6-C-R1); a
 * region known as a point: within `radiusNm` of its centre.
 */
function contains(r: RegionSource, p: LonLat, marginNm: number): boolean {
  return r.polygon ? distanceToPolygonNm(p, r.polygon) <= marginNm : distanceNm(r.center, p) <= r.radiusNm;
}

/** A region with a polygonal area; one known as a point (or a polygon of 0 km²) has none (ruling M6-E-R2). */
const hasArea = (r: RegionSource) => r.polygon !== null && (r.areaKm2 ?? 0) > 0;

/**
 * Order for "the smallest region": regions with an area by `areaKm2`, then those without one by radius, each tie by
 * id. A region without an area never wins over one with an area (its radius circle is a guess, not its size): a point
 * archipelago would otherwise take the spots of its own islands (ruling M6-E-R2).
 */
const bySize = (a: RegionSource, b: RegionSource) =>
  Number(!hasArea(a)) - Number(!hasArea(b)) ||
  (hasArea(a) ? a.areaKm2! - b.areaKm2! : a.radiusNm - b.radiusNm) ||
  byId(a.publicId, b.publicId);

/**
 * The public id of the smallest region containing a point (then the smaller id), null outside all; regions without an
 * area only when no region with one contains it. A polygon region contains what lies within `marginNm`
 * (`regions.memberMarginNm`) of its polygon; the size is the unbuffered one.
 */
export function regionIdAt(regions: RegionSource[], marginNm: number): (p: LonLat) => string | null {
  const bySizeOrder = [...regions].sort(bySize);
  return (p) => bySizeOrder.find((r) => contains(r, p, marginNm))?.publicId ?? null;
}

/**
 * `spot.regionId` = the smallest region containing the spot; `region.spotIds` = every spot inside the region (also
 * those of smaller regions within it), sorted; containment as in `regionIdAt`.
 */
export function assignRegions(
  spots: Array<{ id: string; position: LonLat }>,
  regions: RegionSource[],
  marginNm: number,
): { regionIdBySpot: Map<string, string | null>; spotIdsByRegion: Map<string, string[]> } {
  const regionIdFor = regionIdAt(regions, marginNm);
  const regionIdBySpot = new Map(spots.map((s) => [s.id, regionIdFor(s.position)]));
  const spotIdsByRegion = new Map(
    regions.map((r) => [r.publicId, spots.filter((s) => contains(r, s.position, marginNm)).map((s) => s.id).sort(byId)]),
  );
  return { regionIdBySpot, spotIdsByRegion };
}

export function mapRegion(
  src: RegionSource,
  ctx: { regionPublicIds: Map<string, string>; spotIds: string[] },
): RegionBody {
  if (!Object.hasOwn(REGION_TYPE, src.type)) throw new Error(`region ${src.publicId} has type ${src.type}, not a region type`);
  // the nearest ancestor delivered in this package (ended objects, other kinds, regions of another subdivision and the administrative units are not in the map); none: null
  const parent = src.parentGeoObjectIds.map((id) => ctx.regionPublicIds.get(id)).find((id) => id !== undefined);
  const body: RegionBody = {
    id: src.publicId,
    name: src.name,
    names: src.names.length > 0 ? src.names : undefined,
    type: REGION_TYPE[src.type as RegionKind],
    center: { lat: round5(src.center.lat), lon: round5(src.center.lon) },
    radiusNm: Math.max(MIN_RADIUS_NM, Number(src.radiusNm.toFixed(1))),
    // 2D positions from ST_AsGeoJSON with 5 decimals (loader)
    polygon: (src.polygon ?? undefined) as RegionBody["polygon"],
    parentId: parent ?? null,
    spotIds: [...ctx.spotIds].sort(byId),
  };
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as RegionBody;
}
