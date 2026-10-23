CREATE TABLE "radius_package_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"radius_package_id" uuid NOT NULL,
	"api_client_id" uuid,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radius_package_requests_kind" CHECK ("radius_package_requests"."kind" IN ('package', 'file', 'changes'))
);
--> statement-breakpoint
CREATE TABLE "radius_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"home_marina_public_id" text NOT NULL,
	"days" integer NOT NULL,
	"radius_nm" double precision NOT NULL,
	"coverage" jsonb NOT NULL,
	"schema_version" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"storage_prefix" text NOT NULL,
	"file_hashes" jsonb NOT NULL,
	"object_counts" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "radius_packages_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "radius_package_requests" ADD CONSTRAINT "radius_package_requests_radius_package_id_radius_packages_id_fk" FOREIGN KEY ("radius_package_id") REFERENCES "public"."radius_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "radius_package_requests" ADD CONSTRAINT "radius_package_requests_api_client_id_api_clients_id_fk" FOREIGN KEY ("api_client_id") REFERENCES "public"."api_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "radius_package_requests_package_idx" ON "radius_package_requests" USING btree ("radius_package_id");--> statement-breakpoint
CREATE INDEX "radius_packages_marina_days_idx" ON "radius_packages" USING btree ("home_marina_public_id","days","created_at" DESC NULLS LAST);--> statement-breakpoint
-- radius_packages and radius_package_requests are append-only: a built package is a new row, a request a new row.
CREATE TRIGGER radius_packages_append_only BEFORE UPDATE OR DELETE ON radius_packages
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER radius_package_requests_append_only BEFORE UPDATE OR DELETE ON radius_package_requests
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
