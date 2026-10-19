-- computations and facts are append-only: a new value is a new row.
CREATE TRIGGER computations_append_only BEFORE UPDATE OR DELETE ON computations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER facts_append_only BEFORE UPDATE OR DELETE ON facts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
