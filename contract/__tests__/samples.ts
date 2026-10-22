import type {
  ChangesFile,
  CoastCollection,
  HighlightsFile,
  Manifest,
  RegionsFile,
  SpotsFile,
  WeatherPointsFile,
} from "@/contract";
import { spotsFile, TEIL_B_EXAMPLE } from "./fixtures";

const SUBDIVISION = "sd_01J9X4M0A1B2C3D4E5F6G7H8J9";
const AREA = "ar_01J9X4M0A1B2C3D4E5F6G7H8JA";
const REGION = "rg_01J9X4KZ0A1B2C3D4E5F6G7H8J";
const HIGHLIGHT = "hl_01J9X4KQ3P2N1M0Z9K8J7H6G5F";
const envelope = { schemaVersion: "2.3" as const, subdivision: SUBDIVISION, dataVersion: 2, generatedAt: "2026-10-19T08:00:00.000Z" };
const square: [number, number][][] = [
  [
    [23.3, 37.6],
    [23.4, 37.6],
    [23.4, 37.7],
    [23.3, 37.7],
    [23.3, 37.6],
  ],
];

/** One valid sample per contract file (illustrative values). */
export const SAMPLE_FILES: {
  "manifest.json": Manifest;
  "spots.json": SpotsFile;
  "highlights.json": HighlightsFile;
  "regions.json": RegionsFile;
  "coast.geojson": CoastCollection;
  "weather-points.json": WeatherPointsFile;
  "changes.json": ChangesFile;
} = {
  "manifest.json": {
    schemaVersion: "2.3",
    subdivision: {
      id: SUBDIVISION,
      key: "GR-I",
      name: "Attika",
      names: [
        { lang: "en", name: "Attica" },
        { lang: "el", name: "Αττική" },
      ],
      polygon: { type: "Polygon", coordinates: square },
    },
    areas: [{ id: AREA, key: "saronic", names: [{ lang: "en", name: "Saronic Gulf" }] }],
    dataVersion: 2,
    previousDataVersion: 1,
    generatedAt: "2026-10-19T08:00:00.000Z",
    bbox: [23, 37, 23.75, 38],
    tiles: [
      { id: "q025:812:508", lastRunAt: "2026-10-18T22:10:00.000Z", profilesAsOf: "2026-10-18" },
      { id: "q025:813:508", lastRunAt: null, profilesAsOf: null },
    ],
    objectCounts: { spots: 1, highlights: 1, regions: 1, weatherPoints: 1, coastFeatures: 3, changes: 1 },
    licenses: [
      {
        name: "ODbL-1.0",
        attribution: "© OpenStreetMap contributors",
        url: "https://opendatacommons.org/licenses/odbl/1-0/",
        files: ["coast.geojson"],
        fields: ["spots.json#/spots/*/name"],
      },
    ],
    files: [{ name: "spots.json", sha256: "a".repeat(64), bytes: 1234 }],
  },
  "spots.json": { ...spotsFile([TEIL_B_EXAMPLE]), dataVersion: 2 },
  "highlights.json": {
    ...envelope,
    highlights: [
      {
        id: HIGHLIGHT,
        name: "Taverna Vathi",
        category: "food",
        importance: 2,
        position: { lat: 37.6085, lon: 23.3399 },
        spotIds: [TEIL_B_EXAMPLE.id],
        regionId: REGION,
        season: { months: [6, 7, 8, 9] },
        summary: { de: "Taverne am Strand." },
        sources: [{ url: "https://example.org/vathi", kind: "travelGuide", observedAt: "2025-05-01" }],
        externalRefs: { googlePlaceId: null, osmId: "node/42", wikidataId: null },
        score: { confidence: 0.6, sourcesCount: 1, lastObserved: "2025-05-01" },
        profileVersion: 1,
        validFrom: "2026-10-19",
      },
    ],
  },
  "regions.json": {
    ...envelope,
    regions: [
      {
        id: REGION,
        name: "Methana",
        names: [{ lang: "el", name: "Μέθανα" }],
        type: "coast",
        center: { lat: 37.6, lon: 23.35 },
        radiusNm: 6,
        polygon: { type: "MultiPolygon", coordinates: [square] },
        parentId: null,
        spotIds: [TEIL_B_EXAMPLE.id],
        character: { de: "Vulkanische Halbinsel mit ruhigen Buchten." },
        facts: { meltemiExposure: 0.4, ferryTraffic: "light", charterBase: false, supplyPort: null },
        profileVersion: 1,
        validFrom: "2026-10-19",
      },
    ],
  },
  "coast.geojson": {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: square },
        properties: { kind: "land", source: "OpenStreetMap, ODbL", extractedAt: "2026-09-30" },
      },
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: square[0]! },
        properties: { kind: "coastline", source: "OpenStreetMap, ODbL", extractedAt: "2026-09-30" },
      },
      {
        type: "Feature",
        geometry: { type: "MultiPolygon", coordinates: [square] },
        properties: { kind: "restrictedArea", reason: "military", source: "EMODnet Human Activities" },
      },
    ],
  },
  "weather-points.json": {
    ...envelope,
    points: [
      {
        id: "wp_01J9X4N0A1B2C3D4E5F6G7H8J9",
        name: "Methana offenes Wasser",
        position: { lat: 37.62, lon: 23.3 },
        kind: "region",
        regionId: REGION,
      },
    ],
  },
  "changes.json": {
    ...envelope,
    previousDataVersion: 1,
    changes: [
      {
        objectType: "spot",
        objectId: TEIL_B_EXAMPLE.id,
        event: "updated",
        fields: ["shelter"],
        severity: "safety",
        summary: { de: "Schutz aus Südost geändert." },
        profileVersion: 3,
      },
    ],
  },
};
