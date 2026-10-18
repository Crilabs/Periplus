-- Keep only the oldest open task per (kind, subject_id) so the unique index can be built.
UPDATE "review_tasks" SET "status" = 'dismissed'
WHERE "status" = 'open' AND "id" NOT IN (
  SELECT DISTINCT ON ("kind", "subject_id") "id" FROM "review_tasks"
  WHERE "status" = 'open' ORDER BY "kind", "subject_id", "created_at", "id"
);--> statement-breakpoint
CREATE UNIQUE INDEX "review_tasks_open_subject_unique" ON "review_tasks" USING btree ("kind","subject_id") WHERE "review_tasks"."status" = 'open';