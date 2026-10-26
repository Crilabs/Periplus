CREATE TYPE "public"."research_hit_origin" AS ENUM('serp', 'place_website');--> statement-breakpoint
ALTER TABLE "research_hits" ALTER COLUMN "serp_query_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "research_hits" ALTER COLUMN "serp_result_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "research_hits" ADD COLUMN "origin" "research_hit_origin" DEFAULT 'serp' NOT NULL;--> statement-breakpoint
ALTER TABLE "research_hits" ADD CONSTRAINT "research_hits_serp_ids_when_serp" CHECK ("research_hits"."origin" <> 'serp' OR ("research_hits"."serp_query_id" IS NOT NULL AND "research_hits"."serp_result_id" IS NOT NULL));