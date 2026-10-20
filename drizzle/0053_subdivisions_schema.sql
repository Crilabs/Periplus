CREATE TYPE "public"."subdivision_status" AS ENUM('active', 'excluded');--> statement-breakpoint
ALTER TYPE "public"."run_scope_type" ADD VALUE 'subdivision' BEFORE 'place';--> statement-breakpoint
ALTER TYPE "public"."geo_object_type" ADD VALUE 'country';--> statement-breakpoint
ALTER TYPE "public"."geo_object_type" ADD VALUE 'admin_region';--> statement-breakpoint
ALTER TYPE "public"."geo_origin" ADD VALUE 'marine_regions';--> statement-breakpoint
CREATE TABLE "subdivisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"key" text NOT NULL,
	"country" text NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"geom" geometry(MultiPolygon,4326) NOT NULL,
	"land_geom" geometry(MultiPolygon,4326),
	"status" "subdivision_status" DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"queued_at" timestamp with time zone,
	"built_at" timestamp with time zone,
	"valid_from" date DEFAULT current_date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subdivisions_public_id_prefix" CHECK ("subdivisions"."public_id" like 'sd\_%')
);
--> statement-breakpoint
ALTER TABLE "quality_snapshots" DROP CONSTRAINT "quality_snapshots_scope_type";--> statement-breakpoint
ALTER TABLE "comparison_set" ALTER COLUMN "area_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comparison_set" ADD COLUMN "subdivision_id" uuid;--> statement-breakpoint
ALTER TABLE "geo_objects" ADD COLUMN "subdivision_id" uuid;--> statement-breakpoint
ALTER TABLE "geo_objects" ADD COLUMN "sea_id" uuid;--> statement-breakpoint
ALTER TABLE "geo_objects" ADD COLUMN "admin_level" integer;--> statement-breakpoint
ALTER TABLE "tiles" ADD COLUMN "subdivision_id" uuid;--> statement-breakpoint
ALTER TABLE "subdivisions" ADD CONSTRAINT "subdivisions_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subdivisions_public_id_unique" ON "subdivisions" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subdivisions_key_valid_unique" ON "subdivisions" USING btree ("key") WHERE "subdivisions"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "subdivisions_geom_gist" ON "subdivisions" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "subdivisions_land_geom_gist" ON "subdivisions" USING gist ("land_geom");--> statement-breakpoint
ALTER TABLE "comparison_set" ADD CONSTRAINT "comparison_set_subdivision_id_subdivisions_id_fk" FOREIGN KEY ("subdivision_id") REFERENCES "public"."subdivisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_objects" ADD CONSTRAINT "geo_objects_subdivision_id_subdivisions_id_fk" FOREIGN KEY ("subdivision_id") REFERENCES "public"."subdivisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_objects" ADD CONSTRAINT "geo_objects_sea_id_geo_objects_id_fk" FOREIGN KEY ("sea_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiles" ADD CONSTRAINT "tiles_subdivision_id_subdivisions_id_fk" FOREIGN KEY ("subdivision_id") REFERENCES "public"."subdivisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "geo_objects_subdivision_id_idx" ON "geo_objects" USING btree ("subdivision_id") WHERE "geo_objects"."subdivision_id" is not null;--> statement-breakpoint
CREATE INDEX "geo_objects_sea_id_idx" ON "geo_objects" USING btree ("sea_id") WHERE "geo_objects"."sea_id" is not null;--> statement-breakpoint
CREATE INDEX "tiles_subdivision_id_idx" ON "tiles" USING btree ("subdivision_id");--> statement-breakpoint
ALTER TABLE "quality_snapshots" ADD CONSTRAINT "quality_snapshots_scope_type" CHECK ("quality_snapshots"."scope_type" in ('area', 'subdivision', 'tile'));