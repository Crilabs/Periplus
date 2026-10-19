CREATE TYPE "public"."converter_name" AS ENUM('jina', 'firecrawl', 'local');--> statement-breakpoint
CREATE TABLE "converter_outputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sample_id" uuid NOT NULL,
	"converter" "converter_name" NOT NULL,
	"md_key" text,
	"chars" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"cost_eur" numeric(12, 6) DEFAULT '0' NOT NULL,
	"error" text,
	"rating" jsonb,
	"rated_by" text,
	"rated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "converter_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"url" text NOT NULL,
	"url_normalized" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "converter_samples_url_normalized_unique" UNIQUE("url_normalized")
);
--> statement-breakpoint
ALTER TABLE "converter_outputs" ADD CONSTRAINT "converter_outputs_sample_id_converter_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."converter_samples"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "converter_samples" ADD CONSTRAINT "converter_samples_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "converter_outputs_sample_id_converter_unique" ON "converter_outputs" USING btree ("sample_id","converter");