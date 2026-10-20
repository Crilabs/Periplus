ALTER TABLE "seabed_polygons" RENAME COLUMN "area_key" TO "subdivision_key";--> statement-breakpoint
DROP INDEX "seabed_polygons_area_key_idx";--> statement-breakpoint
CREATE INDEX "seabed_polygons_subdivision_key_idx" ON "seabed_polygons" USING btree ("subdivision_key");