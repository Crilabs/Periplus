CREATE TABLE "highlight_selections" (
	"place_geo_object_id" uuid NOT NULL,
	"poi_geo_object_id" uuid NOT NULL,
	"category" "poi_category" NOT NULL,
	"rank" integer NOT NULL,
	"distance_km" real NOT NULL,
	"profile_version" integer NOT NULL,
	CONSTRAINT "highlight_selections_pk" PRIMARY KEY("place_geo_object_id","poi_geo_object_id"),
	CONSTRAINT "highlight_selections_rank_positive" CHECK ("highlight_selections"."rank" >= 1)
);
--> statement-breakpoint
ALTER TABLE "highlight_selections" ADD CONSTRAINT "highlight_selections_place_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("place_geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlight_selections" ADD CONSTRAINT "highlight_selections_poi_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("poi_geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "highlight_selections_poi_idx" ON "highlight_selections" USING btree ("poi_geo_object_id");