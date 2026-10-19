CREATE TYPE "public"."extraction_run_block_reason" AS ENUM('quote_fidelity', 'late_results', 'run_ended');--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD COLUMN "blocked_reason" "extraction_run_block_reason";--> statement-breakpoint
UPDATE "extraction_runs" SET "blocked_reason" = 'quote_fidelity' WHERE "status" = 'blocked';--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_blocked_reason" CHECK (("extraction_runs"."status" = 'blocked') = ("extraction_runs"."blocked_reason" is not null));