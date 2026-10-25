import type { ChangesFile, CoastCollection, HighlightsFile, Manifest, RegionsFile, SpotsFile, WeatherPointsFile } from "@/contract/v3_0";
import type { GeoObjectType, PlaceKind, PlaceStatus, HighlightCategory } from "@/lib/db/schema/geo";
import type { berthStates } from "@/lib/db/schema/research-state";
import type { DocType } from "@/lib/db/schema/sources";
import type { ProfileSnapshot } from "@/lib/domain/consolidation/types";

/*
 * What a delivery build reads for one subdivision (spec 08, spec 14): the delivered objects with their latest profiles,
 * names and the documents behind them. Loaded by `loadSubdivisionScope` (load.ts), mapped to the contract by the
 * `map-*.ts` modules. Content belongs to the subdivision by `geo_objects.subdivision_id`, never by tile label.
 */

/** A row of `berth_states`. */
export type BerthStateRow = typeof berthStates.$inferSelect;

export type LonLat = { lon: number; lat: number };

/**
 * A document behind an object's profile: its URL, effective type and newest observation date (never a quote). `gone`:
 * the document is gone; it is never listed in `sources`, but still checked against `forbiddenDomains` (final review M-1).
 */
export type SourceRefRow = { url: string; docType: DocType; observedAt: string; gone?: boolean };

/**
 * A current image of a place that may be delivered (`loadPlaceImages`): every source of its render has its delivery
 * switch on. `camera` is null for an image without a known viewpoint.
 */
export type DeliverableImage = {
  id: string;
  slot: string;
  sortOrder: number;
  rank: number;
  kind: "photo" | "ai_illustration";
  /** Archive key of the JPEG (`place_images.file_key`). */
  fileKey: string;
  width: number;
  height: number;
  alt: string;
  light: "midday" | "evening" | null;
  observedAt: string | null;
  license: string;
  attribution: string;
  camera: { position: [number, number]; heightM: number; viewBearingDeg: number; tiltDeg: number; fovDeg: number } | null;
};

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
  /** The berth state (plan N4a); null for a place without one (an excluded place, or a confirmed one the research has not reached). */
  state: BerthStateRow | null;
  /** The computed anchor position of the place (`places.anchor_position`) with the configured confidence; null without one. */
  anchor: { lon: number; lat: number; confidence: number } | null;
  /** The geo objects the state's `nearby` entries point at (public id, names, position); an entry whose object is missing here is not delivered. */
  nearbyObjects: NearbyObject[];
  /** `popularityForPlaces` on the build date (fixed neighbourhood across subdivisions, spec 18); null for a place outside its map (ruling M6-P8). */
  popularity: number | null;
  /** The deliverable current images, best first (rank, sort order, slot). */
  images: DeliverableImage[];
};

/** A thing on land a state's `nearby` entry points at, as loaded from `geo_objects`; `publicId` null when it has none (contract 4.0, E1). */
export type NearbyObject = { geoObjectId: string; publicId: string | null; name: string; names: SpotName[]; position: LonLat };

/** A place merged into another: its public id and the final target's (ruling M6-P14). */
export type MergedSpot = { publicId: string; mergedIntoPublicId: string };

export type PoiSource = {
  geoObjectId: string;
  publicId: string;
  category: HighlightCategory;
  name: string;
  position: LonLat;
  osmId: string | null;
  wikidataId: string | null;
  profile: ProfileSnapshot | null;
  summary: string | null;
  sources: SourceRefRow[];
  /** The deliverable current images, best first (rank, sort order, slot). */
  images: DeliverableImage[];
  /** The places selecting the POI as a highlight (spec 16), with the selection's distance; by place geo object id. */
  selectedBy: Array<{ placeGeoObjectId: string; distanceKm: number }>;
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
};

export type PassageSource = {
  geoObjectId: string;
  type: "cape" | "strait" | "channel";
  name: string;
  point: LonLat;
  /** The latest profile: its text-only safety values have no contract field and are reported as not delivered. */
  profile: ProfileSnapshot | null;
};

export type SubdivisionScope = {
  subdivision: {
    id: string;
    publicId: string;
    key: string;
    name: string;
    names: ObjectName[];
    polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon;
    /** `[west, south, east, north]` of the subdivision's scope tiles (its polygon's box without tiles), 5 decimals. */
    bbox: [number, number, number, number];
  };
  /** The sailing areas (Reviere) linked to the scope tiles (`tile_geo_objects`), by public id; information only. */
  areas: Array<{ publicId: string; key: string; names: ObjectName[] }>;
  /** The scope tiles (`subdivisionTileIds`) with their state; a tile without a run has no `lastRunAt` and no states. */
  tiles: Array<{ id: string; lastRunAt: string | null; statesAsOf: string | null }>;
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
