-- Spec 14: every coast tile belongs to a subdivision; a sailing area is found, never assigned to a tile. Open tasks of
-- the retired kind coast_tile_without_area are dismissed (the enum value stays for the decided ones).
UPDATE "review_tasks"
SET "status" = 'dismissed', "context" = "context" || '{"dismissedReason": "kind_retired"}'::jsonb
WHERE "kind" = 'coast_tile_without_area' AND "status" = 'open';
