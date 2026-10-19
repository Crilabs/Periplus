CREATE TABLE "model_comparison_ratings" (
	"comparison_id" uuid NOT NULL,
	"unit_key" text NOT NULL,
	"attribute" text NOT NULL,
	"verdict" "comparison_verdict" NOT NULL,
	"rated_by" text NOT NULL,
	"rated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_comparison_ratings_comparison_id_unit_key_attribute_pk" PRIMARY KEY("comparison_id","unit_key","attribute")
);
--> statement-breakpoint
CREATE TABLE "model_comparison_units" (
	"comparison_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"mention_ids" uuid[] NOT NULL,
	"source_id" uuid NOT NULL,
	"doc_type" "doc_type" NOT NULL,
	CONSTRAINT "model_comparison_units_comparison_id_document_version_id_geo_object_id_pk" PRIMARY KEY("comparison_id","document_version_id","geo_object_id")
);
--> statement-breakpoint
CREATE TABLE "model_comparisons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"models" text[] NOT NULL,
	"run_id" uuid,
	"shortfall" text[] DEFAULT '{}' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_comparisons_two_models" CHECK (cardinality("model_comparisons"."models") = 2)
);
--> statement-breakpoint
ALTER TABLE "model_comparison_ratings" ADD CONSTRAINT "model_comparison_ratings_comparison_id_model_comparisons_id_fk" FOREIGN KEY ("comparison_id") REFERENCES "public"."model_comparisons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_comparison_units" ADD CONSTRAINT "model_comparison_units_comparison_id_model_comparisons_id_fk" FOREIGN KEY ("comparison_id") REFERENCES "public"."model_comparisons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_comparison_units" ADD CONSTRAINT "model_comparison_units_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_comparison_units" ADD CONSTRAINT "model_comparison_units_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_comparison_units" ADD CONSTRAINT "model_comparison_units_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_comparisons" ADD CONSTRAINT "model_comparisons_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_comparison_id_model_comparisons_id_fk" FOREIGN KEY ("comparison_id") REFERENCES "public"."model_comparisons"("id") ON DELETE no action ON UPDATE no action;