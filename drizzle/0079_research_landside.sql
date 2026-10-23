CREATE TYPE "public"."research_unit_kind" AS ENUM('berth', 'landside');--> statement-breakpoint
ALTER TYPE "public"."research_purpose" ADD VALUE 'landside';--> statement-breakpoint
DROP INDEX "research_units_version_place_model_prompt_unique";--> statement-breakpoint
ALTER TABLE "research_units" ADD COLUMN "kind" "research_unit_kind" DEFAULT 'berth' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "research_units_version_place_model_prompt_kind_unique" ON "research_units" USING btree ("document_version_id","place_id","model","prompt_version","kind");