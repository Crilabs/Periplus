-- Subdivisions (spec 14) are a stable table: no DELETE, no TRUNCATE, history of core-column changes (pattern of 0006).
CREATE TRIGGER subdivisions_forbid_delete BEFORE DELETE ON subdivisions FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TABLE subdivisions_history (
  history_id bigserial PRIMARY KEY,
  row_id uuid NOT NULL,
  old_row jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX subdivisions_history_row_id_idx ON subdivisions_history (row_id);
--> statement-breakpoint
CREATE TRIGGER subdivisions_history_append_only BEFORE UPDATE OR DELETE ON subdivisions_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER subdivisions_record_history BEFORE UPDATE ON subdivisions
  FOR EACH ROW EXECUTE FUNCTION record_history('status,status_reason,geom,land_geom,queued_at,built_at,valid_to');
--> statement-breakpoint
CREATE TRIGGER subdivisions_set_updated_at BEFORE UPDATE ON subdivisions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER subdivisions_no_truncate BEFORE TRUNCATE ON subdivisions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER subdivisions_history_no_truncate BEFORE TRUNCATE ON subdivisions_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
-- New core columns: subdivision and sea assignment of geo objects, label subdivision of tiles.
DROP TRIGGER geo_objects_record_history ON geo_objects;
--> statement-breakpoint
CREATE TRIGGER geo_objects_record_history BEFORE UPDATE ON geo_objects
  FOR EACH ROW EXECUTE FUNCTION record_history('type,geom,parent_id,subdivision_id,sea_id,valid_to');
--> statement-breakpoint
DROP TRIGGER tiles_record_history ON tiles;
--> statement-breakpoint
CREATE TRIGGER tiles_record_history BEFORE UPDATE ON tiles
  FOR EACH ROW EXECUTE FUNCTION record_history('area_id,subdivision_id,has_coast,valid_to');
