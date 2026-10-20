ALTER TABLE "delivered_objects" ALTER COLUMN "area_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ALTER COLUMN "area_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "delivered_objects" ADD COLUMN "subdivision_id" uuid;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "subdivision_id" uuid;--> statement-breakpoint
ALTER TABLE "delivered_objects" ADD CONSTRAINT "delivered_objects_subdivision_id_subdivisions_id_fk" FOREIGN KEY ("subdivision_id") REFERENCES "public"."subdivisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_subdivision_id_subdivisions_id_fk" FOREIGN KEY ("subdivision_id") REFERENCES "public"."subdivisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivered_objects_subdivision_region_version_unique" ON "delivered_objects" USING btree ("subdivision_id","public_id","profile_version") WHERE "delivered_objects"."object_type" = 'region' AND "delivered_objects"."subdivision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_subdivision_data_version_unique" ON "deliveries" USING btree ("subdivision_id","data_version") WHERE "deliveries"."data_version" IS NOT NULL AND "deliveries"."subdivision_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "deliveries_subdivision_created_idx" ON "deliveries" USING btree ("subdivision_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "delivered_objects" ADD CONSTRAINT "delivered_objects_area_or_subdivision" CHECK ("delivered_objects"."area_id" IS NOT NULL OR "delivered_objects"."subdivision_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_area_or_subdivision" CHECK ("deliveries"."area_id" IS NOT NULL OR "deliveries"."subdivision_id" IS NOT NULL);