-- Append-only and stable tables refuse TRUNCATE as they refuse UPDATE and DELETE (gesamt-review DAT-6): one statement-level
-- trigger per table guarded per row in 0002, 0006, 0011, 0017, 0024, 0032, 0039 and 0045. A TRUNCATE ... CASCADE
-- stops at the first guarded table.
CREATE TRIGGER change_events_no_truncate BEFORE TRUNCATE ON change_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER chunks_no_truncate BEFORE TRUNCATE ON chunks
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER comparison_results_no_truncate BEFORE TRUNCATE ON comparison_results
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER computations_no_truncate BEFORE TRUNCATE ON computations
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER config_activations_no_truncate BEFORE TRUNCATE ON config_activations
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER delivered_objects_no_truncate BEFORE TRUNCATE ON delivered_objects
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER deliveries_no_truncate BEFORE TRUNCATE ON deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER document_versions_no_truncate BEFORE TRUNCATE ON document_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER documents_history_no_truncate BEFORE TRUNCATE ON documents_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER facts_no_truncate BEFORE TRUNCATE ON facts
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER geo_names_history_no_truncate BEFORE TRUNCATE ON geo_names_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER geo_objects_history_no_truncate BEFORE TRUNCATE ON geo_objects_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER mentions_no_truncate BEFORE TRUNCATE ON mentions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER places_history_no_truncate BEFORE TRUNCATE ON places_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER profile_summaries_no_truncate BEFORE TRUNCATE ON profile_summaries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER profiles_no_truncate BEFORE TRUNCATE ON profiles
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER quality_snapshots_no_truncate BEFORE TRUNCATE ON quality_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER restricted_areas_history_no_truncate BEFORE TRUNCATE ON restricted_areas_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER review_decisions_no_truncate BEFORE TRUNCATE ON review_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER route_stops_no_truncate BEFORE TRUNCATE ON route_stops
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER routes_no_truncate BEFORE TRUNCATE ON routes
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER sources_history_no_truncate BEFORE TRUNCATE ON sources_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER tiles_history_no_truncate BEFORE TRUNCATE ON tiles_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER documents_no_truncate BEFORE TRUNCATE ON documents
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER geo_names_no_truncate BEFORE TRUNCATE ON geo_names
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER geo_objects_no_truncate BEFORE TRUNCATE ON geo_objects
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER places_no_truncate BEFORE TRUNCATE ON places
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER restricted_areas_no_truncate BEFORE TRUNCATE ON restricted_areas
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER sources_no_truncate BEFORE TRUNCATE ON sources
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER tiles_no_truncate BEFORE TRUNCATE ON tiles
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_delete();
