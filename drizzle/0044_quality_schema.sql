CREATE TYPE "public"."comparison_method" AS ENUM('manual', 'proposal_confirmed', 'proposal_auto', 'review');--> statement-breakpoint
CREATE TYPE "public"."comparison_result" AS ENUM('match', 'deviation', 'not_at_navily', 'deviation_confirmed_own', 'deviation_confirmed_navily', 'unclear');--> statement-breakpoint
CREATE TABLE "comparison_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"place_id" uuid NOT NULL,
	"attribute" text NOT NULL,
	"profile_version" integer,
	"evaluation_run_id" uuid,
	"value_hash" text NOT NULL,
	"result" "comparison_result" NOT NULL,
	"method" "comparison_method" NOT NULL,
	"checked_by" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comparison_results_value_hash_format" CHECK ("comparison_results"."value_hash" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "comparison_results_checked_by_length" CHECK (char_length("comparison_results"."checked_by") <= 120)
);
--> statement-breakpoint
CREATE TABLE "config_activations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"evaluation_run_id" uuid NOT NULL,
	"comparison" jsonb NOT NULL,
	"activated_by" text NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_activations_kind" CHECK ("config_activations"."kind" in ('consolidation_rules', 'extraction'))
);
--> statement-breakpoint
CREATE TABLE "quality_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"metric" text NOT NULL,
	"value" double precision,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_snapshots_scope_type" CHECK ("quality_snapshots"."scope_type" in ('area', 'tile'))
);
--> statement-breakpoint
ALTER TABLE "comparison_results" ADD CONSTRAINT "comparison_results_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_results" ADD CONSTRAINT "comparison_results_evaluation_run_id_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comparison_results" ADD CONSTRAINT "comparison_results_review_task_id_review_tasks_id_fk" FOREIGN KEY ("review_task_id") REFERENCES "public"."review_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_activations" ADD CONSTRAINT "config_activations_evaluation_run_id_runs_id_fk" FOREIGN KEY ("evaluation_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_snapshots" ADD CONSTRAINT "quality_snapshots_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comparison_results_place_attribute_hash_idx" ON "comparison_results" USING btree ("place_id","attribute","value_hash","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "quality_snapshots_run_scope_metric_unique" ON "quality_snapshots" USING btree ("run_id","scope_type","scope_id","metric");--> statement-breakpoint
CREATE INDEX "quality_snapshots_scope_metric_created_idx" ON "quality_snapshots" USING btree ("scope_type","scope_id","metric","created_at" DESC NULLS LAST);