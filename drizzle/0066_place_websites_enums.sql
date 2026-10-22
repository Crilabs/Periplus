-- place_websites is append-only (the current website is the newest row); the enum values arrive with 0065.
CREATE TRIGGER place_websites_append_only BEFORE UPDATE OR DELETE ON place_websites
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER place_websites_no_truncate BEFORE TRUNCATE ON place_websites
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
