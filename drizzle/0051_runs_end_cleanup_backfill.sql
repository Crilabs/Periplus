-- Runs an admin ended before the repeatable cleanup existed (ruling GR-8) carry no `params.endCleanedUpAt`, so the run
-- page would offer „Aufräumen wiederholen“ for every one of them (wave-2 review M-2, ruling GR-13). A run whose cleanup
-- left nothing open (no pending or submitted extraction unit, no running unchecked extraction run, no unsent or
-- submitted batch) is marked cleaned up at its end time; one with an open remnant keeps the offer.
UPDATE runs r
SET params = r.params || jsonb_build_object('endCleanedUpAt', to_jsonb(coalesce(r.ended_at, r.finished_at, r.created_at)))
WHERE r.ended_by IS NOT NULL
  AND NOT (r.params ? 'endCleanedUpAt')
  AND NOT EXISTS (
    SELECT 1 FROM extraction_units u JOIN extraction_runs er ON er.id = u.extraction_run_id
    WHERE er.run_id = r.id AND u.status IN ('pending', 'submitted')
  )
  AND NOT EXISTS (
    SELECT 1 FROM extraction_runs er WHERE er.run_id = r.id AND er.status = 'running' AND er.quote_check IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM ai_batches b WHERE b.run_id = r.id AND b.status IN ('submitting', 'sending', 'submitted')
  );
