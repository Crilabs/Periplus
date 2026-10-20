-- comparison_results, quality_snapshots and config_activations are append-only: a new comparison outcome, measurement
-- or activation is a new row.
CREATE TRIGGER comparison_results_append_only BEFORE UPDATE OR DELETE ON comparison_results
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER quality_snapshots_append_only BEFORE UPDATE OR DELETE ON quality_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER config_activations_append_only BEFORE UPDATE OR DELETE ON config_activations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
-- COMPARISON_ATTRIBUTES (lib/db/schema/quality.ts); no other attribute, so no column can carry e.g. a rating.
ALTER TABLE comparison_results ADD CONSTRAINT comparison_results_attribute_check CHECK (attribute in (
  'existence', 'position',
  'shelter.N', 'shelter.NE', 'shelter.E', 'shelter.SE', 'shelter.S', 'shelter.SW', 'shelter.W', 'shelter.NW',
  'depth', 'seabed', 'mooring.buoys', 'services.water', 'highlight.supply', 'highlight.food'
));
--> statement-breakpoint
-- METRIC_KEYS (lib/db/schema/quality.ts).
ALTER TABLE quality_snapshots ADD CONSTRAINT quality_snapshots_metric_check CHECK (metric in (
  'coverage', 'coverage_navily', 'multi_source', 'fact_precision', 'quote_fidelity', 'shelter_confidence',
  'route_reconstruction', 'cost_per_place', 'review_minutes', 'review_minutes_per_100', 'highlight_share',
  'recent_observation_share', 'places_per_tile'
));
