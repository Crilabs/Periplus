CREATE TYPE "public"."ambiguous_status" AS ENUM('pending', 'resolved', 'none');--> statement-breakpoint
CREATE TYPE "public"."batch_item_status" AS ENUM('pending', 'succeeded', 'failed', 'retried');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('submitting', 'submitted', 'ended', 'distributed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."comparison_verdict" AS ENUM('a_correct', 'b_correct', 'both_ok', 'both_wrong', 'unclear');--> statement-breakpoint
CREATE TYPE "public"."extraction_purpose" AS ENUM('regular', 'reprocess', 'comparison');--> statement-breakpoint
CREATE TYPE "public"."extraction_run_status" AS ENUM('running', 'finished', 'blocked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('pending', 'done', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."match_kind" AS ENUM('deterministic', 'model', 'review');--> statement-breakpoint
CREATE TYPE "public"."mooring_kind" AS ENUM('anchor', 'buoy', 'quay', 'marina', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."name_candidate_status" AS ENUM('collecting', 'geocoded', 'review', 'decided');--> statement-breakpoint
CREATE TYPE "public"."unit_status" AS ENUM('pending', 'submitted', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "ai_batch_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" "batch_item_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"output" jsonb,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_eur" numeric(12, 6),
	"distributed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_batch_id" text,
	"task" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"status" "batch_status" DEFAULT 'submitting' NOT NULL,
	"run_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"outcome_key" text NOT NULL,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"request_count" integer NOT NULL,
	"estimated_cost_eur" numeric(12, 6),
	"cost_eur" numeric(12, 6),
	"submitted_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_batches_provider_batch_id_unique" UNIQUE("provider_batch_id")
);
--> statement-breakpoint
CREATE TABLE "ambiguous_matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_version_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"type_hint" text,
	"candidates" jsonb NOT NULL,
	"status" "ambiguous_status" DEFAULT 'pending' NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"fact_schema_version" text NOT NULL,
	"purpose" "extraction_purpose" DEFAULT 'regular' NOT NULL,
	"comparison_id" uuid,
	"run_id" uuid NOT NULL,
	"status" "extraction_run_status" DEFAULT 'running' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quote_check" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "extraction_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"extraction_run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"part" integer NOT NULL,
	"level" text NOT NULL,
	"mention_ids" uuid[] DEFAULT '{}' NOT NULL,
	"chunk_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" "unit_status" DEFAULT 'pending' NOT NULL,
	"stats" jsonb,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_eur" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mentions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_version_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"type_hint" text,
	"observed_at" date NOT NULL,
	"confidence" real NOT NULL,
	"match_kind" "match_kind" NOT NULL,
	"match_score" real,
	"model" text,
	"prompt_version" integer,
	"extraction_status" "extraction_status" DEFAULT 'pending' NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mentions_confidence_range" CHECK ("mentions"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "name_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name_normalized" text NOT NULL,
	"display_name" text NOT NULL,
	"hint" text,
	"tile_id" text NOT NULL,
	"status" "name_candidate_status" DEFAULT 'collecting' NOT NULL,
	"documents" integer DEFAULT 0 NOT NULL,
	"sources" integer DEFAULT 0 NOT NULL,
	"geocode" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_passes" (
	"document_version_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"config_key" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_passes_document_version_id_stage_config_key_pk" PRIMARY KEY("document_version_id","stage","config_key")
);
--> statement-breakpoint
CREATE TABLE "route_stops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"route_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"name" text NOT NULL,
	"geo_object_id" uuid,
	"mention_id" uuid,
	"date" date,
	"mooring" "mooring_kind" DEFAULT 'unknown' NOT NULL,
	"quote" text NOT NULL,
	"quote_verified" boolean NOT NULL,
	"quote_chunk_id" uuid NOT NULL,
	"leg" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_stops_quote_verified" CHECK ("route_stops"."quote_verified" = true)
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_version_id" uuid NOT NULL,
	"extraction_run_id" uuid NOT NULL,
	"stops_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unmatched_names" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name_normalized" text NOT NULL,
	"display_name" text NOT NULL,
	"hint" text,
	"document_version_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"tile_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "quote_chunk_id" uuid;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "quote_start" integer;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "quote_end" integer;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "classified_doc_type" "doc_type";--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "classified_languages" text[];--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "classified_published_at" date;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "classified_observed_at" date;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "classified_observed_at_basis" "observed_at_basis";--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "observed_at_reason" text;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "area_hints" text[];--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "classified_model" text;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "classified_prompt_version" integer;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "classified_run_id" uuid;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "classified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_batch_items" ADD CONSTRAINT "ai_batch_items_batch_id_ai_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."ai_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_batches" ADD CONSTRAINT "ai_batches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambiguous_matches" ADD CONSTRAINT "ambiguous_matches_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambiguous_matches" ADD CONSTRAINT "ambiguous_matches_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambiguous_matches" ADD CONSTRAINT "ambiguous_matches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_units" ADD CONSTRAINT "extraction_units_extraction_run_id_extraction_runs_id_fk" FOREIGN KEY ("extraction_run_id") REFERENCES "public"."extraction_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_units" ADD CONSTRAINT "extraction_units_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_units" ADD CONSTRAINT "extraction_units_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "name_candidates" ADD CONSTRAINT "name_candidates_tile_id_tiles_id_fk" FOREIGN KEY ("tile_id") REFERENCES "public"."tiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_passes" ADD CONSTRAINT "pipeline_passes_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_passes" ADD CONSTRAINT "pipeline_passes_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_mention_id_mentions_id_fk" FOREIGN KEY ("mention_id") REFERENCES "public"."mentions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_quote_chunk_id_chunks_id_fk" FOREIGN KEY ("quote_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_extraction_run_id_extraction_runs_id_fk" FOREIGN KEY ("extraction_run_id") REFERENCES "public"."extraction_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_names" ADD CONSTRAINT "unmatched_names_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_names" ADD CONSTRAINT "unmatched_names_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_names" ADD CONSTRAINT "unmatched_names_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unmatched_names" ADD CONSTRAINT "unmatched_names_tile_id_tiles_id_fk" FOREIGN KEY ("tile_id") REFERENCES "public"."tiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_batch_items_batch_id_idx" ON "ai_batch_items" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_batches_open_outcome_unique" ON "ai_batches" USING btree ("run_id","stage","outcome_key") WHERE "ai_batches"."status" not in ('distributed', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "ambiguous_matches_chunk_span_unique" ON "ambiguous_matches" USING btree ("chunk_id","char_start","char_end");--> statement-breakpoint
CREATE UNIQUE INDEX "extraction_runs_run_task_model_unique" ON "extraction_runs" USING btree ("run_id","task","model");--> statement-breakpoint
CREATE UNIQUE INDEX "extraction_units_run_version_object_part_unique" ON "extraction_units" USING btree ("extraction_run_id","document_version_id","geo_object_id","part");--> statement-breakpoint
CREATE UNIQUE INDEX "mentions_chunk_geo_object_char_start_unique" ON "mentions" USING btree ("chunk_id","geo_object_id","char_start");--> statement-breakpoint
CREATE INDEX "mentions_geo_object_id_idx" ON "mentions" USING btree ("geo_object_id");--> statement-breakpoint
CREATE INDEX "mentions_document_version_id_idx" ON "mentions" USING btree ("document_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "name_candidates_name_tile_unique" ON "name_candidates" USING btree ("name_normalized","tile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "route_stops_route_ordinal_unique" ON "route_stops" USING btree ("route_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "routes_version_extraction_run_unique" ON "routes" USING btree ("document_version_id","extraction_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unmatched_names_name_chunk_unique" ON "unmatched_names" USING btree ("name_normalized","chunk_id");--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_mention_id_mentions_id_fk" FOREIGN KEY ("mention_id") REFERENCES "public"."mentions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_quote_chunk_id_chunks_id_fk" FOREIGN KEY ("quote_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_extraction_run_id_extraction_runs_id_fk" FOREIGN KEY ("extraction_run_id") REFERENCES "public"."extraction_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_classified_run_id_runs_id_fk" FOREIGN KEY ("classified_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_text_quote_verified" CHECK ("facts"."mention_id" is null or ("facts"."quote_verified" and "facts"."quote_chunk_id" is not null));