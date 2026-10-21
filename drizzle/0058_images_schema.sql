CREATE TYPE "public"."image_light" AS ENUM('midday', 'evening');--> statement-breakpoint
CREATE TYPE "public"."imagery_source" AS ENUM('ktimatologio', 'sentinel2', 'copernicus_dem', 'pnoa', 'ign_fr', 'dgu_hr', 'vantor');--> statement-breakpoint
CREATE TYPE "public"."place_image_kind" AS ENUM('photo', 'ai_illustration');--> statement-breakpoint
ALTER TYPE "public"."review_kind" ADD VALUE 'place_image';--> statement-breakpoint
CREATE TABLE "imagery_tiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" "imagery_source" NOT NULL,
	"tile_key" text NOT NULL,
	"bbox" geometry(Polygon,4326) NOT NULL,
	"resolution_m" real NOT NULL,
	"acquired_at" date,
	"license" text NOT NULL,
	"attribution" text NOT NULL,
	"file_key" text NOT NULL,
	"bytes" integer NOT NULL,
	"watermarked" boolean DEFAULT false NOT NULL,
	"blank" boolean DEFAULT false NOT NULL,
	"cost_eur" numeric(12, 6) DEFAULT '0' NOT NULL,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "place_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"kind" "place_image_kind" NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"render_id" uuid,
	"light" "image_light",
	"model" text,
	"prompt_version" text,
	"water_iou" real,
	"file_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"alt" text NOT NULL,
	"generation_key" text NOT NULL,
	"attribution" text,
	"license" text,
	"observed_at" date,
	"review_decision_id" uuid,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "place_renders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"camera" jsonb NOT NULL,
	"zoom" text NOT NULL,
	"imagery_tile_ids" uuid[] NOT NULL,
	"dem_tile_ids" uuid[] NOT NULL,
	"photo_key" text NOT NULL,
	"mask_key" text NOT NULL,
	"depth_key" text,
	"renderer_version" text NOT NULL,
	"generation_key" text NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "place_images" ADD CONSTRAINT "place_images_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_images" ADD CONSTRAINT "place_images_render_id_place_renders_id_fk" FOREIGN KEY ("render_id") REFERENCES "public"."place_renders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_images" ADD CONSTRAINT "place_images_review_decision_id_review_decisions_id_fk" FOREIGN KEY ("review_decision_id") REFERENCES "public"."review_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_renders" ADD CONSTRAINT "place_renders_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_renders" ADD CONSTRAINT "place_renders_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imagery_tiles_source_key_valid_unique" ON "imagery_tiles" USING btree ("source","tile_key") WHERE "imagery_tiles"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "imagery_tiles_bbox_gist" ON "imagery_tiles" USING gist ("bbox");--> statement-breakpoint
CREATE UNIQUE INDEX "place_images_current_unique" ON "place_images" USING btree ("geo_object_id","kind") WHERE "place_images"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "place_renders_geo_object_id_idx" ON "place_renders" USING btree ("geo_object_id");