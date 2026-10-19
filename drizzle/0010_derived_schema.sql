CREATE TYPE "public"."computation_kind" AS ENUM('shelter', 'fetch', 'depth', 'seabed', 'anchor_area', 'quietness', 'restriction');--> statement-breakpoint
CREATE TABLE "computations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"kind" "computation_kind" NOT NULL,
	"inputs" jsonb NOT NULL,
	"inputs_hash" text NOT NULL,
	"outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rules_version" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"attribute" text NOT NULL,
	"value" jsonb NOT NULL,
	"mention_id" uuid,
	"computation_id" uuid,
	"observation_id" uuid,
	"review_decision_id" uuid,
	"quote" text,
	"quote_verified" boolean DEFAULT false NOT NULL,
	"observed_at" date NOT NULL,
	"confidence" real NOT NULL,
	"extraction_run_id" uuid,
	"fact_schema_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facts_one_basis" CHECK (num_nonnulls("facts"."mention_id", "facts"."computation_id", "facts"."observation_id", "facts"."review_decision_id") = 1),
	CONSTRAINT "facts_quote_for_mention" CHECK ("facts"."mention_id" is null or "facts"."quote" is not null),
	CONSTRAINT "facts_confidence_range" CHECK ("facts"."confidence" between 0 and 1)
);
--> statement-breakpoint
ALTER TABLE "computations" ADD CONSTRAINT "computations_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computations" ADD CONSTRAINT "computations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_computation_id_computations_id_fk" FOREIGN KEY ("computation_id") REFERENCES "public"."computations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_review_decision_id_review_decisions_id_fk" FOREIGN KEY ("review_decision_id") REFERENCES "public"."review_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "computations_geo_object_kind_created_idx" ON "computations" USING btree ("geo_object_id","kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "facts_mention_attribute_run_unique" ON "facts" USING btree ("mention_id","attribute","extraction_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "facts_computation_attribute_unique" ON "facts" USING btree ("computation_id","attribute") WHERE "facts"."computation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "facts_review_decision_attribute_unique" ON "facts" USING btree ("review_decision_id","attribute") WHERE "facts"."review_decision_id" is not null;--> statement-breakpoint
CREATE INDEX "facts_geo_object_attribute_observed_idx" ON "facts" USING btree ("geo_object_id","attribute","observed_at");