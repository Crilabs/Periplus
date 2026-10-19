CREATE TYPE "public"."serp_level" AS ENUM('area', 'tile');--> statement-breakpoint
CREATE TABLE "serp_queries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"keyword" text NOT NULL,
	"language_code" text NOT NULL,
	"location_code" integer NOT NULL,
	"depth" integer NOT NULL,
	"level" "serp_level" NOT NULL,
	"scope_id" text NOT NULL,
	"raw_key" text NOT NULL,
	"run_id" uuid,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "serp_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"serp_query_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"url" text NOT NULL,
	"url_normalized" text NOT NULL,
	"domain" text NOT NULL,
	"title" text NOT NULL,
	"snippet" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "serp_queries" ADD CONSTRAINT "serp_queries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_results" ADD CONSTRAINT "serp_results_serp_query_id_serp_queries_id_fk" FOREIGN KEY ("serp_query_id") REFERENCES "public"."serp_queries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "serp_queries_keyword_language_location_fetched_idx" ON "serp_queries" USING btree ("keyword","language_code","location_code","fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "serp_results_domain_idx" ON "serp_results" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "serp_results_serp_query_id_idx" ON "serp_results" USING btree ("serp_query_id");