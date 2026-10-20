import type {
  ChangesFile,
  CoastCollection,
  HighlightsFile,
  Manifest,
  RegionsFile,
  SpotsFile,
  WeatherPointsFile,
} from "@/contract";
import type { GeoObjectType, PlaceKind, PlaceStatus, PoiCategory } from "@/lib/db/schema/geo";
import type { DocType } from "@/lib/db/schema/sources";
import type { ProfileSnapshot } from "@/lib/domain/consolidation/types";

/*
 * What a delivery build reads for one area (spec 08): the delivered objects with their latest profiles, names and the
 * documents behind them. Loaded by `loadAreaScope` (load.ts), mapped to the contract by the `map-*.ts` modules.
 */

export type LonLat = { lon: number; lat: number };

/**
 * A document behind an object's profile: its URL, effective type and newest observation date (never a quote). `gone`:
 * the document is gone; it is never listed in `sources`, but still checked against `forbiddenDomains` (final review M-1).
 */
export type SourceRefRow = { url: string; docType: DocType; observedAt: string; gone?: boolean };

export type SpotName = { lang: string; name: string; script: "latin" | "greek" };
export type ObjectName = { lang: string; name: string };

/** A place delivered as a spot: confirmed or excluded (`spots.statuses`), with public id, unmerged. */
export type SpotSource = {
  placeId: string;
  geoObjectId: string;
  publicId: string;
  kind: PlaceKind;
  status: PlaceStatus;
  statusReason: string | null;
  position: LonLat;
  name: string;
  names: SpotName[];
  osmId: string | null;
  wikidataId: string | null;
  profile: ProfileSnapshot | null;
  /** The `ok` summary of the latest profile version (highest prompt version), ruling M6-P9. */
  summary: string | null;
  /** `popularityForArea` on the build date; null for a place outside its map (ruling M6-P8). */
  popularity: number | null;
  sources: SourceRefRow[];
};

/** A place merged into another: its public id and the final target's (ruling M6-P14). */
export type MergedSpot = { publicId: string; mergedIntoPublicId: string };

export type PoiSource = {
  geoObjectId: string;
  publicId: string;
  category: PoiCategory;
  name: string;
  position: LonLat;
  osmId: string | null;
  wikidataId: string | null;
  profile: ProfileSnapshot | null;
  summary: string | null;
  sources: SourceRefRow[];
};

export type RegionSource = {
  geoObjectId: string;
  publicId: string;
  type: GeoObjectType;
  name: string;
  names: ObjectName[];
  /** Simplified in the UTM zone (`regions.simplifyToleranceM`), 5 decimals; null for a region known as a point. */
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  center: LonLat;
  radiusNm: number;
  areaKm2: number | null;
  /** Ancestors via `parent_id`, nearest first. */
  parentGeoObjectIds: string[];
  profile: ProfileSnapshot | null;
  /** The documents behind the profile; only checked against `forbiddenDomains` (final review I-2), never delivered. */
  sources: SourceRefRow[];
};

export type PassageSource = { geoObjectId: string; type: "cape" | "strait" | "channel"; name: string; point: LonLat };

export type AreaScope = {
  area: {
    geoObjectId: string;
    publicId: string;
    key: string;
    name: string;
    names: ObjectName[];
    polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon;
    /** `[west, south, east, north]` of the area's tiles, 5 decimals. */
    bbox: [number, number, number, number];
  };
  tiles: Array<{ id: string; lastRunAt: string | null; profilesAsOf: string | null }>;
  spots: SpotSource[];
  merged: MergedSpot[];
  pois: PoiSource[];
  regions: RegionSource[];
  passages: PassageSource[];
};

/** A package as built and validated (spec 08): the manifest and its files; `changes.json` from the second delivery on. */
export type DeliveryPackage = {
  manifest: Manifest;
  files: {
    "spots.json": SpotsFile;
    "highlights.json": HighlightsFile;
    "regions.json": RegionsFile;
    "coast.geojson": CoastCollection;
    "weather-points.json": WeatherPointsFile;
    "changes.json"?: ChangesFile;
  };
};
