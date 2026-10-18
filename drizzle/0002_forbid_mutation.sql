CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
DECLARE
  allowed text[] := CASE
    WHEN TG_NARGS > 0 AND length(TG_ARGV[0]) > 0 THEN string_to_array(TG_ARGV[0], ',')
    ELSE ARRAY[]::text[]
  END;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - allowed) = (to_jsonb(NEW) - allowed) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER review_decisions_append_only
  BEFORE UPDATE OR DELETE ON review_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
