-- Tile of a point: 'q025:<col>:<row>', col = floor((lon + 180) / 0.25), row = floor((lat + 90) / 0.25).
-- A coordinate exactly on an edge belongs to the tile east / north of it. Same formula as the TypeScript tile id.
CREATE OR REPLACE FUNCTION tile_id_for(g geometry) RETURNS text AS $$
  SELECT 'q025:'
    || floor((ST_X(g) + 180::float8) / 0.25::float8)::bigint
    || ':'
    || floor((ST_Y(g) + 90::float8) / 0.25::float8)::bigint
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION places_set_tile() RETURNS trigger AS $$
BEGIN
  NEW.tile_id := tile_id_for(NEW.position);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER places_set_tile
  BEFORE INSERT OR UPDATE OF position ON places
  FOR EACH ROW EXECUTE FUNCTION places_set_tile();
--> statement-breakpoint
-- Stable tables are never deleted; a row ends via valid_to.
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted; end them via valid_to', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER geo_objects_forbid_delete BEFORE DELETE ON geo_objects FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER geo_names_forbid_delete BEFORE DELETE ON geo_names FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER places_forbid_delete BEFORE DELETE ON places FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER tiles_forbid_delete BEFORE DELETE ON tiles FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER restricted_areas_forbid_delete BEFORE DELETE ON restricted_areas FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
-- History of core-column changes; append-only.
CREATE TABLE geo_objects_history (
  history_id bigserial PRIMARY KEY,
  row_id uuid NOT NULL,
  old_row jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE geo_names_history (
  history_id bigserial PRIMARY KEY,
  row_id uuid NOT NULL,
  old_row jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE places_history (
  history_id bigserial PRIMARY KEY,
  row_id uuid NOT NULL,
  old_row jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE tiles_history (
  history_id bigserial PRIMARY KEY,
  row_id text NOT NULL,
  old_row jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX geo_objects_history_row_id_idx ON geo_objects_history (row_id);
--> statement-breakpoint
CREATE INDEX geo_names_history_row_id_idx ON geo_names_history (row_id);
--> statement-breakpoint
CREATE INDEX places_history_row_id_idx ON places_history (row_id);
--> statement-breakpoint
CREATE INDEX tiles_history_row_id_idx ON tiles_history (row_id);
--> statement-breakpoint
CREATE TRIGGER geo_objects_history_append_only BEFORE UPDATE OR DELETE ON geo_objects_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER geo_names_history_append_only BEFORE UPDATE OR DELETE ON geo_names_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER places_history_append_only BEFORE UPDATE OR DELETE ON places_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER tiles_history_append_only BEFORE UPDATE OR DELETE ON tiles_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
-- record_history('col1,col2,…'): before an UPDATE that changes any listed core column, writes the old row
-- (to_jsonb(OLD), geometries as GeoJSON) to <table>_history. Other columns change without history.
CREATE OR REPLACE FUNCTION record_history() RETURNS trigger AS $$
DECLARE
  core text[] := string_to_array(TG_ARGV[0], ',');
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
  col text;
BEGIN
  FOREACH col IN ARRAY core LOOP
    IF old_row -> col IS DISTINCT FROM new_row -> col THEN
      EXECUTE format('INSERT INTO %I (row_id, old_row) VALUES ($1, $2)', TG_TABLE_NAME || '_history')
        USING OLD.id, old_row;
      RETURN NEW;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER geo_objects_record_history BEFORE UPDATE ON geo_objects
  FOR EACH ROW EXECUTE FUNCTION record_history('type,geom,parent_id,valid_to');
--> statement-breakpoint
CREATE TRIGGER geo_names_record_history BEFORE UPDATE ON geo_names
  FOR EACH ROW EXECUTE FUNCTION record_history('name,language,valid_to');
--> statement-breakpoint
CREATE TRIGGER places_record_history BEFORE UPDATE ON places
  FOR EACH ROW EXECUTE FUNCTION record_history('kind,status,position,anchor_position,merged_into_id,valid_to');
--> statement-breakpoint
CREATE TRIGGER tiles_record_history BEFORE UPDATE ON tiles
  FOR EACH ROW EXECUTE FUNCTION record_history('area_id,has_coast,valid_to');
