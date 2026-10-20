CREATE TYPE "public"."area_member_role" AS ENUM('member', 'boundary');--> statement-breakpoint
ALTER TYPE "public"."geo_origin" ADD VALUE 'import';--> statement-breakpoint
ALTER TYPE "public"."name_origin" ADD VALUE 'import';--> statement-breakpoint
CREATE TABLE "area_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"area_id" uuid NOT NULL,
	"url" text NOT NULL,
	"publisher" text DEFAULT '' NOT NULL,
	"language" text NOT NULL,
	"quote" text NOT NULL,
	"file_generated_at" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "area_evidence_quote_not_empty" CHECK (length("area_evidence"."quote") > 0)
);
--> statement-breakpoint
CREATE TABLE "area_members" (
	"area_id" uuid NOT NULL,
	"geo_object_id" uuid NOT NULL,
	"role" "area_member_role" NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "area_members_area_id_geo_object_id_role_pk" PRIMARY KEY("area_id","geo_object_id","role")
);
--> statement-breakpoint
ALTER TABLE "area_evidence" ADD CONSTRAINT "area_evidence_area_id_geo_objects_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_members" ADD CONSTRAINT "area_members_area_id_geo_objects_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_members" ADD CONSTRAINT "area_members_geo_object_id_geo_objects_id_fk" FOREIGN KEY ("geo_object_id") REFERENCES "public"."geo_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "area_evidence_unique" ON "area_evidence" USING btree ("area_id","url","quote");--> statement-breakpoint
CREATE INDEX "area_evidence_area_id_idx" ON "area_evidence" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "area_members_geo_object_id_idx" ON "area_members" USING btree ("geo_object_id");