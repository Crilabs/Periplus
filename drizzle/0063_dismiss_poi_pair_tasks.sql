-- POIs are no longer matched against each other by review: two POIs near each other are two places (spec 16). The
-- gazetteer opens no pair task between two POIs any more; this dismisses the ones left open before
-- (`dismissedReason` `superseded`).
UPDATE review_tasks t
SET status = 'dismissed', context = t.context || '{"dismissedReason": "superseded"}'::jsonb
WHERE t.status = 'open'
  AND t.kind = 'place_candidate'
  AND t.subject_type = 'geo_object_pair'
  AND jsonb_typeof(t.context->'geoObjectIds') = 'array'
  AND jsonb_array_length(t.context->'geoObjectIds') = 2
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(t.context->'geoObjectIds') AS e(id)
    LEFT JOIN geo_objects o ON o.id::text = e.id
    WHERE o.type IS DISTINCT FROM 'poi'
  );
