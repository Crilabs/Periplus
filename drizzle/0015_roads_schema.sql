CREATE TABLE "roads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"osm_id" text NOT NULL,
	"highway" text NOT NULL,
	"geom" geometry(LineString,4326) NOT NULL,
	"dataset_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "roads_geom_gist" ON "roads" USING gist ("geom");--> statement-breakpoint
CREATE UNIQUE INDEX "roads_osm_id_unique" ON "roads" USING btree ("osm_id");