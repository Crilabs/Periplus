ALTER TYPE "public"."poi_category" ADD VALUE 'bakery';--> statement-breakpoint
ALTER TYPE "public"."poi_category" ADD VALUE 'transport';--> statement-breakpoint
ALTER TYPE "public"."poi_category" ADD VALUE 'landing';--> statement-breakpoint
CREATE TABLE "berth_states" (
	"place_id" uuid PRIMARY KEY NOT NULL,
	"core" jsonb NOT NULL,
	"gaps" text[] NOT NULL,
	"facts" jsonb NOT NULL,
	"landing" jsonb NOT NULL,
	"nearby" jsonb NOT NULL,
	"run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "berth_states" ADD CONSTRAINT "berth_states_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "berth_states" ADD CONSTRAINT "berth_states_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "berth_states_run_id_idx" ON "berth_states" USING btree ("run_id");