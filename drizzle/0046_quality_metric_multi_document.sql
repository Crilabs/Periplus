-- METRIC_KEYS gains multi_document (datendienst Mehrbefund „mindestens 2 Dokumenten“, rulings M7-P12, M7-P30).
ALTER TABLE quality_snapshots DROP CONSTRAINT quality_snapshots_metric_check;
--> statement-breakpoint
ALTER TABLE quality_snapshots ADD CONSTRAINT quality_snapshots_metric_check CHECK (metric in (
  'coverage', 'coverage_navily', 'multi_source', 'multi_document', 'fact_precision', 'quote_fidelity',
  'shelter_confidence', 'route_reconstruction', 'cost_per_place', 'review_minutes', 'review_minutes_per_100',
  'highlight_share', 'recent_observation_share', 'places_per_tile'
));
