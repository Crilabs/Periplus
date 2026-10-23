CREATE TYPE "public"."page_kind" AS ENUM('trip_report', 'pilot_guide', 'marina', 'authority', 'forum', 'travel_guide', 'listing', 'other');--> statement-breakpoint
CREATE TYPE "public"."research_purpose" AS ENUM('positive', 'negative');--> statement-breakpoint
ALTER TYPE "public"."serp_level" ADD VALUE 'research';--> statement-breakpoint
ALTER TYPE "public"."source_origin" ADD VALUE 'research';--> statement-breakpoint
CREATE TABLE "page_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_version_id" uuid NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"page_kind" "page_kind" NOT NULL,
	"first_hand" boolean NOT NULL,
	"generated" boolean NOT NULL,
	"language" text,
	"observed_at" date NOT NULL,
	"observed_at_basis" "observed_at_basis" NOT NULL,
	"observed_at_reason" text,
	"berths" jsonb NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_hits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"place_id" uuid NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"serp_query_id" uuid NOT NULL,
	"serp_result_id" uuid NOT NULL,
	"url_normalized" text NOT NULL,
	"domain" text NOT NULL,
	"rank" integer NOT NULL,
	"purpose" "research_purpose" NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_assessments" ADD CONSTRAINT "page_assessments_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_assessments" ADD CONSTRAINT "page_assessments_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_hits" ADD CONSTRAINT "research_hits_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_hits" ADD CONSTRAINT "research_hits_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_hits" ADD CONSTRAINT "research_hits_serp_query_id_serp_queries_id_fk" FOREIGN KEY ("serp_query_id") REFERENCES "public"."serp_queries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_hits" ADD CONSTRAINT "research_hits_serp_result_id_serp_results_id_fk" FOREIGN KEY ("serp_result_id") REFERENCES "public"."serp_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_hits" ADD CONSTRAINT "research_hits_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_assessments_version_model_prompt_unique" ON "page_assessments" USING btree ("document_version_id","model","prompt_version");--> statement-breakpoint
CREATE UNIQUE INDEX "research_hits_place_id_url_normalized_purpose_unique" ON "research_hits" USING btree ("place_id","url_normalized","purpose");--> statement-breakpoint
CREATE INDEX "research_hits_url_normalized_idx" ON "research_hits" USING btree ("url_normalized");