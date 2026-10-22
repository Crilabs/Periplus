import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { geometry, raster } from "@/lib/db/geometry";
import { newId } from "@/lib/domain/ids";
import { sources } from "./sources";

/*
 * Stable tables (geo_objects, geo_names, places, tiles, restricted_areas) reject DELETE (forbid_delete trigger);
 * a row ends via valid_to. Core-column changes of geo_objects, geo_names, places and tiles write
 * <table>_history (record_history trigger). Functions, triggers and history tables: drizzle/0006_geo_triggers.sql.
 */

export const geoObjectTypeEnum = pgEnum("geo_object_type", [
  "sea",
  "area",
  "gulf",
  "island",
  "islet",
  "archipelago",
  "coast_section",
  "cape",
  "strait",
  "channel",
  "bay",
  "harbour",
  "settlement",
  "poi",
  "country",
  "admin_region",
]);
export const geoOriginEnum = pgEnum("geo_origin", [
  "osm",
  "geonames",
  "wikidata",
  "text",
  "review",
  "computed",
  "manual",
  "marine_regions",
  "import",
]);
export const subdivisionStatusEnum = pgEnum("subdivision_status", ["active", "excluded"]);
export const poiCategoryEnum = pgEnum("poi_category", ["food", "supply", "beach", "nature", "active", "culture", "town"]);
export const nameOriginEnum = pgEnum("name_origin", [
  "osm",
  "geonames",
  "wikidata",
  "text",
  "review",
  "manual",
  "transliteration",
  "fallback",
  "import",
]);
export const areaMemberRoleEnum = pgEnum("area_member_role", ["member", "boundary"]);
export const nameScriptEnum = pgEnum("name_script", ["latin", "greek"]);
export const placeKindEnum = pgEnum("place_kind", ["anchorage", "port", "marina", "mooring_field"]);
export const placeStatusEnum = pgEnum("place_status", ["candidate", "confirmed", "rejected", "abandoned", "no_anchoring"]);
export const restrictedKindEnum = pgEnum("restricted_kind", [
  "military",
  "cable",
  "protected_area",
  "aquaculture",
  "ferry_lane",
  "firing_area",
]);
export const seabedTypeEnum = pgEnum("seabed_type", ["sand", "mud", "gravel", "rock", "mixed", "weed"]);

export type GeoObjectType = (typeof geoObjectTypeEnum.enumValues)[number];
export type SubdivisionStatus = (typeof subdivisionStatusEnum.enumValues)[number];
export type GeoOrigin = (typeof geoOriginEnum.enumValues)[number];
export type PoiCategory = (typeof poiCategoryEnum.enumValues)[number];
export type NameOrigin = (typeof nameOriginEnum.enumValues)[number];
export type NameScript = (typeof nameScriptEnum.enumValues)[number];
export type PlaceKind = (typeof placeKindEnum.enumValues)[number];
export type PlaceStatus = (typeof placeStatusEnum.enumValues)[number];
export type RestrictedKind = (typeof restrictedKindEnum.enumValues)[number];
export type SeabedType = (typeof seabedTypeEnum.enumValues)[number];

const validFrom = () => date("valid_from").notNull().default(sql`current_date`);
const validTo = () => date("valid_to");
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const geoObjects = pgTable("geo_objects", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  type: geoObjectTypeEnum("type").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => geoObjects.id),
  /** Subdivision the object belongs to (nearest land, spec 14); set by the pipeline. */
  subdivisionId: uuid("subdivision_id").references((): AnyPgColumn => subdivisions.id),
  /** Sea the object lies in (type `sea`); set by the pipeline. */
  seaId: uuid("sea_id").references((): AnyPgColumn => geoObjects.id),
  /** OSM admin_level, only for `admin_region`. */
  adminLevel: integer("admin_level"),
  geom: geometry("geom", "Geometry").notNull(),
  /** ST_PointOnSurface: lies on the surface even for concave bays. */
  centroid: geometry("centroid", "Point").generatedAlwaysAs(sql`ST_PointOnSurface("geom")`),
  /** `node/…`, `way/…`, `relation/…` */
  osmId: text("osm_id"),
  /** Digits only. */
  geonamesId: text("geonames_id"),
  /** `Q…` */
  wikidataId: text("wikidata_id"),
  origin: geoOriginEnum("origin").notNull(),
  /** Only for delivered types: `ar_` (area), `rg_` (island, archipelago, coast_section, gulf, channel), `hl_` (poi). */
  publicId: text("public_id"),
  /** Only for `poi`. */
  category: poiCategoryEnum("category"),
  /** Only for `area` / `coast_section` defined in configuration. */
  configKey: text("config_key"),
  /**
   * OSM tags kept from the import (whitelist: place, natural, seamark:*, leisure, harbour, mooring, historic,
   * tourism, amenity, shop, wikidata). Not a core column: changes write no history.
   */
  tags: jsonb("tags").notNull().default({}),
  /** `P856` (official website) of the linked Wikidata item; its own column because an OSM upsert replaces `tags`. */
  websiteWikidata: text("website_wikidata"),
  mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => geoObjects.id),
  validFrom: validFrom(),
  validTo: validTo(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("geo_objects_public_id_unique").on(t.publicId),
  uniqueIndex("geo_objects_osm_id_valid_unique").on(t.osmId).where(sql`${t.validTo} is null`),
  uniqueIndex("geo_objects_wikidata_id_valid_unique").on(t.wikidataId).where(sql`${t.validTo} is null`),
  uniqueIndex("geo_objects_geonames_id_valid_unique").on(t.geonamesId).where(sql`${t.validTo} is null`),
  uniqueIndex("geo_objects_config_key_valid_unique").on(t.configKey).where(sql`${t.validTo} is null`),
  index("geo_objects_parent_id_idx").on(t.parentId),
  index("geo_objects_subdivision_id_idx").on(t.subdivisionId).where(sql`${t.subdivisionId} is not null`),
  index("geo_objects_sea_id_idx").on(t.seaId).where(sql`${t.seaId} is not null`),
  // the merge chain of a consolidated object (loadInputs, loadContext) walks merged_into_id
  index("geo_objects_merged_into_id_idx").on(t.mergedIntoId).where(sql`${t.mergedIntoId} is not null`),
  index("geo_objects_geom_gist").using("gist", t.geom),
  index("geo_objects_centroid_gist").using("gist", t.centroid),
]);

/**
 * Stable unit of work (spec 14): a Landesteil. Rejects DELETE and records history (drizzle/0054).
 * `land_geom` (polygon ∩ land polygons) stays null until computed.
 */
export const subdivisions = pgTable("subdivisions", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  /** `sd_<ulid>` */
  publicId: text("public_id").notNull(),
  key: text("key").notNull(),
  /** ISO 3166-1 alpha-2 */
  country: text("country").notNull(),
  geoObjectId: uuid("geo_object_id")
    .notNull()
    .references((): AnyPgColumn => geoObjects.id),
  geom: geometry("geom", "MultiPolygon").notNull(),
  landGeom: geometry("land_geom", "MultiPolygon"),
  status: subdivisionStatusEnum("status").notNull().default("active"),
  statusReason: text("status_reason"),
  queuedAt: timestamp("queued_at", { withTimezone: true }),
  builtAt: timestamp("built_at", { withTimezone: true }),
  validFrom: validFrom(),
  validTo: validTo(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("subdivisions_public_id_unique").on(t.publicId),
  uniqueIndex("subdivisions_key_valid_unique").on(t.key).where(sql`${t.validTo} is null`),
  check("subdivisions_public_id_prefix", sql`${t.publicId} like 'sd\\_%'`),
  index("subdivisions_geom_gist").using("gist", t.geom),
  index("subdivisions_land_geom_gist").using("gist", t.landGeom),
]);

export const geoNames = pgTable("geo_names", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  geoObjectId: uuid("geo_object_id")
    .notNull()
    .references(() => geoObjects.id),
  name: text("name").notNull(),
  /** Lower case, without accents; search key (trigram index). */
  nameNormalized: text("name_normalized").notNull(),
  language: text("language").notNull(),
  script: nameScriptEnum("script").notNull(),
  origin: nameOriginEnum("origin").notNull(),
  isPreferred: boolean("is_preferred").notNull().default(false),
  validFrom: validFrom(),
  validTo: validTo(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("geo_names_valid_unique")
    .on(t.geoObjectId, t.name, t.language, t.origin)
    .where(sql`${t.validTo} is null`),
  index("geo_names_geo_object_id_idx").on(t.geoObjectId),
  index("geo_names_name_normalized_trgm").using("gin", t.nameNormalized.op("gin_trgm_ops")),
]);

export const tiles = pgTable("tiles", {
  /** `q025:<col>:<row>`, see tile_id_for. */
  id: text("id").primaryKey(),
  bbox: geometry("bbox", "Polygon").notNull(),
  /** Label area (geo_objects of type `area`). */
  areaId: uuid("area_id").references(() => geoObjects.id),
  /** Label subdivision: the one with the largest coastline share in the tile (spec 14). */
  subdivisionId: uuid("subdivision_id").references((): AnyPgColumn => subdivisions.id),
  hasCoast: boolean("has_coast").notNull().default(false),
  priority: integer("priority").notNull().default(0),
  cycleDays: integer("cycle_days").notNull().default(30),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  validFrom: validFrom(),
  validTo: validTo(),
  createdAt: createdAt(),
}, (t) => [index("tiles_bbox_gist").using("gist", t.bbox), index("tiles_area_id_idx").on(t.areaId),
  index("tiles_subdivision_id_idx").on(t.subdivisionId),
]);

/** Working state: rewritten after every gazetteer run (ST_Intersects). */
export const tileGeoObjects = pgTable("tile_geo_objects", {
  tileId: text("tile_id")
    .notNull()
    .references(() => tiles.id),
  geoObjectId: uuid("geo_object_id")
    .notNull()
    .references(() => geoObjects.id),
}, (t) => [
  primaryKey({ columns: [t.tileId, t.geoObjectId] }),
  index("tile_geo_objects_geo_object_id_idx").on(t.geoObjectId),
]);

export const places = pgTable("places", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  geoObjectId: uuid("geo_object_id")
    .notNull()
    .references(() => geoObjects.id),
  kind: placeKindEnum("kind").notNull(),
  status: placeStatusEnum("status").notNull().default("candidate"),
  statusReason: text("status_reason"),
  /** `sp_<ulid>`, assigned on first confirmation, never changed. */
  publicId: text("public_id"),
  mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => places.id),
  /** Set from `position` by the places_set_tile trigger; never written by the application. */
  tileId: text("tile_id"),
  /** Centre of the bay or harbour basin. */
  position: geometry("position", "Point").notNull(),
  anchorPosition: geometry("anchor_position", "Point"),
  anchorConfidence: real("anchor_confidence"),
  anchorOrigin: text("anchor_origin"),
  validFrom: validFrom(),
  validTo: validTo(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("places_geo_object_id_unique").on(t.geoObjectId),
  uniqueIndex("places_public_id_unique").on(t.publicId),
  index("places_tile_id_idx").on(t.tileId),
  index("places_position_gist").using("gist", t.position),
  index("places_anchor_position_gist").using("gist", t.anchorPosition),
]);

/** Official exclusion areas (spec 04). */
export const restrictedAreas = pgTable("restricted_areas", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  kind: restrictedKindEnum("kind").notNull(),
  geom: geometry("geom", "Geometry").notNull(),
  sourceId: uuid("source_id").references(() => sources.id),
  sourceRef: text("source_ref"),
  validFrom: validFrom(),
  validTo: validTo(),
  createdAt: createdAt(),
}, (t) => [index("restricted_areas_geom_gist").using("gist", t.geom)]);

export const landPolygons = pgTable("land_polygons", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  geom: geometry("geom", "Polygon").notNull(),
  datasetVersion: text("dataset_version").notNull(),
  createdAt: createdAt(),
}, (t) => [index("land_polygons_geom_gist").using("gist", t.geom)]);

/**
 * Working state: bathymetry rasters per dataset and Periplus tile (256×256 raster tiles), replaced per
 * (dataset, tile_id) on import. Values are depth below LAT in metres, positive in water; ≤ 0 is land/dry.
 * GIST on ST_ConvexHull(rast): drizzle/0013_bathymetry_gist.sql.
 */
export const bathymetry = pgTable("bathymetry", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  dataset: text("dataset").notNull(),
  datasetVersion: text("dataset_version").notNull(),
  resolutionM: real("resolution_m").notNull(),
  /** Periplus tile the raster was fetched for (no FK: datasets may cover tiles not yet in `tiles`). */
  tileId: text("tile_id").notNull(),
  rast: raster("rast").notNull(),
  createdAt: createdAt(),
}, (t) => [index("bathymetry_dataset_tile_id_idx").on(t.dataset, t.tileId)]);

/**
 * Working state: seabed polygons (EMODnet EUSeaMap) per subdivision, replaced per `subdivision_key` on import.
 * Neighbouring subdivisions may import the same polygon; shares union the geometries so overlaps count once.
 */
export const seabedPolygons = pgTable("seabed_polygons", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  substrate: seabedTypeEnum("substrate").notNull(),
  habitat: text("habitat"),
  sourceRef: text("source_ref"),
  subdivisionKey: text("subdivision_key").notNull(),
  datasetVersion: text("dataset_version").notNull(),
  geom: geometry("geom", "Polygon").notNull(),
  createdAt: createdAt(),
}, (t) => [index("seabed_polygons_geom_gist").using("gist", t.geom), index("seabed_polygons_subdivision_key_idx").on(t.subdivisionKey)]);

/**
 * Working state: OSM roads (Overpass, `highway` from `config/datasets.json`) for the distance to the next road.
 * One row per way (`osm_id` `way/…`); an import replaces the rows in its box.
 */
export const roads = pgTable("roads", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  osmId: text("osm_id").notNull(),
  highway: text("highway").notNull(),
  geom: geometry("geom", "LineString").notNull(),
  datasetVersion: text("dataset_version").notNull(),
  createdAt: createdAt(),
}, (t) => [index("roads_geom_gist").using("gist", t.geom), uniqueIndex("roads_osm_id_unique").on(t.osmId)]);

/** Navily comparison set: place IDs only, never Navily values. */
export const comparisonSet = pgTable("comparison_set", {
  placeId: uuid("place_id")
    .primaryKey()
    .references(() => places.id),
  /** Legacy, read nowhere; dropped in plan 14b. */
  areaId: uuid("area_id").references(() => geoObjects.id),
  subdivisionId: uuid("subdivision_id").references(() => subdivisions.id),
  addedBy: text("added_by").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Members of an area (type `area`) delivered by the Revier-Bot (spec 14): the geo objects the file's member and
 * boundary-point names resolved to. Re-derived on every import, so DELETE is allowed.
 */
export const areaMembers = pgTable("area_members", {
  areaId: uuid("area_id")
    .notNull()
    .references(() => geoObjects.id),
  geoObjectId: uuid("geo_object_id")
    .notNull()
    .references(() => geoObjects.id),
  role: areaMemberRoleEnum("role").notNull(),
  /** The name in the file this member was resolved from. */
  name: text("name").notNull(),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.areaId, t.geoObjectId, t.role] }),
  index("area_members_geo_object_id_idx").on(t.geoObjectId),
]);

/** Literal quotes of the bot file backing an area; append-only, only `area_id` may move (area merge). */
export const areaEvidence = pgTable("area_evidence", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  areaId: uuid("area_id")
    .notNull()
    .references(() => geoObjects.id),
  url: text("url").notNull(),
  publisher: text("publisher").notNull().default(""),
  language: text("language").notNull(),
  quote: text("quote").notNull(),
  fileGeneratedAt: date("file_generated_at").notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("area_evidence_unique").on(t.areaId, t.url, t.quote),
  index("area_evidence_area_id_idx").on(t.areaId),
  check("area_evidence_quote_not_empty", sql`length(${t.quote}) > 0`),
]);
