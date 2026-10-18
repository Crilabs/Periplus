CREATE TYPE "public"."geo_object_type" AS ENUM('sea', 'area', 'gulf', 'island', 'islet', 'archipelago', 'coast_section', 'cape', 'strait', 'channel', 'bay', 'harbour', 'settlement', 'poi');--> statement-breakpoint
CREATE TYPE "public"."geo_origin" AS ENUM('osm', 'geonames', 'wikidata', 'text', 'review', 'computed', 'manual');--> statement-breakpoint
CREATE TYPE "public"."name_origin" AS ENUM('osm', 'geonames', 'wikidata', 'text', 'review', 'manual', 'transliteration', 'fallback');--> statement-breakpoint
CREATE TYPE "public"."name_script" AS ENUM('latin', 'greek');--> statement-breakpoint
CREATE TYPE "public"."place_kind" AS ENUM('anchorage', 'port', 'marina', 'mooring_field');--> statement-breakpoint
CREATE TYPE "public"."place_status" AS ENUM('candidate', 'confirmed', 'rejected', 'abandoned', 'no_anchoring');--> statement-breakpoint
CREATE TYPE "public"."poi_category" AS ENUM('food', 'supply', 'beach', 'nature', 'active', 'culture', 'town');--> statement-breakpoint
CREATE TYPE "public"."restricted_kind" AS ENUM('military', 'cable', 'protected_area', 'aquaculture', 'ferry_lane', 'firing_area');--> statement-breakpoint
CREATE TABLE "comparison_set" (
	"place_id" uuid PRIMARY KEY NOT NULL,
	"area_id" uuid NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_names" (
	"id" uuid PRIMARY KEY NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"language" text NOT NULL,
	"script" "name_script" NOT NULL,
	"origin" "name_origin" NOT NULL,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" "geo_object_type" NOT NULL,
	"parent_id" uuid,
	"geom" geometry(Geometry,4326) NOT NULL,
	"centroid" geometry(Point,4326) GENERATED ALWAYS AS (ST_PointOnSurface("geom")) STORED,
	"osm_id" text,
	"geonames_id" text,
	"wikidata_id" text,
	"origin" "geo_origin" NOT NULL,
	"public_id" text,
	"category" "poi_category",
	"config_key" text,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"merged_into_id" uuid,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "land_polygons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"geom" geometry(Polygon,4326) NOT NULL,
	"dataset_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" uuid PRIMARY KEY NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"kind" "place_kind" NOT NULL,
	"status" "place_status" DEFAULT 'candidate' NOT NULL,
	"status_reason" text,
	"public_id" text,
	"merged_into_id" uuid,
	"tile_id" text,
	"position" geometry(Point,4326) NOT NULL,
	"anchor_position" geometry(Point,4326),
	"anchor_confidence" real,
	"anchor_origin" text,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restricted_areas" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "restricted_kind" NOT NULL,
	"geom" geometry(Geometry,4326) NOT NULL,
	"source_id" uuid,
	"source_ref" text,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tile_geo_objects" (
	"tile_id" text NOT NULL,
	"geo_object_id" uuid NOT NULL,
	CONSTRAINT "tile_geo_objects_tile_id_geo_object_id_pk" PRIMARY KEY("tile_id","geo_object_id")
);
--> statement-breakpoint
CREATE TABLE "tiles" (
	"id" text PRIMARY KEY NOT NULL,
	"bbox" geometry(Polygon,4326) NOT NULL,
	"area_id" uuid,
	"has_coast" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"cycle_days" integer DEFAULT 30 NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comparison_set" ADD CONSTRAINT "comparison_set_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_set" ADD CONSTRAINT "comparison_set_area_id_geo_objects_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_names" ADD CONSTRAINT "geo_names_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_objects" ADD CONSTRAINT "geo_objects_parent_id_geo_objects_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_objects" ADD CONSTRAINT "geo_objects_merged_into_id_geo_objects_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_merged_into_id_places_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tile_geo_objects" ADD CONSTRAINT "tile_geo_objects_tile_id_tiles_id_fk" FOREIGN KEY ("tile_id") REFERENCES "public"."tiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tile_geo_objects" ADD CONSTRAINT "tile_geo_objects_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiles" ADD CONSTRAINT "tiles_area_id_geo_objects_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "geo_names_valid_unique" ON "geo_names" USING btree ("geo_object_id","name","language","origin") WHERE "geo_names"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "geo_names_name_normalized_trgm" ON "geo_names" USING gin ("name_normalized" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "geo_objects_public_id_unique" ON "geo_objects" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_objects_osm_id_valid_unique" ON "geo_objects" USING btree ("osm_id") WHERE "geo_objects"."valid_to" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "geo_objects_wikidata_id_valid_unique" ON "geo_objects" USING btree ("wikidata_id") WHERE "geo_objects"."valid_to" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "geo_objects_geonames_id_valid_unique" ON "geo_objects" USING btree ("geonames_id") WHERE "geo_objects"."valid_to" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "geo_objects_config_key_valid_unique" ON "geo_objects" USING btree ("config_key") WHERE "geo_objects"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "geo_objects_parent_id_idx" ON "geo_objects" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "geo_objects_geom_gist" ON "geo_objects" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "geo_objects_centroid_gist" ON "geo_objects" USING gist ("centroid");--> statement-breakpoint
CREATE INDEX "land_polygons_geom_gist" ON "land_polygons" USING gist ("geom");--> statement-breakpoint
CREATE UNIQUE INDEX "places_geo_object_id_unique" ON "places" USING btree ("geo_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "places_public_id_unique" ON "places" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "places_tile_id_idx" ON "places" USING btree ("tile_id");--> statement-breakpoint
CREATE INDEX "places_position_gist" ON "places" USING gist ("position");--> statement-breakpoint
CREATE INDEX "restricted_areas_geom_gist" ON "restricted_areas" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "tile_geo_objects_geo_object_id_idx" ON "tile_geo_objects" USING btree ("geo_object_id");--> statement-breakpoint
CREATE INDEX "tiles_bbox_gist" ON "tiles" USING gist ("bbox");--> statement-breakpoint
CREATE INDEX "tiles_area_id_idx" ON "tiles" USING btree ("area_id");