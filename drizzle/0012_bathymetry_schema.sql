CREATE TABLE "bathymetry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dataset" text NOT NULL,
	"dataset_version" text NOT NULL,
	"resolution_m" real NOT NULL,
	"tile_id" text NOT NULL,
	"rast" "raster" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bathymetry_dataset_tile_id_idx" ON "bathymetry" USING btree ("dataset","tile_id");