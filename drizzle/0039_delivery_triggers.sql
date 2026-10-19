-- deliveries and delivered_objects are append-only: a build is a new row, a new contract version a new row.
CREATE TRIGGER deliveries_append_only BEFORE UPDATE OR DELETE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER delivered_objects_append_only BEFORE UPDATE OR DELETE ON delivered_objects
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
