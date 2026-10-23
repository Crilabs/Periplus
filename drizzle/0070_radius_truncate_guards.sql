-- radius_packages and radius_package_requests are append-only (0069): they refuse TRUNCATE as they refuse UPDATE and
-- DELETE, like every other append-only table (0049).
CREATE TRIGGER radius_packages_no_truncate BEFORE TRUNCATE ON radius_packages
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER radius_package_requests_no_truncate BEFORE TRUNCATE ON radius_package_requests
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
