import { eq, sql } from "drizzle-orm";
import type { Geometry } from "geojson";
import { getConfig, type GeometryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places, type ComputationKind, type SeabedType } from "@/lib/db/schema";
import { latestComputations, type StoredComputation } from "@/lib/domain/facts/computations";
import { SECTORS, type Sector } from "@/lib/domain/facts/schema-types";
import type { Gap } from "@/lib/domain/geometry/gaps";
import type { RestrictionHit } from "@/lib/domain/geometry/restrictions";
import { rayShelter } from "@/lib/domain/geometry/shelter";
import type { LonLat } from "@/lib/domain/geometry/water";

/** Rays are drawn at most this long (display only; the fetch itself reaches 50 km). */
const RAY_DISPLAY_MAX_M = 3000;

/** Order of the computations in the view: the order the geometry stage writes them. */
const KIND_ORDER: ComputationKind[] = ["anchor_area", "fetch", "shelter", "depth", "seabed", "restriction", "quietness"];

export type PlaceGeometryView = {
  computedAt: Date | null;
  rulesVersion: string | null;
  origin: LonLat | null;
  originSource: string | null;
  sectors: Record<Sector, { shelter: number; fetchM: number }> | null;
  swell: number | null;
  opening: { bearingDeg: number | null; widthDeg: number } | null;
  rays: Array<{ bearingDeg: number; fetchM: number; shelter: number; end: LonLat }>;
  depth: {
    approach: { at50m: number | null; at100m: number | null; at200m: number | null } | null;
    min: number | null;
    max: number | null;
    anchoringMin: number | null;
    anchoringMax: number | null;
    confidence: number | null;
  };
  /** Approach samples (50/100/200 m along the opening) with their positions, from the depth computation. */
  depthSamples: Array<{ distanceM: number; depthM: number | null; position: LonLat }>;
  seabed: Array<{ type: SeabedType; share: number }> | null;
  water: Geometry | null;
  anchorArea: { areaM2: number; geometry: Geometry | null } | null;
  anchorPosition: { lon: number; lat: number; confidence: number | null; origin: string | null } | null;
  restriction: RestrictionHit[];
  gaps: Gap[];
  computations: Array<{
    id: string;
    kind: ComputationKind;
    rulesVersion: string;
    createdAt: Date;
    inputs: Record<string, unknown>;
  }>;
};

type Stored = Map<ComputationKind, StoredComputation>;

function fact(stored: Stored, kind: ComputationKind, attribute: string) {
  return stored.get(kind)?.facts.find((f) => f.attribute === attribute) ?? null;
}

function value<T>(stored: Stored, kind: ComputationKind, attribute: string): T | null {
  return (fact(stored, kind, attribute)?.value as T | undefined) ?? null;
}

/** Rays of the newest fetch computation with their shelter and display end point (`ST_Project`, at most 3 km). */
async function raysOf(db: Db, stored: Stored, origin: LonLat | null): Promise<PlaceGeometryView["rays"]> {
  const fetchRow = stored.get("fetch");
  const fetches = fetchRow?.outputs.rays;
  if (!origin || !Array.isArray(fetches) || fetches.length === 0) return [];
  const config = getConfig().geometry;
  // The parameters the stored rows were computed with, not today's config.
  const stepDeg = (fetchRow!.inputs.params as Partial<GeometryConfig["fetch"]> | undefined)?.rayStepDeg ?? config.fetch.rayStepDeg;
  const shelterParams =
    (stored.get("shelter")?.inputs.params as { shelter?: GeometryConfig["shelter"] } | undefined)?.shelter ?? config.shelter;

  const lengths = (fetches as number[]).map(Number);
  const { rows } = await db.execute<{ lon: number; lat: number }>(sql`
    select ST_X(p) as lon, ST_Y(p) as lat
    from (
      select r.i, ST_Project(
               ST_SetSRID(ST_MakePoint(${origin.lon}::float8, ${origin.lat}::float8), 4326)::geography,
               least(r.fetch_m, ${RAY_DISPLAY_MAX_M}::float8),
               radians((r.i - 1) * ${stepDeg}::float8))::geometry as p
      from unnest(${`{${lengths.join(",")}}`}::float8[]) with ordinality as r(fetch_m, i)
    ) t
    order by i`);
  return lengths.map((fetchM, i) => ({
    bearingDeg: i * stepDeg,
    fetchM,
    shelter: rayShelter(fetchM, shelterParams),
    end: { lon: Number(rows[i]!.lon), lat: Number(rows[i]!.lat) },
  }));
}

type StoredSample = { distanceM: number; lon: number; lat: number; depthM: number | null };

function depthSamplesOf(stored: Stored): PlaceGeometryView["depthSamples"] {
  const samples = stored.get("depth")?.outputs.samples;
  if (!Array.isArray(samples)) return [];
  return (samples as StoredSample[]).map((s) => ({
    distanceM: Number(s.distanceM),
    depthM: s.depthM === null ? null : Number(s.depthM),
    position: { lon: Number(s.lon), lat: Number(s.lat) },
  }));
}

/**
 * Geometry of a place for the admin view, from the newest computation per kind of its geo object (kinds may
 * stem from different runs). Values without a computation are `null`, lists empty; `gaps` collects
 * `outputs.gaps` of all those computations; the anchor position is the place's current one (review or computed).
 * `null` for an unknown place.
 */
export async function placeGeometry(db: Db, placeId: string): Promise<PlaceGeometryView | null> {
  const [place] = await db
    .select({
      geoObjectId: places.geoObjectId,
      anchorLon: sql<number | null>`ST_X(${places.anchorPosition})`,
      anchorLat: sql<number | null>`ST_Y(${places.anchorPosition})`,
      anchorConfidence: places.anchorConfidence,
      anchorOrigin: places.anchorOrigin,
    })
    .from(places)
    .where(eq(places.id, placeId));
  if (!place) return null;

  const stored = await latestComputations(db, place.geoObjectId);
  const ordered = KIND_ORDER.flatMap((kind) => {
    const c = stored.get(kind);
    return c ? [c] : [];
  });
  const newest = ordered.reduce<StoredComputation | null>(
    (a, c) => (a === null || c.createdAt > a.createdAt ? c : a),
    null,
  );

  const fetchInputs = stored.get("fetch")?.inputs;
  const origin = (fetchInputs?.origin as LonLat | undefined) ?? null;

  const shelter = SECTORS.map((s) => value<number>(stored, "shelter", `shelter.${s}`));
  const fetchM = SECTORS.map((s) => value<number>(stored, "fetch", `fetch.${s}`));
  const sectors =
    shelter.every((v) => v !== null) && fetchM.every((v) => v !== null)
      ? (Object.fromEntries(SECTORS.map((s, i) => [s, { shelter: shelter[i]!, fetchM: fetchM[i]! }])) as Record<
          Sector,
          { shelter: number; fetchM: number }
        >)
      : null;

  const depthFact = (attribute: string) => fact(stored, "depth", attribute);
  const depthConfidenceFact = depthFact("depth.min") ?? depthFact("depth.approach") ?? depthFact("depth.anchoring_min");

  const anchorAreaRow = stored.get("anchor_area");
  const areaValue = value<{ areaM2: number }>(stored, "anchor_area", "anchor_area");

  return {
    computedAt: newest?.createdAt ?? null,
    rulesVersion: newest?.rulesVersion ?? null,
    origin,
    originSource: (fetchInputs?.originSource as string | undefined) ?? null,
    sectors,
    swell: value<number>(stored, "shelter", "swell_protection"),
    opening: value<{ bearingDeg: number | null; widthDeg: number }>(stored, "shelter", "opening_bearing"),
    rays: await raysOf(db, stored, origin),
    depth: {
      approach: value(stored, "depth", "depth.approach"),
      min: value<number>(stored, "depth", "depth.min"),
      max: value<number>(stored, "depth", "depth.max"),
      anchoringMin: value<number>(stored, "depth", "depth.anchoring_min"),
      anchoringMax: value<number>(stored, "depth", "depth.anchoring_max"),
      confidence: depthConfidenceFact?.confidence ?? null,
    },
    depthSamples: depthSamplesOf(stored),
    seabed: value(stored, "seabed", "seabed"),
    water: (anchorAreaRow?.outputs.water as Geometry | null | undefined) ?? null,
    anchorArea: areaValue
      ? { areaM2: areaValue.areaM2, geometry: (anchorAreaRow?.outputs.area as Geometry | null | undefined) ?? null }
      : null,
    anchorPosition:
      place.anchorLon === null || place.anchorLat === null
        ? null
        : {
            lon: Number(place.anchorLon),
            lat: Number(place.anchorLat),
            confidence: place.anchorConfidence,
            origin: place.anchorOrigin,
          },
    restriction: value<RestrictionHit[]>(stored, "restriction", "prohibitions") ?? [],
    gaps: ordered.flatMap((c) => (Array.isArray(c.outputs.gaps) ? (c.outputs.gaps as Gap[]) : [])),
    computations: ordered.map((c) => ({
      id: c.id,
      kind: c.kind,
      rulesVersion: c.rulesVersion,
      createdAt: c.createdAt,
      inputs: c.inputs,
    })),
  };
}
