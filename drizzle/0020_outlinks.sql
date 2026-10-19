CREATE TABLE "outlinks" (
	"from_source_id" uuid NOT NULL,
	"to_domain" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"run_id" uuid NOT NULL,
	CONSTRAINT "outlinks_from_source_id_to_domain_run_id_pk" PRIMARY KEY("from_source_id","to_domain","run_id")
);
--> statement-breakpoint
ALTER TABLE "outlinks" ADD CONSTRAINT "outlinks_from_source_id_sources_id_fk" FOREIGN KEY ("from_source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlinks" ADD CONSTRAINT "outlinks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outlinks_to_domain_idx" ON "outlinks" USING btree ("to_domain");