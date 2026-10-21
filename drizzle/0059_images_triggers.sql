-- Images (spec 13): imagery_tiles and place_images are stable tables (no DELETE, no TRUNCATE, history of core-column
-- changes, pattern of 0054); place_renders is append-only.
CREATE TRIGGER imagery_tiles_forbid_delete BEFORE DELETE ON imagery_tiles FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TABLE imagery_tiles_history (
  history_id bigserial PRIMARY KEY,
  row_id uuid NOT NULL,
  old_row jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX imagery_tiles_history_row_id_idx ON imagery_tiles_history (row_id);
--> statement-breakpoint
CREATE TRIGGER imagery_tiles_history_append_only BEFORE UPDATE OR DELETE ON imagery_tiles_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER imagery_tiles_record_history BEFORE UPDATE ON imagery_tiles
  FOR EACH ROW EXECUTE FUNCTION record_history('valid_to,file_key,blank');
--> statement-breakpoint
CREATE TRIGGER imagery_tiles_set_updated_at BEFORE UPDATE ON imagery_tiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER imagery_tiles_no_truncate BEFORE TRUNCATE ON imagery_tiles
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER imagery_tiles_history_no_truncate BEFORE TRUNCATE ON imagery_tiles_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER place_images_forbid_delete BEFORE DELETE ON place_images FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TABLE place_images_history (
  history_id bigserial PRIMARY KEY,
  row_id uuid NOT NULL,
  old_row jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX place_images_history_row_id_idx ON place_images_history (row_id);
--> statement-breakpoint
CREATE TRIGGER place_images_history_append_only BEFORE UPDATE OR DELETE ON place_images_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER place_images_record_history BEFORE UPDATE ON place_images
  FOR EACH ROW EXECUTE FUNCTION record_history('valid_to');
--> statement-breakpoint
CREATE TRIGGER place_images_set_updated_at BEFORE UPDATE ON place_images
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER place_images_no_truncate BEFORE TRUNCATE ON place_images
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER place_images_history_no_truncate BEFORE TRUNCATE ON place_images_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER place_renders_append_only BEFORE UPDATE OR DELETE ON place_renders
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER place_renders_no_truncate BEFORE TRUNCATE ON place_renders
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
