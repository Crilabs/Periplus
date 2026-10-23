CREATE TYPE "public"."berth_signal_kind" AS ENUM('anchored', 'moored_buoy', 'berthed', 'listed_as_berth', 'prohibited', 'buoys_private', 'no_space', 'unsafe', 'closed');--> statement-breakpoint
CREATE TYPE "public"."research_unit_status" AS ENUM('pending', 'done', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."tone" AS ENUM('positive', 'negative', 'neutral');--> statement-breakpoint
CREATE TABLE "berth_facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"unit_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"attribute" text,
	"value" jsonb,
	"statement" text,
	"subject_name" text,
	"subject_category" text,
	"quote" text NOT NULL,
	"quote_start" integer NOT NULL,
	"quote_end" integer NOT NULL,
	"observed_at" date NOT NULL,
	"observed_at_basis" "observed_at_basis" NOT NULL,
	"tone" "tone",
	"safety" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "berth_facts_shape_check" CHECK (("berth_facts"."attribute" is not null and "berth_facts"."value" is not null and "berth_facts"."statement" is null) or ("berth_facts"."attribute" is null and "berth_facts"."value" is null and "berth_facts"."statement" is not null))
);
--> statement-breakpoint
CREATE TABLE "berth_signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"unit_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"kind" "berth_signal_kind" NOT NULL,
	"first_hand" boolean NOT NULL,
	"confidence" real NOT NULL,
	"quote" text NOT NULL,
	"quote_start" integer NOT NULL,
	"quote_end" integer NOT NULL,
	"observed_at" date NOT NULL,
	"observed_at_basis" "observed_at_basis" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "berth_signals_confidence_check" CHECK ("berth_signals"."confidence" >= 0 and "berth_signals"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "landing_hints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"unit_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quote" text NOT NULL,
	"quote_start" integer NOT NULL,
	"quote_end" integer NOT NULL,
	"observed_at" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_route_stops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_version_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"mooring_kind" text,
	"quote" text NOT NULL,
	"observed_at" date NOT NULL,
	"place_id" uuid,
	"match" text,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_route_stops_match_check" CHECK ("research_route_stops"."match" is null or "research_route_stops"."match" in ('name', 'corridor'))
);
--> statement-breakpoint
CREATE TABLE "research_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_version_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"status" "research_unit_status" NOT NULL,
	"reason" text,
	"dropped" jsonb NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "berth_facts" ADD CONSTRAINT "berth_facts_unit_id_research_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."research_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "berth_facts" ADD CONSTRAINT "berth_facts_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "berth_facts" ADD CONSTRAINT "berth_facts_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "berth_signals" ADD CONSTRAINT "berth_signals_unit_id_research_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."research_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "berth_signals" ADD CONSTRAINT "berth_signals_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "berth_signals" ADD CONSTRAINT "berth_signals_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_hints" ADD CONSTRAINT "landing_hints_unit_id_research_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."research_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_hints" ADD CONSTRAINT "landing_hints_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_hints" ADD CONSTRAINT "landing_hints_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_route_stops" ADD CONSTRAINT "research_route_stops_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_route_stops" ADD CONSTRAINT "research_route_stops_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_units" ADD CONSTRAINT "research_units_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_units" ADD CONSTRAINT "research_units_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_units" ADD CONSTRAINT "research_units_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "berth_facts_place_id_idx" ON "berth_facts" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "berth_facts_unit_id_idx" ON "berth_facts" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "berth_signals_place_id_idx" ON "berth_signals" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "berth_signals_unit_id_idx" ON "berth_signals" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "landing_hints_place_id_idx" ON "landing_hints" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "landing_hints_unit_id_idx" ON "landing_hints" USING btree ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_route_stops_version_seq_model_prompt_unique" ON "research_route_stops" USING btree ("document_version_id","seq","model","prompt_version");--> statement-breakpoint
CREATE INDEX "research_route_stops_place_id_idx" ON "research_route_stops" USING btree ("place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_units_version_place_model_prompt_unique" ON "research_units" USING btree ("document_version_id","place_id","model","prompt_version");--> statement-breakpoint
CREATE INDEX "research_units_place_id_idx" ON "research_units" USING btree ("place_id");