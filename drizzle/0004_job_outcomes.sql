CREATE TABLE "job_outcomes" (
	"run_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"key" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_outcomes_run_id_stage_key_pk" PRIMARY KEY("run_id","stage","key"),
	CONSTRAINT "job_outcomes_outcome_check" CHECK ("job_outcomes"."outcome" in ('done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "job_outcomes" ADD CONSTRAINT "job_outcomes_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;