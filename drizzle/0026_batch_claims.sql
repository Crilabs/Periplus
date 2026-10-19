ALTER TYPE "public"."batch_status" ADD VALUE 'sending' BEFORE 'submitted';--> statement-breakpoint
ALTER TABLE "ai_batch_items" ADD COLUMN "distribution_error" text;--> statement-breakpoint
ALTER TABLE "ai_batches" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_batches" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_batches" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_batches" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_batches" ADD CONSTRAINT "ai_batches_sending_claim" CHECK ("ai_batches"."status"::text <> 'sending' or ("ai_batches"."claim_id" is not null and "ai_batches"."claimed_at" is not null and "ai_batches"."lease_until" is not null));