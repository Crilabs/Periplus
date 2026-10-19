CREATE TYPE "public"."change_rate" AS ENUM('high', 'normal', 'static');--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('pilot_guide', 'trip_report', 'forum', 'marina', 'authority', 'dataset', 'travel_guide', 'other');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('active', 'gone');--> statement-breakpoint
CREATE TYPE "public"."frontier_status" AS ENUM('queued', 'fetched', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."observed_at_basis" AS ENUM('explicit', 'published', 'fetched');--> statement-breakpoint
CREATE TYPE "public"."source_format" AS ENUM('html', 'pdf', 'table', 'geodata');--> statement-breakpoint
CREATE TYPE "public"."source_origin" AS ENUM('serp', 'linkgraph', 'whitelist', 'manual');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('proposed', 'approved', 'rejected', 'paused');--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_version_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"text_normalized" text NOT NULL,
	"text_hash" text NOT NULL,
	"heading" text,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"word_count" integer NOT NULL,
	"embedding" vector(1024),
	"embedding_model" text,
	"carried_from_chunk_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawl_frontier" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"url" text NOT NULL,
	"url_normalized" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"status" "frontier_status" DEFAULT 'queued' NOT NULL,
	"reason" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"raw_hash" text NOT NULL,
	"raw_key" text NOT NULL,
	"md_key" text NOT NULL,
	"diff_key" text,
	"content_type" text NOT NULL,
	"final_url" text NOT NULL,
	"language" text,
	"published_at" date,
	"observed_at" date NOT NULL,
	"observed_at_basis" "observed_at_basis" NOT NULL,
	"doc_type" "doc_type" NOT NULL,
	"converter" text NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"char_count" integer NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"url" text NOT NULL,
	"url_normalized" text NOT NULL,
	"doc_type" "doc_type" NOT NULL,
	"status" "document_status" DEFAULT 'active' NOT NULL,
	"consecutive_gone" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"etag" text,
	"last_modified" text,
	"current_version_id" uuid,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"name" text NOT NULL,
	"type" "doc_type" NOT NULL,
	"format" "source_format" DEFAULT 'html' NOT NULL,
	"languages" text[] DEFAULT '{}' NOT NULL,
	"weight" real NOT NULL,
	"status" "source_status" DEFAULT 'proposed' NOT NULL,
	"status_reason" text,
	"crawl_rules" jsonb NOT NULL,
	"change_rate" "change_rate" DEFAULT 'normal' NOT NULL,
	"origin" "source_origin" NOT NULL,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_weight_range" CHECK ("sources"."weight" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "text_shingles" (
	"shingle_hash" bigint NOT NULL,
	"chunk_id" uuid NOT NULL,
	CONSTRAINT "text_shingles_shingle_hash_chunk_id_pk" PRIMARY KEY("shingle_hash","chunk_id")
);
--> statement-breakpoint
ALTER TABLE "external_calls" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_carried_from_chunk_id_chunks_id_fk" FOREIGN KEY ("carried_from_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_frontier" ADD CONSTRAINT "crawl_frontier_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_frontier" ADD CONSTRAINT "crawl_frontier_last_run_id_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_id_document_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_shingles" ADD CONSTRAINT "text_shingles_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_document_version_id_ordinal_unique" ON "chunks" USING btree ("document_version_id","ordinal");--> statement-breakpoint
CREATE INDEX "chunks_text_hash_idx" ON "chunks" USING btree ("text_hash");--> statement-breakpoint
CREATE INDEX "chunks_text_normalized_trgm" ON "chunks" USING gin ("text_normalized" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "crawl_frontier_source_id_url_normalized_unique" ON "crawl_frontier" USING btree ("source_id","url_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_document_id_content_hash_unique" ON "document_versions" USING btree ("document_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_url_normalized_unique" ON "documents" USING btree ("url_normalized");--> statement-breakpoint
CREATE INDEX "documents_source_id_idx" ON "documents" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_domain_valid_unique" ON "sources" USING btree ("domain") WHERE "sources"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "text_shingles_chunk_id_idx" ON "text_shingles" USING btree ("chunk_id");--> statement-breakpoint
ALTER TABLE "restricted_areas" ADD CONSTRAINT "restricted_areas_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_calls_source_id_at_idx" ON "external_calls" USING btree ("source_id","at");