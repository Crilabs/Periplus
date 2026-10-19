CREATE TYPE "public"."seabed_type" AS ENUM('sand', 'mud', 'gravel', 'rock', 'mixed', 'weed');--> statement-breakpoint
CREATE TABLE "seabed_polygons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"substrate" "seabed_type" NOT NULL,
	"habitat" text,
	"source_ref" text,
	"area_key" text NOT NULL,
	"dataset_version" text NOT NULL,
	"geom" geometry(Polygon,4326) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "seabed_polygons_geom_gist" ON "seabed_polygons" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "seabed_polygons_area_key_idx" ON "seabed_polygons" USING btree ("area_key");