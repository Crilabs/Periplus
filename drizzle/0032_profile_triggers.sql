-- profiles, change_events and profile_summaries are append-only: a new profile is a new version, a new summary a new row.
CREATE TRIGGER profiles_append_only BEFORE UPDATE OR DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER change_events_append_only BEFORE UPDATE OR DELETE ON change_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER profile_summaries_append_only BEFORE UPDATE OR DELETE ON profile_summaries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
