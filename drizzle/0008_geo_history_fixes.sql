-- restricted_areas is stable too: history of core-column changes (kind, geom, valid_to); append-only.
CREATE TABLE restricted_areas_history (
  history_id bigserial PRIMARY KEY,
  row_id uuid NOT NULL,
  old_row jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX restricted_areas_history_row_id_idx ON restricted_areas_history (row_id);
--> statement-breakpoint
CREATE TRIGGER restricted_areas_history_append_only BEFORE UPDATE OR DELETE ON restricted_areas_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER restricted_areas_record_history BEFORE UPDATE ON restricted_areas
  FOR EACH ROW EXECUTE FUNCTION record_history('kind,geom,valid_to');
--> statement-breakpoint
-- tile_id is always derived from position: recompute on any change of position or tile_id.
DROP TRIGGER places_set_tile ON places;
--> statement-breakpoint
CREATE TRIGGER places_set_tile
  BEFORE INSERT OR UPDATE OF position, tile_id ON places
  FOR EACH ROW EXECUTE FUNCTION places_set_tile();
--> statement-breakpoint
-- updated_at maintenance (clock_timestamp so it moves even inside one transaction).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER geo_objects_set_updated_at BEFORE UPDATE ON geo_objects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER places_set_updated_at BEFORE UPDATE ON places
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
