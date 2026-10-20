-- An open task on a place that a gazetteer merge folded into another place could never be decided: every decision
-- refuses a merged place, and place tasks have no „Ignorieren“ (gesamt review UI-5). The merges now dismiss them; this
-- dismisses the ones left open before, as the merge does (`dismissedReason` `object_ended`).
UPDATE review_tasks t
SET status = 'dismissed', context = t.context || '{"dismissedReason": "object_ended"}'::jsonb
FROM places p
WHERE t.status = 'open'
  AND t.subject_type = 'place'
  AND p.id::text = t.subject_id
  AND p.merged_into_id IS NOT NULL;
