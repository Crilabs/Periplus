import type { Highlight, Region, Spot, WeatherPoint } from "@/contract";
import { TEIL_B_EXAMPLE } from "@/contract/__tests__/fixtures";
import type { DeliveryPackage } from "@/lib/domain/delivery/types";

/*
 * A small valid package (no database rows): the second delivery of an area around 21.0° E / 35.2° N. An island (one
 * land polygon, its coastline), anchorage A 0.3 nm off its south coast, marina M off its east coast (referenced by no
 * other object, so a broken M touches one check only), the taverna highlight 7 nm north of A (importance 2, radius
 * 10 nm), the island as region, one weather point. Previous package: A, M, highlight and region at version 1 and spot
 * X, which is gone now; A rose to version 2. `validPackage()` passes every check with `PREVIOUS` as predecessor.
 */

export const SUBDIVISION_ID = "sd_01J9ZD00000000000000000001";
export const AREA_ID = "ar_01J9ZD00000000000000000001";
export const SPOT_A = "sp_01J9ZD00000000000000000001";
export const SPOT_M = "sp_01J9ZD00000000000000000002";
export const SPOT_X = "sp_01J9ZD00000000000000000003";
export const OTHER_SP = "sp_01J9ZD00000000000000000009";
export const HIGHLIGHT = "hl_01J9ZD00000000000000000001";
export const OTHER_HL = "hl_01J9ZD00000000000000000009";
export const REGION = "rg_01J9ZD00000000000000000001";
export const WEATHER_POINT = "wp_01J9ZD00000000000000000001";

/** On the island, 2 nm north of its south coast (more than `maxWaterDistanceNm` from water). */
export const INLAND_2NM = { lat: 35.23333, lon: 21.05 };

const GENERATED_AT = "2026-10-20T06:00:00.000Z";
const envelope = { schemaVersion: "2.1" as const, subdivision: SUBDIVISION_ID, dataVersion: 2, generatedAt: GENERATED_AT };
const island: [number, number][] = [
  [21.0, 35.2],
  [21.1, 35.2],
  [21.1, 35.3],
  [21.0, 35.3],
  [21.0, 35.2],
];

/** The contract versions of the previous package (data version 1). */
export const PREVIOUS = {
  dataVersion: 1,
  versions: new Map([
    [SPOT_A, 1],
    [SPOT_M, 1],
    [SPOT_X, 1],
    [HIGHLIGHT, 1],
    [REGION, 1],
  ]),
};

/** Moves a position `metres` to the south (5 decimals). */
export function offsetSouth(p: { lat: number; lon: number }, metres: number): { lat: number; lon: number } {
  return { lat: Number((p.lat - metres / 1852 / 60).toFixed(5)), lon: p.lon };
}

const spotA: Spot = {
  ...TEIL_B_EXAMPLE,
  id: SPOT_A,
  position: { lat: 35.195, lon: 21.05 },
  anchorPosition: { lat: 35.1948, lon: 21.0502, confidence: 0.6, source: "computed" },
  highlightIds: [HIGHLIGHT],
  externalRefs: { googlePlaceIds: { food: ["ChIJN1t_tDeuEmsRUsoyG83frY4"] }, osmId: "way/123456789", wikidataId: null },
  regionId: REGION,
  profileVersion: 2,
  validFrom: "2026-10-20",
};

const marina: Spot = {
  id: SPOT_M,
  kind: "marina",
  name: "Marina Nisida",
  position: { lat: 35.25, lon: 21.105 },
  shelter: { sectors: { N: 0.9, NE: 0.9, E: 0.9, SE: 0.9, S: 0.9, SW: 0.9, W: 0.9, NW: 0.9 }, swell: 0.9, source: "computed" },
  limits: { maxDraft: 4, maxLength: 30, capacity: 120 },
  berth: { status: "usuallySpace", months: [], sourcesCount: 1, bookable: null },
  exclude: { excluded: false, reason: null, detail: null },
  score: { confidence: 0.6, popularity: 0.3, quietness: null, sourcesCount: 2, lastObserved: null },
  summary: { de: "Marina mit Wasser und Strom an der Ostküste." },
  provenance: { shelter: { source: "computed", confidence: 0.8, observedAt: null } },
  regionId: null,
  mergedInto: null,
  profileVersion: 1,
  validFrom: "2026-10-01",
};

const highlight: Highlight = {
  id: HIGHLIGHT,
  name: "Taverna Vathí",
  category: "food",
  importance: 2,
  position: { lat: 35.31167, lon: 21.05 },
  spotIds: [SPOT_A],
  regionId: REGION,
  season: { months: [6, 7, 8, 9] },
  summary: { de: "Taverne am Hafen mit Fisch vom Tag." },
  sources: [{ url: "https://example.org/vathi", kind: "travelGuide", observedAt: "2025-05-01" }],
  externalRefs: { googlePlaceId: null, osmId: "node/42", wikidataId: null },
  score: { confidence: 0.6, sourcesCount: 1, lastObserved: "2025-05-01" },
  profileVersion: 1,
  validFrom: "2026-10-01",
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
  profileVersion: 1,
  validFrom: "2026-10-01",
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
      schemaVersion: "2.1",
      subdivision: {
        id: SUBDIVISION_ID,
        key: "XT-NISIDA",
        name: "Testlandesteil",
        names: [],
        polygon: { type: "Polygon", coordinates: [[[20.9, 35.1], [21.3, 35.1], [21.3, 35.4], [20.9, 35.4], [20.9, 35.1]]] },
      },
      areas: [{ id: AREA_ID, key: "nisida-test", names: [{ lang: "de", name: "Testrevier" }] }],
      dataVersion: 2,
      previousDataVersion: 1,
      generatedAt: GENERATED_AT,
      bbox: [20.9, 35.1, 21.3, 35.4],
      tiles: [{ id: "q025:804:501", lastRunAt: null, profilesAsOf: null }],
      objectCounts: { spots: 2, highlights: 1, regions: 1, weatherPoints: 1, coastFeatures: 2, changes: 2 },
      licenses: [],
      files: [],
    },
    files: {
      "spots.json": { ...envelope, spots: [spotA, marina] },
      "highlights.json": { ...envelope, highlights: [highlight] },
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
      "changes.json": {
        ...envelope,
        previousDataVersion: 1,
        changes: [
          {
            objectType: "spot",
            objectId: SPOT_A,
            event: "updated",
            fields: ["shelter.sectors.N"],
            severity: "info",
            summary: { de: "Geändert: Schutz." },
            profileVersion: 2,
          },
          {
            objectType: "spot",
            objectId: SPOT_X,
            event: "removed",
            fields: [],
            severity: "notable",
            summary: { de: "Nicht mehr im Paket." },
            profileVersion: 2,
          },
        ],
      },
    },
  } satisfies DeliveryPackage);
}

/** A copy of the package with `patch` applied. */
export function breakPackage(pkg: DeliveryPackage, patch: (draft: DeliveryPackage) => void): DeliveryPackage {
  const draft = structuredClone(pkg);
  patch(draft);
  return draft;
}
