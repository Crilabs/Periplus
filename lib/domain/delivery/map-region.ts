import type { RegionBody } from "@/contract";
import type { z } from "zod";
import type { regionType } from "@/contract/v2";
import type { DeliveryConfig } from "@/lib/config/schemas";
import { distanceNm, distanceToPolygonNm, round5 } from "./geo";
import type { LonLat, PassageSource, RegionSource } from "./types";
import { HAZARD_DE, HAZARD_KIND, RESTRICTED_ZONE_DE } from "./vocab";
import { weatherPointId } from "./weather-points";

/*
 * Gazetteer regions → contract regions (spec 08, Teil B "Region"): type, the parent in the package, the spots inside,
 * the region facts and a one-sentence character from them. Pure: no database.
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

/** Profile `ferry_traffic` → contract `facts.ferryTraffic`. */
export const FERRY_TRAFFIC: Record<"none" | "low" | "moderate" | "high", NonNullable<RegionFacts["ferryTraffic"]>> = {
  none: "none",
  low: "light",
  moderate: "light",
  high: "heavy",
};

type RegionFacts = NonNullable<RegionBody["facts"]>;

/** The smallest radius the contract takes (`radiusNm` > 0): a tiny polygon never rounds to 0 (ruling M6-B-R1). */
const MIN_RADIUS_NM = 0.1;
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round3 = (n: number) => Number(n.toFixed(3));

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

/**
 * One sentence for the strategy prompt from the facts, parts in a fixed order; the first part capitalized, joined
 * with ", ", a full stop at the end; no part → null.
 */
export function regionCharacter(facts: RegionBody["facts"], cfg: DeliveryConfig): string | null {
  if (!facts) return null;
  const { meltemiHigh, meltemiLow } = cfg.regions.character;
  const parts: string[] = [];
  if (facts.meltemiExposure !== null && facts.meltemiExposure >= meltemiHigh) parts.push("Meltemi-exponiert");
  else if (facts.meltemiExposure !== null && facts.meltemiExposure <= meltemiLow) parts.push("vor dem Meltemi geschützt");
  if (facts.ferryTraffic === "heavy") parts.push("starker Fährverkehr");
  else if (facts.ferryTraffic === "none") parts.push("kein Fährverkehr");
  if (facts.charterBase === true) parts.push("Charterbasis");
  if (facts.supplyPort === true) parts.push("Versorgungshafen");
  if (parts.length === 0) return null;
  const text = parts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Region facts from the profile; a missing value is null, no value at all → undefined (field omitted). */
function regionFacts(attributes: Record<string, unknown>): RegionBody["facts"] {
  const meltemi = attributes["meltemi_exposure"];
  const ferry = attributes["ferry_traffic"];
  const list = (key: string) => (Array.isArray(attributes[key]) ? (attributes[key] as unknown[]).length > 0 : null);
  const facts: RegionFacts = {
    meltemiExposure: typeof meltemi === "number" && Number.isFinite(meltemi) ? round3(Math.min(1, Math.max(0, meltemi))) : null,
    ferryTraffic: typeof ferry === "string" && Object.hasOwn(FERRY_TRAFFIC, ferry) ? FERRY_TRAFFIC[ferry as keyof typeof FERRY_TRAFFIC] : null,
    charterBase: list("charter_bases"),
    supplyPort: list("supply_ports"),
  };
  return Object.values(facts).every((v) => v === null) ? undefined : facts;
}

export function mapRegion(
  src: RegionSource,
  ctx: { regionPublicIds: Map<string, string>; spotIds: string[]; cfg: DeliveryConfig },
): RegionBody {
  if (!Object.hasOwn(REGION_TYPE, src.type)) throw new Error(`region ${src.publicId} has type ${src.type}, not a region type`);
  // the nearest ancestor delivered in this package (ended objects, other kinds, regions of another subdivision and the administrative units are not in the map); none: null
  const parent = src.parentGeoObjectIds.map((id) => ctx.regionPublicIds.get(id)).find((id) => id !== undefined);
  const facts = regionFacts(src.profile?.attributes ?? {});
  const character = regionCharacter(facts, ctx.cfg);
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
    character: character === null ? undefined : { de: character },
    facts,
  };
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as RegionBody;
}

/** A safety value known only from text that no contract field carries (final review I-3): reported, never silent. */
export type UndeliveredSafety = { file: "regions.json" | "weather-points.json"; id: string; message: string };

const namedEntries = (value: unknown): Array<{ kind: string; name: string | null }> =>
  Array.isArray(value)
    ? value.flatMap((e) =>
        e !== null && typeof e === "object" && typeof (e as { kind?: unknown }).kind === "string"
          ? [{ kind: (e as { kind: string }).kind, name: typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : null }]
          : [],
      )
    : [];
const label = (word: string, name: string | null) => (name === null ? word : `${word} ${name}`);

/**
 * The text-only safety values of the delivered regions (`restricted_zones` of an area or island) and of the passages
 * (`hazards` of a cape or strait): Teil B has no field for them, so the package does not carry them (a named military
 * or firing zone known only from text reaches neither `regions.json` nor `coast.geojson`). Each becomes a report
 * warning, so the decision is visible (final review I-3). A passage's warning names its weather point.
 */
export function undeliveredSafety(regions: RegionSource[], passages: PassageSource[]): UndeliveredSafety[] {
  const out: UndeliveredSafety[] = [];
  for (const r of regions) {
    for (const z of namedEntries(r.profile?.attributes["restricted_zones"])) {
      const word = RESTRICTED_ZONE_DE[z.kind as keyof typeof RESTRICTED_ZONE_DE] ?? RESTRICTED_ZONE_DE.other;
      out.push({ file: "regions.json", id: r.publicId, message: `Sperrgebiet laut Text nicht geliefert: ${label(word, z.name)}` });
    }
  }
  for (const p of passages) {
    const id = weatherPointId(p.geoObjectId, p.type === "cape" ? "cape" : "channel");
    for (const h of namedEntries(p.profile?.attributes["hazards"])) {
      const kind = HAZARD_KIND[h.kind as keyof typeof HAZARD_KIND] ?? "other";
      out.push({ file: "weather-points.json", id, message: `Gefahr laut Text nicht geliefert (${p.name}): ${label(HAZARD_DE[kind], h.name)}` });
    }
  }
  return out;
}
