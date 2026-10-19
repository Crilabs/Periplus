CREATE TYPE "public"."change_severity" AS ENUM('info', 'notable', 'safety');--> statement-breakpoint
CREATE TYPE "public"."change_type" AS ENUM('new_attribute', 'changed', 'uncertain', 'expired', 'place_new', 'place_abandoned', 'geo_changed');--> statement-breakpoint
CREATE TYPE "public"."summary_status" AS ENUM('ok', 'rejected', 'empty');--> statement-breakpoint
CREATE TABLE "change_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"profile_version" integer,
	"type" "change_type" NOT NULL,
	"attribute" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"severity" "change_severity" NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_events_seq_unique" UNIQUE("seq")
);
--> statement-breakpoint
CREATE TABLE "evaluation_profiles" (
	"run_id" uuid NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"rules_version" text NOT NULL,
	"fact_schema_version" text NOT NULL,
	"attributes" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_profiles_pk" PRIMARY KEY("run_id","geo_object_id")
);
--> statement-breakpoint
CREATE TABLE "place_discovery_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "profile_summaries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"text" text,
	"status" "summary_status" NOT NULL,
	"attempts" integer NOT NULL,
	"model" text,
	"prompt_version" integer,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"valid_from" date NOT NULL,
	"attributes" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources_count" integer NOT NULL,
	"documents_count" integer NOT NULL,
	"confidence" real,
	"content_hash" text NOT NULL,
	"fact_schema_version" text NOT NULL,
	"rules_version" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_version_positive" CHECK ("profiles"."version" >= 1),
	CONSTRAINT "profiles_confidence_range" CHECK ("profiles"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "wikidata_sitelinks" (
	"wikidata_id" text PRIMARY KEY NOT NULL,
	"sitelinks" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_profiles" ADD CONSTRAINT "evaluation_profiles_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_profiles" ADD CONSTRAINT "evaluation_profiles_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_discovery_requests" ADD CONSTRAINT "place_discovery_requests_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_discovery_requests" ADD CONSTRAINT "place_discovery_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_summaries" ADD CONSTRAINT "profile_summaries_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_summaries" ADD CONSTRAINT "profile_summaries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_events_geo_object_seq_idx" ON "change_events" USING btree ("geo_object_id","seq");--> statement-breakpoint
CREATE INDEX "place_discovery_requests_geo_object_idx" ON "place_discovery_requests" USING btree ("geo_object_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "profile_summaries_ok_unique" ON "profile_summaries" USING btree ("geo_object_id","profile_version","prompt_version") WHERE "profile_summaries"."status" = 'ok';--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_geo_object_version_unique" ON "profiles" USING btree ("geo_object_id","version");--> statement-breakpoint
CREATE INDEX "profiles_geo_object_valid_from_idx" ON "profiles" USING btree ("geo_object_id","valid_from" DESC NULLS LAST,"version" DESC NULLS LAST);