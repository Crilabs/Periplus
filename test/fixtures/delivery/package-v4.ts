import type { Region, Spot, WeatherPoint } from "@/contract";
import { TEIL_B_EXAMPLE } from "@/contract/__tests__/fixtures";
import type { DeliveryPackage } from "@/lib/domain/delivery/types";

/*
 * A small valid 4.0 package (no database rows): the second delivery of an area around 21.0° E / 35.2° N. An island
 * (one land polygon, its coastline), anchorage A 0.3 nm off its south coast with a landside fact about the taverna
 * in its `nearby`, marina M off its east coast (referenced by no other object, so a broken M touches one check only),
 * the island as region, one weather point. `validPackage()` passes every check with `PREVIOUS` as predecessor.
 */

export const SUBDIVISION_ID = "sd_01J9ZD00000000000000000001";
export const AREA_ID = "ar_01J9ZD00000000000000000001";
export const SPOT_A = "sp_01J9ZD00000000000000000001";
export const SPOT_M = "sp_01J9ZD00000000000000000002";
export const OTHER_SP = "sp_01J9ZD00000000000000000009";
/** The taverna on land: its `hl_` id is in A's `nearby`, a landside fact of A points at it. */
export const TAVERNA = "hl_01J9ZD00000000000000000001";
export const OTHER_HL = "hl_01J9ZD00000000000000000009";
export const FACT_SPOT = "fc_01J9ZD00000000000000000001";
export const FACT_LANDSIDE = "fc_01J9ZD00000000000000000002";
export const REGION = "rg_01J9ZD00000000000000000001";
export const WEATHER_POINT = "wp_01J9ZD00000000000000000001";

/** On the island, 2 nm north of its south coast (more than `maxWaterDistanceNm` from water). */
export const INLAND_2NM = { lat: 35.23333, lon: 21.05 };

const GENERATED_AT = "2026-10-20T06:00:00.000Z";
const envelope = {
  schemaVersion: "4.0" as const,
  scope: { type: "subdivision" as const, id: SUBDIVISION_ID, dataVersion: 2 },
  generatedAt: GENERATED_AT,
};
const island: [number, number][] = [
  [21.0, 35.2],
  [21.1, 35.2],
  [21.1, 35.3],
  [21.0, 35.3],
  [21.0, 35.2],
];

/** The previous package (data version 1). */
export const PREVIOUS = { dataVersion: 1 };

/** Moves a position `metres` to the south (5 decimals). */
export function offsetSouth(p: { lat: number; lon: number }, metres: number): { lat: number; lon: number } {
  return { lat: Number((p.lat - metres / 1852 / 60).toFixed(5)), lon: p.lon };
}

const spotA: Spot = {
  ...TEIL_B_EXAMPLE,
  id: SPOT_A,
  position: { lat: 35.195, lon: 21.05 },
  anchorPosition: { lat: 35.1948, lon: 21.0502, confidence: 0.6, source: "computed" },
  externalRefs: { googlePlaceIds: { food: ["ChIJN1t_tDeuEmsRUsoyG83frY4"] }, osmId: "way/123456789", wikidataId: null },
  regionId: REGION,
  asOf: "2026-10-20",
  gaps: ["prices"],
  facts: [
    { id: FACT_SPOT, subject: { kind: "spot" }, text: "Fallböen bei Meltemi aus Nordost.", observedAt: "2025-06-10", tone: "negative", safety: true, mentions: 3 },
    {
      id: FACT_LANDSIDE,
      subject: { kind: "landside", id: TAVERNA, name: null },
      text: "Die Taverne am Strand ist von Juni bis September geöffnet.",
      observedAt: "2025-06-10",
      tone: "positive",
      safety: false,
      mentions: 1,
    },
  ],
  landingPoints: [
    { kind: "beach", position: { lat: 35.1952, lon: 21.0498 } },
    { kind: "text", description: "Dinghy-Steg am Ostende des Strandes." },
  ],
  nearby: [{ id: TAVERNA, category: "food", name: "Taverna Vathi", position: { lat: 35.1955, lon: 21.0505 }, distanceM: 120, access: "foot" }],
};

const marina: Spot = {
  id: SPOT_M,
  kind: "marina",
  berthable: true,
  contact: null,
  name: "Marina Nisida",
  position: { lat: 35.25, lon: 21.105 },
  shelter: { sectors: { N: 0.9, NE: 0.9, E: 0.9, SE: 0.9, S: 0.9, SW: 0.9, W: 0.9, NW: 0.9 }, swell: 0.9, source: "computed" },
  limits: { maxDraft: 4, maxLength: 30, capacity: 120 },
  berth: { status: "usuallySpace", months: [], sourcesCount: 1, bookable: null },
  exclude: { excluded: false, reason: null, detail: null },
  score: { confidence: 0.6, popularity: 0.3, quietness: null, sourcesCount: 2, lastObserved: null },
  provenance: { shelter: { source: "computed", confidence: 0.8, observedAt: null } },
  regionId: null,
  mergedInto: null,
  asOf: "2026-10-19",
  gaps: [],
  facts: [],
  landingPoints: [],
  nearby: [],
};

const region: Region = {
  id: REGION,
  name: "Nisida",
  type: "island",
  center: { lat: 35.25, lon: 21.05 },
  radiusNm: 3.5,
  polygon: { type: "Polygon", coordinates: [island] },
  parentId: null,
  spotIds: [SPOT_A],
  character: { de: "Vor dem Meltemi geschützt." },
};

const weatherPoint: WeatherPoint = {
  id: WEATHER_POINT,
  name: "Nisida offenes Wasser",
  position: { lat: 35.15, lon: 21.05 },
  kind: "region",
  regionId: REGION,
};

export function validPackage(): DeliveryPackage {
  return structuredClone({
    manifest: {
      schemaVersion: "4.0",
      scope: {
        type: "subdivision",
        subdivision: {
          id: SUBDIVISION_ID,
          key: "XT-NISIDA",
          name: "Testlandesteil",
          names: [],
          polygon: { type: "Polygon", coordinates: [[[20.9, 35.1], [21.3, 35.1], [21.3, 35.4], [20.9, 35.4], [20.9, 35.1]]] },
        },
        dataVersion: 2,
        previousDataVersion: 1,
      },
      coverage: [{ id: SUBDIVISION_ID, key: "XT-NISIDA", name: "Testlandesteil", status: "delivered", dataVersion: 2 }],
      areas: [{ id: AREA_ID, key: "nisida-test", names: [{ lang: "de", name: "Testrevier" }] }],
      generatedAt: GENERATED_AT,
      bbox: [20.9, 35.1, 21.3, 35.4],
      tiles: [{ id: "q025:804:501", lastRunAt: null, statesAsOf: null }],
      objectCounts: { spots: 2, regions: 1, weatherPoints: 1, coastFeatures: 2 },
      licenses: [],
      files: [],
    },
    files: {
      "spots.json": { ...envelope, spots: [spotA, marina] },
      "regions.json": { ...envelope, regions: [region] },
      "coast.geojson": {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [island] },
            properties: { kind: "land", source: "OpenStreetMap, ODbL", extractedAt: "2026-09-30" },
          },
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: island },
            properties: { kind: "coastline", source: "OpenStreetMap, ODbL", extractedAt: "2026-09-30" },
          },
        ],
      },
      "weather-points.json": { ...envelope, points: [weatherPoint] },
    },
  } satisfies DeliveryPackage);
}

/** A copy of the package with `patch` applied. */
export function breakPackage(pkg: DeliveryPackage, patch: (draft: DeliveryPackage) => void): DeliveryPackage {
  const draft = structuredClone(pkg);
  patch(draft);
  return draft;
}
