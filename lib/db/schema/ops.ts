import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";

export const runKindEnum = pgEnum("run_kind", ["full", "stage", "revisit", "event", "reprocess", "system"]);
export const runScopeTypeEnum = pgEnum("run_scope_type", ["tile", "area", "place", "source", "system"]);
export const runStatusEnum = pgEnum("run_status", ["queued", "running", "finished", "failed"]);
export const runStageStatusEnum = pgEnum("run_stage_status", ["pending", "running", "finished"]);

export type RunKind = (typeof runKindEnum.enumValues)[number];
export type RunScopeType = (typeof runScopeTypeEnum.enumValues)[number];
export type RunStatus = (typeof runStatusEnum.enumValues)[number];
export type RunStageStatus = (typeof runStageStatusEnum.enumValues)[number];

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().$defaultFn(newId),
  kind: runKindEnum("kind").notNull(),
  scopeType: runScopeTypeEnum("scope_type").notNull(),
  scopeId: text("scope_id").notNull(),
  stages: text("stages").array().notNull().default([]),
  params: jsonb("params").notNull().default({}),
  triggeredBy: text("triggered_by").notNull(),
  status: runStatusEnum("status").notNull().default("queued"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runStages = pgTable(
  "run_stages",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    stage: text("stage").notNull(),
    ordinal: integer("ordinal").notNull(),
    total: integer("total").notNull().default(0),
    done: integer("done").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    status: runStageStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("run_stages_run_id_stage_unique").on(t.runId, t.stage)],
);

/** One row per (run, stage, job key): makes recording a job outcome idempotent. Working state, not append-only. */
export const jobOutcomes = pgTable(
  "job_outcomes",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    stage: text("stage").notNull(),
    key: text("key").notNull(),
    outcome: text("outcome", { enum: ["done", "failed"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.stage, t.key] }),
    check("job_outcomes_outcome_check", sql`${t.outcome} in ('done', 'failed')`),
  ],
);

export const externalCalls = pgTable(
  "external_calls",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    service: text("service").notNull(),
    operation: text("operation").notNull(),
    units: numeric("units").notNull(),
    unit: text("unit").notNull(),
    costEur: numeric("cost_eur", { precision: 12, scale: 6 }).notNull(),
    runId: uuid("run_id"),
    tileId: text("tile_id"),
    stage: text("stage"),
    meta: jsonb("meta").notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("external_calls_service_at_idx").on(t.service, t.at)],
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const queueControls = pgTable("queue_controls", {
  queue: text("queue").primaryKey(),
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  reason: text("reason"),
  updatedBy: text("updated_by").notNull(),
});

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  host: text("host").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  beatAt: timestamp("beat_at", { withTimezone: true }).notNull(),
});
