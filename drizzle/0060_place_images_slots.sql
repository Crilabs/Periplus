DROP INDEX "place_images_current_unique";--> statement-breakpoint
ALTER TABLE "place_images" ADD COLUMN "slot" text DEFAULT 'title' NOT NULL;--> statement-breakpoint
ALTER TABLE "place_images" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "place_images" ADD COLUMN "camera_position" geometry(Point,4326);--> statement-breakpoint
ALTER TABLE "place_images" ADD COLUMN "camera_height_m" real;--> statement-breakpoint
ALTER TABLE "place_images" ADD COLUMN "view_bearing_deg" real;--> statement-breakpoint
ALTER TABLE "place_images" ADD COLUMN "camera_tilt_deg" real;--> statement-breakpoint
ALTER TABLE "place_images" ADD COLUMN "camera_fov_deg" real;--> statement-breakpoint
CREATE UNIQUE INDEX "place_images_current_unique" ON "place_images" USING btree ("geo_object_id","slot") WHERE "place_images"."valid_to" is null;--> statement-breakpoint
ALTER TABLE "place_images" ADD CONSTRAINT "place_images_ai_camera" CHECK ("place_images"."kind" <> 'ai_illustration' or ("place_images"."camera_position" is not null and "place_images"."camera_height_m" is not null and "place_images"."view_bearing_deg" is not null and "place_images"."camera_tilt_deg" is not null and "place_images"."camera_fov_deg" is not null));--> statement-breakpoint
ALTER TABLE "place_images" ADD CONSTRAINT "place_images_bearing_range" CHECK ("place_images"."view_bearing_deg" >= 0 and "place_images"."view_bearing_deg" < 360);