-- mentions are append-only except extraction_status; routes and route_stops are append-only.
CREATE TRIGGER mentions_append_only BEFORE UPDATE OR DELETE ON mentions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('extraction_status');
--> statement-breakpoint
CREATE TRIGGER routes_append_only BEFORE UPDATE OR DELETE ON routes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER route_stops_append_only BEFORE UPDATE OR DELETE ON route_stops
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
-- document_versions stays append-only; only the model classification columns may be written (spec 06, ruling M4-P11).
DROP TRIGGER document_versions_append_only ON document_versions;
--> statement-breakpoint
CREATE TRIGGER document_versions_append_only BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('classified_doc_type,classified_languages,classified_published_at,classified_observed_at,classified_observed_at_basis,observed_at_reason,area_hints,classified_model,classified_prompt_version,classified_run_id,classified_at');
--> statement-breakpoint
-- Working state with updated_at.
CREATE TRIGGER ambiguous_matches_set_updated_at BEFORE UPDATE ON ambiguous_matches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER name_candidates_set_updated_at BEFORE UPDATE ON name_candidates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER extraction_units_set_updated_at BEFORE UPDATE ON extraction_units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
