import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";

export const reviewKindEnum = pgEnum("review_kind", [
  "source_approval",
  "place_candidate",
  "conflict",
  "failed_job",
  "coast_tile_without_area",
  "uncertain_change",
  "comparison_deviation",
]);
export const reviewStatusEnum = pgEnum("review_status", ["open", "decided", "dismissed"]);

export type ReviewKind = (typeof reviewKindEnum.enumValues)[number];
export type ReviewStatus = (typeof reviewStatusEnum.enumValues)[number];

export const reviewTasks = pgTable("review_tasks", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  kind: reviewKindEnum("kind").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  context: jsonb("context").notNull().default({}),
  status: reviewStatusEnum("status").notNull().default("open"),
  priority: integer("priority").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // At most one open task per subject and kind; createReviewTask relies on it.
  uniqueIndex("review_tasks_open_subject_unique").on(t.kind, t.subjectId).where(sql`${t.status} = 'open'`),
]);

/** Append-only (forbid_mutation trigger). */
export const reviewDecisions = pgTable("review_decisions", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  taskId: uuid("task_id")
    .notNull()
    .references(() => reviewTasks.id),
  decision: jsonb("decision").notNull(),
  decidedBy: text("decided_by").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // the decisions of a task (consolidation inputs, review time metrics), gesamt-review DAT-7
  index("review_decisions_task_id_idx").on(t.taskId),
]);
