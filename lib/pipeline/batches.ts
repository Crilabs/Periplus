import { and, desc, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { estimateBatchCostEur, resolveTaskModel } from "@/lib/ai/cost";
import type { CollectedBatch, ModelClient, ModelTask } from "@/lib/ai/types";
import { totalTokens } from "@/lib/ai/types";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiBatchItems } from "@/lib/db/schema";
import { BudgetExceeded, dailySpendEur, recordExternalCall } from "@/lib/domain/costs";
import { extendStage, isRunEnded, recordJobOutcome, stageAcceptsJobs } from "@/lib/domain/runs";
import { enqueueBatchPoll, enqueueRunAdvance } from "@/lib/jobs/enqueue";
import { createLogger } from "@/lib/logger";

/*
 * Message batches of run stages (spec 06, rulings M4-P1..P6, P9). A stage job hands its model requests to
 * `submitStageBatch`, which counts the batch as one more unit of the stage (`outcome_key` "batch:<job key>"); the
 * self-rescheduling `ai.batch.poll` job (`pollBatch`) collects the results, books their cost, hands every successful
 * item to the task's batch handler once, resubmits retryable failures once and finally records the unit's outcome.
 * Every step is a conditional state transition, so a doubled or retried job changes nothing twice.
 */

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.batches"));

/** One request of a stage batch: the subject it is about (e.g. a document version) and the task input. */
export type BatchItemInput = { subjectType: string; subjectId: string; input: unknown };

/** A successful batch item as its handler receives it (usage and cost from `ai_batch_items`, ruling M4-P9). */
export type BatchHandlerItem = {
  id: string;
  subjectType: string;
  subjectId: string;
  input: unknown;
  output: unknown;
  usage: { inputTokens: number; outputTokens: number };
  costEur: number;
  batch: { id: string; model: string; promptVersion: number; runId: string; stage: string };
};

/** Stores the result of one item; runs in the transaction that marks the item distributed. */
export type BatchHandler = (db: Db, item: BatchHandlerItem) => Promise<void>;

/** What `pollBatch` needs per task name: the task (output schema for collecting) and its handler. */
export type BatchHandlerEntry = { task: ModelTask<unknown, unknown>; handle: BatchHandler };

export type BatchDeps = { model: ModelClient; boss: PgBoss; config?: AppConfig; now?: () => Date };

export type SubmitStageBatchRequest = {
  task: ModelTask<unknown, unknown>;
  runId: string;
  stage: string;
  /** Key of the submitting job; the batch unit is `batch:<key>`. */
  key: string;
  items: BatchItemInput[];
  modelOverride?: string;
};

export type PollResult = "waiting" | "distributed" | "resubmitted" | "failed";

type BatchRow = typeof aiBatches.$inferSelect;

const OPEN_STATUSES = ["submitting", "submitted"] as const;
const ERROR_MAX_HOURS = "batch exceeded maxHours";
const ERROR_NO_RESULT = "no result for this request";

export function batchOutcomeKey(jobKey: string): string {
  return `batch:${jobKey}`;
}

/**
 * Budget check before a new batch (ruling M4-P6): today's anthropic spend plus the reservations of all batches not
 * yet booked (`submitting`, `submitted`) plus `estimateEur` must stay below the daily budget, else `BudgetExceeded`
 * (the worker pauses the queue and defers the job). A batch that alone reaches the budget can never pass and is a
 * planning error instead.
 */
export async function assertBatchBudget(
  db: Db,
  estimateEur: number,
  budgets: AppConfig["budgets"] = getConfig().budgets,
  now: Date = new Date(),
): Promise<void> {
  const budgetEur = budgets.anthropic.dailyEur;
  if (estimateEur >= budgetEur) {
    throw new Error(`Batch estimate ${estimateEur.toFixed(2)} EUR reaches the daily anthropic budget of ${budgetEur} EUR: plan smaller batches`);
  }
  const spentEur = await dailySpendEur(db, "anthropic", now);
  const [row] = await db
    .select({ reserved: sql<string>`coalesce(sum(${aiBatches.estimatedCostEur}), 0)` })
    .from(aiBatches)
    .where(inArray(aiBatches.status, [...OPEN_STATUSES]));
  const committed = spentEur + Number(row?.reserved ?? 0);
  if (committed + estimateEur >= budgetEur) throw new BudgetExceeded("anthropic", committed, budgetEur);
}

/** The newest batch of a stage unit (a follow-up batch shares the unit of the batch it repeats; ids are UUIDv7). */
async function latestBatchOfUnit(db: Db, runId: string, stage: string, outcomeKey: string): Promise<BatchRow | undefined> {
  const [row] = await db
    .select()
    .from(aiBatches)
    .where(and(eq(aiBatches.runId, runId), eq(aiBatches.stage, stage), eq(aiBatches.outcomeKey, outcomeKey)))
    .orderBy(desc(aiBatches.id))
    .limit(1);
  return row;
}

/**
 * Sends a batch in state `submitting` to the provider and schedules its first poll. The batch row stays locked
 * (`skip locked`) during the provider call, so a concurrent copy of the job sends nothing; the row moves to
 * `submitted` in the same transaction. A crash between the provider call and the commit leaves it `submitting`,
 * and the retried job sends it again (the first provider batch is then orphaned). Returns whether this call sent it.
 */
async function sendBatch(db: Db, deps: BatchDeps, batchId: string, task: ModelTask<unknown, unknown>): Promise<boolean> {
  const config = deps.config ?? getConfig();
  return db.transaction(async (tx) => {
    const [batch] = await tx
      .select()
      .from(aiBatches)
      .where(and(eq(aiBatches.id, batchId), eq(aiBatches.status, "submitting")))
      .for("update", { skipLocked: true });
    if (!batch) return false;
    const items = await tx
      .select({ id: aiBatchItems.id, input: aiBatchItems.input })
      .from(aiBatchItems)
      .where(and(eq(aiBatchItems.batchId, batchId), eq(aiBatchItems.status, "pending")))
      .orderBy(aiBatchItems.id);
    const submitted = await deps.model.submitBatch(
      task,
      items.map((i) => ({ customId: i.id, input: i.input })),
      { runId: batch.runId, stage: batch.stage, model: batch.model },
    );
    await tx
      .update(aiBatches)
      .set({
        providerBatchId: submitted.batchId,
        status: "submitted",
        submittedAt: deps.now?.() ?? new Date(),
        model: submitted.model,
        promptVersion: submitted.promptVersion,
      })
      .where(eq(aiBatches.id, batchId));
    await enqueueBatchPoll(deps.boss, batchId, 0, config.models.batch.pollSeconds, tx);
    getLog().info({ batchId, providerBatchId: submitted.batchId, task: batch.task, items: items.length }, "batch sent");
    return true;
  });
}

/**
 * Hands the requests of a stage job to the provider as one message batch. Nothing for an empty list. A batch of
 * the same unit (`runId`, `stage`, `batch:<key>`) means a retried job: it is reused (and sent if it is still
 * `submitting`). Otherwise the budget is checked first, then one transaction stores the batch (`submitting`) with
 * its items and extends the stage by one unit, which only the poll job finishes; the provider call follows.
 */
export async function submitStageBatch(
  db: Db,
  deps: BatchDeps,
  req: SubmitStageBatchRequest,
): Promise<{ batchId: string | null; items: number; reused: boolean }> {
  if (req.items.length === 0) return { batchId: null, items: 0, reused: false };
  const config = deps.config ?? getConfig();
  if (req.items.length > config.models.batch.maxRequests) {
    throw new Error(`Batch of ${req.items.length} requests exceeds models.batch.maxRequests ${config.models.batch.maxRequests}`);
  }
  const outcomeKey = batchOutcomeKey(req.key);

  const reuse = async (batch: BatchRow) => {
    if (batch.status === "submitting") await sendBatch(db, deps, batch.id, req.task);
    return { batchId: batch.id, items: batch.requestCount, reused: true };
  };
  const existing = await latestBatchOfUnit(db, req.runId, req.stage, outcomeKey);
  if (existing) return reuse(existing);

  const { model, taskConfig } = resolveTaskModel(config, req.task.name, req.modelOverride);
  const estimate = estimateBatchCostEur(config, req.task, req.items.map((i) => i.input), req.modelOverride);
  await assertBatchBudget(db, estimate, config.budgets, deps.now?.());

  const created = await db.transaction(async (tx) => {
    // Locks the stage row: concurrent copies of the job wait here and then find the batch of the first.
    if (!(await stageAcceptsJobs(tx, req.runId, req.stage))) return { kind: "closed" as const };
    const other = await latestBatchOfUnit(tx, req.runId, req.stage, outcomeKey);
    if (other) return { kind: "existing" as const, batch: other };
    const [batch] = await tx
      .insert(aiBatches)
      .values({
        task: req.task.name,
        model,
        promptVersion: taskConfig.promptVersion,
        runId: req.runId,
        stage: req.stage,
        outcomeKey,
        requestCount: req.items.length,
        estimatedCostEur: estimate.toFixed(6),
      })
      .returning();
    await tx.insert(aiBatchItems).values(
      req.items.map((item) => ({
        batchId: batch!.id,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        input: item.input as object,
      })),
    );
    if (!(await extendStage(tx, req.runId, req.stage, 1))) throw new Error(`stage ${req.stage} of run ${req.runId} stopped running while locked`);
    return { kind: "created" as const, batch: batch! };
  });

  if (created.kind === "closed") {
    getLog().warn({ runId: req.runId, stage: req.stage, key: req.key }, "stage takes no more jobs, batch not submitted");
    return { batchId: null, items: 0, reused: false };
  }
  if (created.kind === "existing") return reuse(created.batch);
  await sendBatch(db, deps, created.batch.id, req.task);
  return { batchId: created.batch.id, items: req.items.length, reused: false };
}

/** Records the unit's outcome and, when that finishes the stage, enqueues the next one, in the caller's transaction. */
async function settleUnit(tx: Db, boss: PgBoss, batch: BatchRow, outcome: "done" | "failed"): Promise<void> {
  const result = await recordJobOutcome(tx, batch.runId, batch.stage, batch.outcomeKey, outcome);
  if (result.nextStage) await enqueueRunAdvance(boss, batch.runId, result.nextStage, tx);
}

/**
 * Moves a collected batch from `submitted` to `ended` and stores every item's result, and books the batch as one
 * `external_calls` row, all in one transaction (ruling M4-P4): only the call that wins the transition books it.
 * A retryable failure on the first attempt becomes `retried` (resent later), any other failure `failed`.
 */
async function storeResults(db: Db, deps: BatchDeps, batch: BatchRow, collected: CollectedBatch<unknown>): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await db.transaction(async (tx) => {
    const [ended] = await tx
      .update(aiBatches)
      .set({ status: "ended", endedAt: now, costEur: collected.costEur.toFixed(6) })
      .where(and(eq(aiBatches.id, batch.id), eq(aiBatches.status, "submitted")))
      .returning({ id: aiBatches.id });
    if (!ended) return;
    const results = new Map(collected.results.map((r) => [r.customId, r]));
    const items = await tx
      .select({ id: aiBatchItems.id, attempt: aiBatchItems.attempt })
      .from(aiBatchItems)
      .where(and(eq(aiBatchItems.batchId, batch.id), eq(aiBatchItems.status, "pending")));
    for (const item of items) {
      const r = results.get(item.id) ?? { customId: item.id, ok: false as const, error: ERROR_NO_RESULT, retryable: true };
      // Input tokens of an item: uncached, cache-written and cache-read input together.
      const tokens = r.usage
        ? { inputTokens: r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens, outputTokens: r.usage.outputTokens }
        : {};
      const costEur = r.costEur !== undefined ? { costEur: r.costEur.toFixed(6) } : {};
      await tx
        .update(aiBatchItems)
        .set(
          r.ok
            ? { status: "succeeded", output: r.output as object, ...tokens, ...costEur }
            : { status: r.retryable && item.attempt < 2 ? "retried" : "failed", error: r.error, ...tokens, ...costEur },
        )
        .where(eq(aiBatchItems.id, item.id));
    }
    const { usage } = collected;
    await recordExternalCall(tx, {
      service: "anthropic",
      operation: `${batch.task}.batch`,
      units: totalTokens(usage),
      unit: "tokens",
      costEur: collected.costEur,
      runId: batch.runId,
      stage: batch.stage,
      meta: {
        batchId: batch.id,
        providerBatchId: batch.providerBatchId,
        model: batch.model,
        promptVersion: batch.promptVersion,
        items: collected.results.length,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
      },
      ...(deps.now ? { at: now } : {}),
    });
  });
}

/** Hands every successful, not yet distributed item to the handler, each in its own transaction, at most once. */
async function distribute(db: Db, deps: BatchDeps, batch: BatchRow, handle: BatchHandler): Promise<void> {
  const ids = await db
    .select({ id: aiBatchItems.id })
    .from(aiBatchItems)
    .where(and(eq(aiBatchItems.batchId, batch.id), eq(aiBatchItems.status, "succeeded"), isNull(aiBatchItems.distributedAt)))
    .orderBy(aiBatchItems.id);
  for (const { id } of ids) {
    await db.transaction(async (tx) => {
      // The lock makes a concurrent copy wait and then skip the item it finds distributed.
      const [item] = await tx
        .select()
        .from(aiBatchItems)
        .where(and(eq(aiBatchItems.id, id), isNull(aiBatchItems.distributedAt)))
        .for("update");
      if (!item) return;
      await handle(tx, {
        id: item.id,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        input: item.input,
        output: item.output,
        usage: { inputTokens: item.inputTokens ?? 0, outputTokens: item.outputTokens ?? 0 },
        costEur: Number(item.costEur ?? 0),
        batch: { id: batch.id, model: batch.model, promptVersion: batch.promptVersion, runId: batch.runId, stage: batch.stage },
      });
      await tx
        .update(aiBatchItems)
        .set({ distributedAt: deps.now?.() ?? new Date() })
        .where(eq(aiBatchItems.id, id));
    });
  }
}

/**
 * Closes a distributed batch (ruling M4-P3): in one transaction the batch becomes `distributed` and either its
 * `retried` items move into a follow-up batch of the same unit (attempt 2, `submitting`, sent after the commit), or
 * the unit is done.
 */
async function closeBatch(db: Db, deps: BatchDeps, batch: BatchRow): Promise<void> {
  await db.transaction(async (tx) => {
    const [closed] = await tx
      .update(aiBatches)
      .set({ status: "distributed" })
      .where(and(eq(aiBatches.id, batch.id), eq(aiBatches.status, "ended")))
      .returning({ id: aiBatches.id });
    if (!closed) return;
    const retried = await tx
      .select()
      .from(aiBatchItems)
      .where(and(eq(aiBatchItems.batchId, batch.id), eq(aiBatchItems.status, "retried")))
      .orderBy(aiBatchItems.id);
    if (retried.length === 0) return settleUnit(tx, deps.boss, batch, "done");
    const share = batch.estimatedCostEur === null ? null : (Number(batch.estimatedCostEur) * retried.length) / batch.requestCount;
    const [followUp] = await tx
      .insert(aiBatches)
      .values({
        task: batch.task,
        model: batch.model,
        promptVersion: batch.promptVersion,
        runId: batch.runId,
        stage: batch.stage,
        outcomeKey: batch.outcomeKey,
        requestCount: retried.length,
        estimatedCostEur: share === null ? null : share.toFixed(6),
      })
      .returning({ id: aiBatches.id });
    await tx.insert(aiBatchItems).values(
      retried.map((item) => ({
        batchId: followUp!.id,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        input: item.input as object,
        attempt: item.attempt + 1,
      })),
    );
    getLog().info({ batchId: batch.id, followUpId: followUp!.id, items: retried.length }, "retryable failures resubmitted");
  });
}

/**
 * Gives up on a batch the provider has not finished within `maxHours`: the batch and its open items fail and the
 * unit is recorded as failed, once.
 */
async function expireBatch(db: Db, deps: BatchDeps, batch: BatchRow): Promise<void> {
  await db.transaction(async (tx) => {
    const [failed] = await tx
      .update(aiBatches)
      .set({ status: "failed" })
      .where(and(eq(aiBatches.id, batch.id), eq(aiBatches.status, "submitted")))
      .returning({ id: aiBatches.id });
    if (!failed) return;
    await tx
      .update(aiBatchItems)
      .set({ status: "failed", error: ERROR_MAX_HOURS })
      .where(and(eq(aiBatchItems.batchId, batch.id), eq(aiBatchItems.status, "pending")));
    await settleUnit(tx, deps.boss, batch, "failed");
  });
  getLog().warn({ batchId: batch.id, providerBatchId: batch.providerBatchId }, "batch exceeded maxHours, unit failed");
}

/**
 * Puts a batch the dead-letter handler failed back into the state it failed in, so a manual retry of its poll job
 * continues it: not yet sent (`submitting`), sent but not collected (`submitted`, items still pending) or collected
 * (`ended`). A batch failed for running past `maxHours` (its items failed) stays failed. Returns the revived row.
 */
async function reviveBatch(db: Db, batch: BatchRow): Promise<BatchRow | undefined> {
  let status: "submitting" | "submitted" | "ended";
  if (batch.endedAt !== null) status = "ended";
  else {
    const [pending] = await db
      .select({ id: aiBatchItems.id })
      .from(aiBatchItems)
      .where(and(eq(aiBatchItems.batchId, batch.id), eq(aiBatchItems.status, "pending")))
      .limit(1);
    if (!pending) return undefined;
    status = batch.providerBatchId === null ? "submitting" : "submitted";
  }
  const [revived] = await db
    .update(aiBatches)
    .set({ status })
    .where(and(eq(aiBatches.id, batch.id), eq(aiBatches.status, "failed")))
    .returning();
  if (revived) getLog().info({ batchId: batch.id, status }, "failed batch revived");
  return revived;
}

/**
 * After a batch is distributed: sends its follow-up batch when that is still waiting to be sent (also when a
 * dead-lettered poll job failed it and is retried by hand). Returns `resubmitted` when the batch had a follow-up.
 */
async function continueUnit(db: Db, deps: BatchDeps, batch: BatchRow, entry: BatchHandlerEntry): Promise<PollResult> {
  const [followUp] = await db
    .select()
    .from(aiBatches)
    .where(
      and(
        eq(aiBatches.runId, batch.runId),
        eq(aiBatches.stage, batch.stage),
        eq(aiBatches.outcomeKey, batch.outcomeKey),
        gt(aiBatches.id, batch.id),
      ),
    )
    .orderBy(aiBatches.id)
    .limit(1);
  if (!followUp) return "distributed";
  const current = followUp.status === "failed" ? await reviveBatch(db, followUp) : followUp;
  if (current?.status === "submitting") await sendBatch(db, deps, current.id, entry.task);
  return "resubmitted";
}

/**
 * One poll of a batch (job `ai.batch.poll`):
 * 1. still running at the provider: schedules the next poll (job id from `batchId:poll_count`), or after `maxHours`
 *    fails the batch and its unit;
 * 2. ended: stores the results and books the cost (once);
 * 3. hands each successful item to the task's handler (once);
 * 4. closes the batch: a follow-up batch for retryable failures, sent right away, or the unit is done.
 * Each step can be repeated after a crash or by a doubled job without effect. A run an admin ended is no longer
 * distributed to: its batch is still collected and booked, then fails.
 */
export async function pollBatch(
  db: Db,
  deps: BatchDeps & { handlers: Record<string, BatchHandlerEntry> },
  batchId: string,
): Promise<PollResult> {
  const config = deps.config ?? getConfig();
  let batch: BatchRow | undefined = (await db.select().from(aiBatches).where(eq(aiBatches.id, batchId)))[0];
  if (!batch) throw new Error(`ai batch ${batchId} does not exist`);
  const entry = deps.handlers[batch.task];
  if (!entry) throw new Error(`No batch handler for task ${batch.task}`);

  if (batch.status === "failed") {
    batch = await reviveBatch(db, batch);
    if (!batch) return "failed";
  }
  if (batch.status === "submitting") {
    // Revived before it was ever sent; otherwise its submitter sends it and schedules the first poll.
    await sendBatch(db, deps, batch.id, entry.task);
    return "waiting";
  }
  if (batch.status === "distributed") return continueUnit(db, deps, batch, entry);

  if (batch.status === "submitted") {
    const collected = await deps.model.collectBatch(entry.task, batch.providerBatchId!, {
      runId: batch.runId,
      stage: batch.stage,
      model: batch.model,
    });
    if (collected.status === "in_progress") {
      const now = deps.now?.() ?? new Date();
      const since = batch.submittedAt ?? batch.createdAt;
      if (now.getTime() - since.getTime() > config.models.batch.maxHours * 3_600_000) {
        await expireBatch(db, deps, batch);
        return "failed";
      }
      await db.transaction(async (tx) => {
        const [next] = await tx
          .update(aiBatches)
          .set({ pollCount: sql`${aiBatches.pollCount} + 1` })
          .where(and(eq(aiBatches.id, batchId), eq(aiBatches.status, "submitted"), eq(aiBatches.pollCount, batch!.pollCount)))
          .returning({ pollCount: aiBatches.pollCount });
        // A doubled poll lost the race: the winner has scheduled the next poll.
        if (next) await enqueueBatchPoll(deps.boss, batchId, next.pollCount, config.models.batch.pollSeconds, tx);
      });
      return "waiting";
    }
    await storeResults(db, deps, batch, collected);
    [batch] = await db.select().from(aiBatches).where(eq(aiBatches.id, batchId));
    if (batch!.status !== "ended") return pollBatch(db, deps, batchId);
  }

  if (await isRunEnded(db, batch!.runId)) {
    await db
      .update(aiBatches)
      .set({ status: "failed" })
      .where(and(eq(aiBatches.id, batchId), notInArray(aiBatches.status, ["distributed", "failed"])));
    getLog().info({ batchId, runId: batch!.runId }, "run ended by admin, batch not distributed");
    return "failed";
  }
  await distribute(db, deps, batch!, entry.handle);
  await closeBatch(db, deps, batch!);
  return continueUnit(db, deps, batch!, entry);
}

/**
 * Dead-letter branch for an `ai.batch.poll` job (ruling M4-P2), in the dead-letter transaction: fails the open batch
 * of the job's unit (the batch itself or its follow-up) and records the unit as failed, so the stage can finish.
 * A manual retry of the poll job revives the batch and, once distributed, turns the outcome into `done`.
 */
export async function failBatchUnit(tx: Db, boss: PgBoss, batchId: string): Promise<boolean> {
  const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.id, batchId));
  if (!batch) return false;
  const failed = await tx
    .update(aiBatches)
    .set({ status: "failed" })
    .where(
      and(
        eq(aiBatches.runId, batch.runId),
        eq(aiBatches.stage, batch.stage),
        eq(aiBatches.outcomeKey, batch.outcomeKey),
        notInArray(aiBatches.status, ["distributed", "failed"]),
      ),
    )
    .returning({ id: aiBatches.id });
  // No open batch: the unit already has its outcome (done, or failed after maxHours).
  if (failed.length === 0) return false;
  await settleUnit(tx, boss, batch, "failed");
  return true;
}
