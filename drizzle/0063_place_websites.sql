CREATE TYPE "public"."place_website_origin" AS ENUM('osm', 'wikidata', 'serp');--> statement-breakpoint
ALTER TYPE "public"."serp_level" ADD VALUE 'place_website';--> statement-breakpoint
ALTER TYPE "public"."source_origin" ADD VALUE 'place_website';--> statement-breakpoint
CREATE TABLE "place_websites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"place_id" uuid NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"url" text NOT NULL,
	"url_normalized" text NOT NULL,
	"origin" "place_website_origin" NOT NULL,
	"serp_query_id" uuid,
	"quote" text,
	"confidence" real,
	"source_id" uuid,
	"bound" boolean NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_objects" ADD COLUMN "website_wikidata" text;--> statement-breakpoint
ALTER TABLE "place_websites" ADD CONSTRAINT "place_websites_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_websites" ADD CONSTRAINT "place_websites_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_websites" ADD CONSTRAINT "place_websites_serp_query_id_serp_queries_id_fk" FOREIGN KEY ("serp_query_id") REFERENCES "public"."serp_queries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_websites" ADD CONSTRAINT "place_websites_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_websites" ADD CONSTRAINT "place_websites_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "place_websites_place_id_created_at_idx" ON "place_websites" USING btree ("place_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "place_websites_url_normalized_idx" ON "place_websites" USING btree ("url_normalized");