import type { CoastCollection, Manifest, RegionsFile, SpotsFile, WeatherPointsFile } from "@/contract/v2";
import type { GeoObjectType, PlaceKind, PlaceStatus} from "@/lib/db/schema/geo";
import type { berthStates } from "@/lib/db/schema/research-state";

/*
 * What a delivery build reads for one subdivision (spec 08, spec 14): the delivered objects with their berth states
 * and names. Loaded by `loadSubdivisionScope` (load.ts), mapped to the contract by the
 * `map-*.ts` modules. Content belongs to the subdivision by `geo_objects.subdivision_id`, never by tile label.
 */

/** A row of `berth_states`. */
export type BerthStateRow = typeof berthStates.$inferSelect;

export type LonLat = { lon: number; lat: number };

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
  /** The independent sources behind the confirmation, counted as the confirmation rule does (`decideBerth`); 0 without evidence. */
  independentSources: number;
  /** Registrable domain of the place's current website when it is bound (`place_websites`); null without one. Only a contact url of this domain is delivered. */
  ownWebsiteDomain: string | null;
  /** The computed anchor position of the place (`places.anchor_position`) with the configured confidence; null without one. */
  anchor: { lon: number; lat: number; confidence: number } | null;
  /** The geo objects the state's `nearby` entries point at (public id, names, position); an entry whose object is missing here is not delivered. */
  nearbyObjects: NearbyObject[];
  /** The deliverable current images, best first (rank, sort order, slot). */
  images: DeliverableImage[];
};

/** A thing on land a state's `nearby` entry points at, as loaded from `geo_objects`; `publicId` null when it has none (contract 4.0, E1). */
export type NearbyObject = { geoObjectId: string; publicId: string | null; name: string; names: SpotName[]; position: LonLat };

/** A place merged into another: its public id and the final target's (ruling M6-P14). */
export type MergedSpot = { publicId: string; mergedIntoPublicId: string };

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
};

export type PassageSource = {
  geoObjectId: string;
  type: "cape" | "strait" | "channel";
  name: string;
  point: LonLat;
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
  regions: RegionSource[];
  passages: PassageSource[];
};

/** A package as built and validated (contract 4.0): the manifest and its files; no highlights, no change feed. */
export type DeliveryPackage = {
  manifest: Manifest;
  files: {
    "spots.json": SpotsFile;
    "regions.json": RegionsFile;
    "coast.geojson": CoastCollection;
    "weather-points.json": WeatherPointsFile;
  };
};
