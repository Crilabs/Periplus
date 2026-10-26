import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { newId } from "@/lib/domain/ids";
import { runs } from "./ops";

/*
 * AI batches (spec 06): working state, no protection triggers. The old mentions, extraction and route tables went
 * with the old text pipeline (drizzle/0080_drop_old_pipeline.sql).
 */

export const mooringKindEnum = pgEnum("mooring_kind", ["anchor", "buoy", "quay", "marina", "unknown"]);
/**
 * Batch lifecycle: `submitting` (stored, not yet claimed) → `sending` (claimed under a lease, provider call running or
 * its outcome unknown) → `submitted` (provider id recorded) → `ended` (results stored and booked) → `distributed`;
 * `failed` from any state (ruling M4-C-R6).
 */
export const batchStatusEnum = pgEnum("batch_status", ["submitting", "sending", "submitted", "ended", "distributed", "failed"]);
export const batchItemStatusEnum = pgEnum("batch_item_status", ["pending", "succeeded", "failed", "retried"]);

export type MooringKind = (typeof mooringKindEnum.enumValues)[number];
export type BatchStatus = (typeof batchStatusEnum.enumValues)[number];
export type BatchItemStatus = (typeof batchItemStatusEnum.enumValues)[number];

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const costEur = () => numeric("cost_eur", { precision: 12, scale: 6 });

/** Working state: one provider message batch for one stage unit (`outcome_key`) of a run. */
export const aiBatches = pgTable(
  "ai_batches",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    /** Null until submitted. */
    providerBatchId: text("provider_batch_id").unique(),
    task: text("task").notNull(),
    model: text("model").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    status: batchStatusEnum("status").notNull().default("submitting"),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    stage: text("stage").notNull(),
    outcomeKey: text("outcome_key").notNull(),
    pollCount: integer("poll_count").notNull().default(0),
    requestCount: integer("request_count").notNull(),
    /** Budget reservation until the batch is booked (ruling M4-P6). */
    estimatedCostEur: numeric("estimated_cost_eur", { precision: 12, scale: 6 }),
    costEur: costEur(),
    /** The claim of the sender that may call the provider: only this claim can record the provider id. */
    claimId: uuid("claim_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Until then the claim's sender may still be talking to the provider; afterwards the claim is stale. */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    /** When the provider was asked to cancel the batch (run ended, poll dead-lettered, maxHours). */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // At most one open batch per stage unit.
    uniqueIndex("ai_batches_open_outcome_unique")
      .on(t.runId, t.stage, t.outcomeKey)
      .where(sql`${t.status} not in ('distributed', 'failed')`),
    // A claimed batch always has its claim and lease (text comparison: the enum value is new in this migration).
    check(
      "ai_batches_sending_claim",
      sql`${t.status}::text <> 'sending' or (${t.claimId} is not null and ${t.claimedAt} is not null and ${t.leaseUntil} is not null)`,
    ),
  ],
);

/** Working state: one request of a batch; `id` is the provider `custom_id`. */
export const aiBatchItems = pgTable(
  "ai_batch_items",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => aiBatches.id),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    input: jsonb("input").notNull(),
    status: batchItemStatusEnum("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(1),
    output: jsonb("output"),
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costEur: costEur(),
    distributedAt: timestamp("distributed_at", { withTimezone: true }),
    /** Why handing the item to its batch handler failed last time; cleared once it is distributed. */
    distributionError: text("distribution_error"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_batch_items_batch_id_idx").on(t.batchId)],
);

