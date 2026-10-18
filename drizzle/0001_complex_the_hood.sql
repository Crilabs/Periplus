CREATE TYPE "public"."run_kind" AS ENUM('full', 'stage', 'revisit', 'event', 'reprocess', 'system');--> statement-breakpoint
CREATE TYPE "public"."run_scope_type" AS ENUM('tile', 'area', 'place', 'source', 'system');--> statement-breakpoint
CREATE TYPE "public"."run_stage_status" AS ENUM('pending', 'running', 'finished');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'finished', 'failed');--> statement-breakpoint
CREATE TYPE "public"."review_kind" AS ENUM('source_approval', 'place_candidate', 'conflict', 'failed_job', 'coast_tile_without_area', 'uncertain_change', 'comparison_deviation');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('open', 'decided', 'dismissed');--> statement-breakpoint
CREATE TABLE "api_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"rate_limit_per_min" integer DEFAULT 60 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_clients_name_unique" UNIQUE("name"),
	CONSTRAINT "api_clients_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"ip" text NOT NULL,
	"success" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "external_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"operation" text NOT NULL,
	"units" numeric NOT NULL,
	"unit" text NOT NULL,
	"cost_eur" numeric(12, 6) NOT NULL,
	"run_id" uuid,
	"tile_id" text,
	"stage" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_controls" (
	"queue" text PRIMARY KEY NOT NULL,
	"paused_until" timestamp with time zone,
	"reason" text,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_stages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"ordinal" integer NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"status" "run_stage_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_stages_run_id_stage_unique" UNIQUE("run_id","stage")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "run_kind" NOT NULL,
	"scope_type" "run_scope_type" NOT NULL,
	"scope_id" text NOT NULL,
	"stages" text[] DEFAULT '{}' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"triggered_by" text NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"decision" jsonb NOT NULL,
	"decided_by" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "review_kind" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "review_status" DEFAULT 'open' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_stages" ADD CONSTRAINT "run_stages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_task_id_review_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."review_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_attempts_email_at_idx" ON "login_attempts" USING btree ("email","at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_at_idx" ON "login_attempts" USING btree ("ip","at");--> statement-breakpoint
CREATE INDEX "external_calls_service_at_idx" ON "external_calls" USING btree ("service","at");