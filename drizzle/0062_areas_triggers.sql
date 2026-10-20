-- area_evidence is append-only except area_id (an area merge moves the evidence); area_members is re-derived on import.
CREATE TRIGGER area_evidence_append_only BEFORE UPDATE OR DELETE ON area_evidence
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation('area_id');
--> statement-breakpoint
CREATE TRIGGER area_evidence_no_truncate BEFORE TRUNCATE ON area_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation('');
