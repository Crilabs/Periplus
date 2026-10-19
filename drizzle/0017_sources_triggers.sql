-- sources and documents are stable: never deleted (end via valid_to), core-column changes write <table>_history.
CREATE TRIGGER sources_forbid_delete BEFORE DELETE ON sources FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TRIGGER documents_forbid_delete BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION forbid_delete();
--> statement-breakpoint
CREATE TABLE sources_history (
  history_id bigserial PRIMARY KEY,
  row_id uuid NOT NULL,
  old_row jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE documents_history (
  history_id bigserial PRIMARY KEY,
  row_id uuid NOT NULL,
  old_row jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX sources_history_row_id_idx ON sources_history (row_id);
--> statement-breakpoint
CREATE INDEX documents_history_row_id_idx ON documents_history (row_id);
--> statement-breakpoint
CREATE TRIGGER sources_history_append_only BEFORE UPDATE OR DELETE ON sources_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER documents_history_append_only BEFORE UPDATE OR DELETE ON documents_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER sources_record_history BEFORE UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION record_history('type,weight,status,crawl_rules,change_rate,valid_to');
--> statement-breakpoint
CREATE TRIGGER documents_record_history BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION record_history('status,url_normalized,valid_to');
--> statement-breakpoint
CREATE TRIGGER sources_set_updated_at BEFORE UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER documents_set_updated_at BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- document_versions is append-only; chunks is append-only except for the embedding (backfill, model change).
CREATE TRIGGER document_versions_append_only BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('');
--> statement-breakpoint
CREATE TRIGGER chunks_append_only BEFORE UPDATE OR DELETE ON chunks
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('embedding,embedding_model');
