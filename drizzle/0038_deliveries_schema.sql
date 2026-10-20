CREATE TYPE "public"."delivered_object_type" AS ENUM('spot', 'highlight', 'region');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('valid', 'rejected', 'unchanged');--> statement-breakpoint
CREATE TABLE "delivered_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"area_id" uuid NOT NULL,
	"object_type" "delivered_object_type" NOT NULL,
	"public_id" text NOT NULL,
	"geo_object_id" uuid,
	"profile_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"valid_from" date NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"first_delivery_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivered_objects_profile_version_positive" CHECK ("delivered_objects"."profile_version" >= 1),
	CONSTRAINT "delivered_objects_removed_hash" CHECK ("delivered_objects"."removed" = ("delivered_objects"."content_hash" = 'removed'))
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"area_id" uuid NOT NULL,
	"data_version" integer,
	"schema_version" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"status" "delivery_status" NOT NULL,
	"storage_prefix" text,
	"file_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"object_counts" jsonb NOT NULL,
	"validation_report" jsonb NOT NULL,
	"previous_delivery_id" uuid,
	"change_xmin" "xid8" NOT NULL,
	"run_id" uuid,
	"triggered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_data_version_iff_valid" CHECK (("deliveries"."status" = 'valid') = ("deliveries"."data_version" IS NOT NULL)),
	CONSTRAINT "deliveries_data_version_positive" CHECK ("deliveries"."data_version" >= 1),
	CONSTRAINT "deliveries_storage_prefix_iff_stored" CHECK (("deliveries"."status" = 'unchanged') = ("deliveries"."storage_prefix" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "delivered_objects" ADD CONSTRAINT "delivered_objects_area_id_geo_objects_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivered_objects" ADD CONSTRAINT "delivered_objects_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivered_objects" ADD CONSTRAINT "delivered_objects_first_delivery_id_deliveries_id_fk" FOREIGN KEY ("first_delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_area_id_geo_objects_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_previous_delivery_id_deliveries_id_fk" FOREIGN KEY ("previous_delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivered_objects_public_version_unique" ON "delivered_objects" USING btree ("public_id","profile_version") WHERE "delivered_objects"."object_type" IN ('spot', 'highlight');--> statement-breakpoint
CREATE UNIQUE INDEX "delivered_objects_area_region_version_unique" ON "delivered_objects" USING btree ("area_id","public_id","profile_version") WHERE "delivered_objects"."object_type" = 'region';--> statement-breakpoint
CREATE INDEX "delivered_objects_public_valid_from_idx" ON "delivered_objects" USING btree ("public_id","valid_from" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_area_data_version_unique" ON "deliveries" USING btree ("area_id","data_version") WHERE "deliveries"."data_version" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "deliveries_area_created_idx" ON "deliveries" USING btree ("area_id","created_at" DESC NULLS LAST);