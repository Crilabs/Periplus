CREATE TYPE "public"."research_fetch_outcome" AS ENUM('stored', 'unchanged', 'skipped', 'gone', 'failed');--> statement-breakpoint
CREATE TABLE "research_fetches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"url_normalized" text NOT NULL,
	"run_id" uuid NOT NULL,
	"outcome" "research_fetch_outcome" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_fetches" ADD CONSTRAINT "research_fetches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_fetches_url_normalized_created_at_idx" ON "research_fetches" USING btree ("url_normalized","created_at");--> statement-breakpoint
CREATE INDEX "research_fetches_run_id_idx" ON "research_fetches" USING btree ("run_id");