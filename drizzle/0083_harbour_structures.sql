CREATE TABLE "harbour_structures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"osm_id" text NOT NULL,
	"man_made" text NOT NULL,
	"geom" geometry(Geometry,4326) NOT NULL,
	"dataset_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "harbour_structures_geom_gist" ON "harbour_structures" USING gist ("geom");--> statement-breakpoint
CREATE UNIQUE INDEX "harbour_structures_osm_id_unique" ON "harbour_structures" USING btree ("osm_id");