import { and, desc, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { estimateBatchCostEur, resolveTaskModel } from "@/lib/ai/cost";
import type { CollectedBatch, ModelClient, ModelTask } from "@/lib/ai/types";
import { totalTokens } from "@/lib/ai/types";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiBatchItems } from "@/lib/db/schema";
import { BudgetExceeded, dailySpendEur, recordExternalCall, reservedBatchEur, type ReservationScope } from "@/lib/domain/costs";
import { newId } from "@/lib/domain/ids";
import { extendStage, isRunEnded, recordJobOutcome, stageAcceptsJobs } from "@/lib/domain/runs";
import { enqueueBatchJob, enqueueBatchPoll, enqueueRunAdvance, type BatchPollMode } from "@/lib/jobs/enqueue";
import { createLogger } from "@/lib/logger";

/*
 * Message batches of run stages (spec 06, rulings M4-P1..P6, P9, M4-C-R2, R4..R6). A stage job hands its model requests
 * to `submitStageBatch`, which counts the batch as one more unit of the stage (`outcome_key` "batch:<job key>"); the
 * self-rescheduling `ai.batch.poll` job (`pollBatch`) collects the results, books their cost, hands every successful
 * item to the task's batch handler once, resubmits retryable failures once and finally records the unit's outcome.
 * Every step is a conditional state transition, so a doubled or retried job changes nothing twice.
 *
 * Sending is claim → call → record (ruling M4-C-R6): a committed claim (`sending`, `claim_id`, `lease_until`), the
 * provider call outside any transaction and without SDK retries, then a conditional record of the provider id by that
 * claim only. A claim whose lease ran out (crash, or a call whose outcome is unknown) is resent only after the
 * provider's batch list shows no batch of it; a single match is adopted instead.
 *
 * Money (rulings M4-P6, M4-C-R5): the estimate of a batch is reserved from its insert until its cost is booked, also
 * while it is failed but may still be billed (sent, never collected); such a batch is cancelled at the provider and a
 * booking poll books what it billed.
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

/** What a handler may read besides the item: the poll's configuration (`deps.config`, else the loaded one). */
export type BatchHandlerContext = { config: AppConfig };

/** Stores the result of one item; runs in the transaction that marks the item distributed. */
export type BatchHandler = (db: Db, item: BatchHandlerItem, ctx: BatchHandlerContext) => Promise<void>;

/** An item that failed for good (after its retry, or not retryable, or its batch expired), with what it was billed. */
export type BatchFailedItem = {
  id: string;
  subjectType: string;
  subjectId: string;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number };
  costEur: number;
  batch: BatchHandlerItem["batch"];
};

/**
 * Records that an item failed for good or will never be distributed, in the transaction of the batch transition that
 * gives it up: close, expiry, a run an admin ended, or a dead letter. Called at least once per item, not exactly once
 * (a manual retry revives a batch, which may report its items again, and a revived batch may still distribute an item
 * reported before), so it must be idempotent and must not undo a later success (ruling M4-G-R3).
 */
export type BatchFailHandler = (db: Db, item: BatchFailedItem) => Promise<void>;

/**
 * What `pollBatch` needs per task name: the task (output schema for collecting), its handler and, optionally, what to
 * do with an item that failed for good (e.g. mark its extraction unit failed).
 */
export type BatchHandlerEntry = { task: ModelTask<unknown, unknown>; handle: BatchHandler; fail?: BatchFailHandler };

export type BatchDeps = {
  model: ModelClient;
  boss: PgBoss;
  config?: AppConfig;
  now?: () => Date;
  /** Limits the reservation sum to these runs; only for tests, which must never sum DB-wide (ruling M4-P23). */
  reservationScope?: ReservationScope;
};

export type SubmitStageBatchRequest = {
  task: ModelTask<unknown, unknown>;
  runId: string;
  stage: string;
  /** Key of the submitting job; the batch unit is `batch:<key>`. */
  key: string;
  items: BatchItemInput[];
  modelOverride?: string;
  /** A prompt version replacing the task's configured one (an extraction run's, ruling M4-G-R3). */
  promptVersionOverride?: number;
};

export type PollResult = "waiting" | "distributed" | "resubmitted" | "failed";

/** Which poll of the chain this is (`n`) and what kind of poll job (`mode`, see `BatchPollMode`). */
export type PollOptions = { n?: number; mode?: BatchPollMode };

type BatchRow = typeof aiBatches.$inferSelect;
type SendResult = "sent" | "adopted" | "busy" | "none";

const UNSENT_STATUSES = ["submitting", "sending"] as const;
const ERROR_MAX_HOURS = "batch exceeded maxHours";
const ERROR_NO_RESULT = "no result for this request";
const ERROR_RUN_ENDED = "run ended by admin";
const ERROR_DEAD_LETTER = "batch job failed permanently";
/** Advisory lock key that serialises every anthropic reservation check with the insert it guards. */
const BUDGET_LOCK = "periplus:anthropic-budget";

const isUnsent = (status: BatchRow["status"]) => (UNSENT_STATUSES as readonly string[]).includes(status);
const nowOf = (deps: BatchDeps) => deps.now?.() ?? new Date();

export function batchOutcomeKey(jobKey: string): string {
  return `batch:${jobKey}`;
}

/**
 * The anthropic budget left today (ruling M4-C-R2): the daily budget minus today's booked spend minus the reservations
 * of all batches whose cost is not booked yet. Can be negative. Stage planners size their batches with it.
 */
export async function anthropicHeadroomEur(
  db: Db,
  config: AppConfig = getConfig(),
  now: Date = new Date(),
  scope?: ReservationScope,
): Promise<number> {
  const spentEur = await dailySpendEur(db, "anthropic", now);
  const reservedEur = await reservedBatchEur(db, { now, hours: config.models.batch.reservationHours, scope });
  return config.budgets.anthropic.dailyEur - spentEur - reservedEur;
}

/**
 * How many of the leading requests fit into one batch (ruling M4-C-R2): the longest prefix of `costs` (per-request
 * estimates, `estimateBatchItemCostsEur`) whose sum stays below `headroomEur`, at most `maxRequests`. 0 means no
 * room today: the planner throws `BudgetExceeded`, so its job is deferred like any other.
 */
export function sizeBatch(costs: number[], headroomEur: number, maxRequests: number): number {
  let total = 0;
  let count = 0;
  for (const cost of costs) {
    if (count >= maxRequests || total + cost >= headroomEur) break;
    total += cost;
    count++;
  }
  return count;
}

/**
 * Budget check before a batch is stored or sent (ruling M4-P6): today's anthropic spend plus all open reservations
 * plus `estimateEur` must stay below the daily budget, else `BudgetExceeded` (the worker pauses the queue and defers
 * the job). A batch that alone reaches the budget can never pass and is a planning error instead. Callers hold the
 * budget lock (`lockBudget`) in the same transaction, so concurrent checks cannot all pass on the same headroom.
 */
export async function assertBatchBudget(
  db: Db,
  estimateEur: number,
  config: AppConfig = getConfig(),
  now: Date = new Date(),
  scope?: ReservationScope,
): Promise<void> {
  const budgetEur = config.budgets.anthropic.dailyEur;
  if (estimateEur >= budgetEur) {
    throw new Error(`Batch estimate ${estimateEur.toFixed(2)} EUR reaches the daily anthropic budget of ${budgetEur} EUR: plan smaller batches`);
  }
  const headroomEur = await anthropicHeadroomEur(db, config, now, scope);
  if (estimateEur >= headroomEur) throw new BudgetExceeded("anthropic", budgetEur - headroomEur, budgetEur);
}

/** Takes the transaction-scoped budget lock (ruling M4-C-R5); always before any row lock of the transaction. */
async function lockBudget(tx: Db): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${BUDGET_LOCK}))`);
}

/** Checks, under the budget lock, that a batch whose reservation already counts may be sent now. */
async function assertSendBudget(db: Db, deps: BatchDeps): Promise<void> {
  const config = deps.config ?? getConfig();
  await db.transaction(async (tx) => {
    await lockBudget(tx);
    await assertBatchBudget(tx, 0, config, nowOf(deps), deps.reservationScope);
  });
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

async function pendingItems(db: Db, batchId: string): Promise<Array<{ id: string; input: unknown }>> {
  return db
    .select({ id: aiBatchItems.id, input: aiBatchItems.input })
    .from(aiBatchItems)
    .where(and(eq(aiBatchItems.batchId, batchId), eq(aiBatchItems.status, "pending")))
    .orderBy(aiBatchItems.id);
}

/**
 * Records the provider batch of a claim: `provider_batch_id`, `submitted`, and the first poll, in one transaction,
 * only for the claim `claimId` and only once. A batch an admin's run end or a dead letter failed meanwhile is
 * recorded too, so its cost is still booked (the poll then cancels it or distributes it). Returns whether it won.
 */
async function recordSubmitted(
  db: Db,
  deps: BatchDeps,
  batchId: string,
  claimId: string,
  submitted: { batchId: string; model: string; promptVersion: number },
): Promise<boolean> {
  const config = deps.config ?? getConfig();
  return db.transaction(async (tx) => {
    const [recorded] = await tx
      .update(aiBatches)
      .set({
        providerBatchId: submitted.batchId,
        status: "submitted",
        submittedAt: nowOf(deps),
        model: submitted.model,
        promptVersion: submitted.promptVersion,
      })
      .where(
        and(
          eq(aiBatches.id, batchId),
          eq(aiBatches.claimId, claimId),
          isNull(aiBatches.providerBatchId),
          inArray(aiBatches.status, ["sending", "failed"]),
        ),
      )
      .returning({ pollCount: aiBatches.pollCount });
    if (!recorded) return false;
    await enqueueBatchPoll(deps.boss, batchId, recorded.pollCount, config.models.batch.pollSeconds, tx);
    return true;
  });
}

/**
 * The claim step of a send (ruling M4-C-R6), one short transaction: a `submitting` batch gets a fresh claim with a
 * lease; a `sending` batch is `busy` while its lease runs, else `stale`.
 */
async function claimBatch(
  db: Db,
  deps: BatchDeps,
  batchId: string,
): Promise<{ kind: "claimed"; batch: BatchRow; claimId: string } | { kind: "busy"; leaseUntil: Date } | { kind: "stale"; batch: BatchRow } | { kind: "none" }> {
  const config = deps.config ?? getConfig();
  const now = nowOf(deps);
  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.id, batchId)).for("update");
    if (batch?.status === "submitting") {
      const claimId = newId();
      const [claimed] = await tx
        .update(aiBatches)
        .set({ status: "sending", claimId, claimedAt: now, leaseUntil: new Date(now.getTime() + config.models.batch.leaseSeconds * 1000) })
        .where(eq(aiBatches.id, batchId))
        .returning();
      return { kind: "claimed" as const, batch: claimed!, claimId };
    }
    if (batch?.status === "sending") {
      if (batch.leaseUntil! > now) return { kind: "busy" as const, leaseUntil: batch.leaseUntil! };
      return { kind: "stale" as const, batch };
    }
    return { kind: "none" as const };
  });
}

/**
 * A stale claim's sender may have reached the provider. Adopts the one provider batch created in the claim's window
 * with as many requests as the batch has pending items and no row of ours; otherwise takes the claim over to resend.
 * More than one match cannot be told apart (the API keeps no metadata): it resends and logs the possible orphan.
 */
async function adoptOrReclaim(
  db: Db,
  deps: BatchDeps,
  stale: BatchRow,
): Promise<{ kind: "adopted" } | { kind: "claimed"; batch: BatchRow; claimId: string } | { kind: "none" }> {
  const config = deps.config ?? getConfig();
  const now = nowOf(deps);
  const skewMs = config.models.batch.clockSkewSeconds * 1000;
  const pending = await pendingItems(db, stale.id);
  const listed = await deps.model.listBatches({
    from: new Date(stale.claimedAt!.getTime() - skewMs),
    to: new Date(now.getTime() + skewMs),
  });
  const ids = listed.map((b) => b.batchId);
  const known =
    ids.length === 0
      ? new Set<string>()
      : new Set(
          (await db.select({ id: aiBatches.providerBatchId }).from(aiBatches).where(inArray(aiBatches.providerBatchId, ids))).map((r) => r.id),
        );
  const candidates = listed.filter((b) => b.requestCount === pending.length && !known.has(b.batchId));
  if (candidates.length === 1) {
    const adopted = await recordSubmitted(db, deps, stale.id, stale.claimId!, {
      batchId: candidates[0]!.batchId,
      model: stale.model,
      promptVersion: stale.promptVersion,
    });
    if (adopted) getLog().warn({ batchId: stale.id, providerBatchId: candidates[0]!.batchId }, "batch of a stale claim adopted from the provider list");
    return adopted ? { kind: "adopted" } : { kind: "none" };
  }
  if (candidates.length > 1) {
    getLog().error(
      { batchId: stale.id, candidates: candidates.map((c) => c.batchId) },
      "several provider batches match a stale claim: resending, one of them may be an unbooked orphan",
    );
  }
  const claimId = newId();
  const [taken] = await db
    .update(aiBatches)
    .set({ claimId, claimedAt: now, leaseUntil: new Date(now.getTime() + config.models.batch.leaseSeconds * 1000) })
    .where(and(eq(aiBatches.id, stale.id), eq(aiBatches.status, "sending"), eq(aiBatches.claimId, stale.claimId!)))
    .returning();
  return taken ? { kind: "claimed", batch: taken, claimId } : { kind: "none" };
}

/**
 * Sends a batch that is `submitting` (or `sending` with a stale lease) to the provider: claim → call → record (ruling
 * M4-C-R6). Never call it inside a transaction: the provider call must not hold a connection or a row lock.
 * - `sent`/`adopted`: the provider id is recorded and the first poll scheduled;
 * - `busy`: another sender's lease still runs;
 * - `none`: nothing to send (already sent, failed, or another sender won the claim).
 * A failed call rethrows: a budget refusal gives the claim back (nothing was sent); any other error ends the lease at
 * once, so the next attempt first looks for the batch in the provider's list.
 */
async function sendBatch(db: Db, deps: BatchDeps, batchId: string, task: ModelTask<unknown, unknown>): Promise<SendResult> {
  const first = await claimBatch(db, deps, batchId);
  if (first.kind === "none") return "none";
  if (first.kind === "busy") return "busy";
  let claim: { batch: BatchRow; claimId: string };
  if (first.kind === "stale") {
    const next = await adoptOrReclaim(db, deps, first.batch);
    if (next.kind === "adopted") return "adopted";
    if (next.kind === "none") return "none";
    claim = next;
  } else claim = first;

  const { batch, claimId } = claim;
  const items = await pendingItems(db, batch.id);
  let submitted;
  try {
    submitted = await deps.model.submitBatch(
      task,
      items.map((i) => ({ customId: i.id, input: i.input })),
      { runId: batch.runId, stage: batch.stage, model: batch.model, promptVersion: batch.promptVersion },
    );
  } catch (err) {
    const mine = and(eq(aiBatches.id, batch.id), eq(aiBatches.status, "sending"), eq(aiBatches.claimId, claimId));
    if (err instanceof BudgetExceeded) {
      // Refused before the call: nothing reached the provider.
      await db.update(aiBatches).set({ status: "submitting", claimId: null, claimedAt: null, leaseUntil: null }).where(mine);
    } else {
      // The provider may have accepted it: no resend before its list has been checked.
      await db.update(aiBatches).set({ leaseUntil: nowOf(deps) }).where(mine);
    }
    throw err;
  }
  if (await recordSubmitted(db, deps, batch.id, claimId, submitted)) {
    getLog().info({ batchId: batch.id, providerBatchId: submitted.batchId, task: batch.task, items: items.length }, "batch sent");
    return "sent";
  }
  // Another sender took the claim over meanwhile: this provider batch has no row and is cancelled at once.
  getLog().error({ batchId: batch.id, providerBatchId: submitted.batchId }, "claim lost after the provider accepted the batch: cancelling it");
  try {
    await deps.model.cancelBatch(submitted.batchId);
  } catch (cancelErr) {
    getLog().error({ err: cancelErr, providerBatchId: submitted.batchId }, "cancelling an orphaned provider batch failed");
  }
  return "none";
}

/**
 * Hands the requests of a stage job to the provider as one message batch. Nothing for an empty list. A batch of
 * the same unit (`runId`, `stage`, `batch:<key>`) means a retried job: it is reused (and sent if it is still unsent;
 * revived first when a dead letter failed it before it was sent). Otherwise one transaction takes the budget lock,
 * checks the budget, stores the batch (`submitting`) with its items and extends the stage by one unit, which only the
 * poll job finishes; the provider call follows (`sendBatch`).
 *
 * Must not be called inside a caller's transaction: the provider call would run with that transaction (and its locks
 * and connection) open, and a rollback after a successful send would erase the batch row, so the retried job pays
 * for a second provider batch.
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

  const existing = await latestBatchOfUnit(db, req.runId, req.stage, outcomeKey);
  if (existing) return reuseBatch(db, deps, req.task, existing);

  const { model, taskConfig } = resolveTaskModel(config, req.task.name, req.modelOverride, req.promptVersionOverride);
  const estimate = estimateBatchCostEur(config, req.task, req.items.map((i) => i.input), req.modelOverride, req.promptVersionOverride);
  const now = nowOf(deps);

  const created = await db.transaction(async (tx) => {
    // Serialises this check with its insert across all jobs (ruling M4-C-R5); taken before the stage row lock.
    await lockBudget(tx);
    // Locks the stage row: concurrent copies of the job wait here and then find the batch of the first.
    if (!(await stageAcceptsJobs(tx, req.runId, req.stage))) return { kind: "closed" as const };
    const other = await latestBatchOfUnit(tx, req.runId, req.stage, outcomeKey);
    if (other) return { kind: "existing" as const, batch: other };
    // Before the stage is extended: a deferred job has changed nothing (ruling M4-P6).
    await assertBatchBudget(tx, estimate, config, now, deps.reservationScope);
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
        ...(deps.now ? { createdAt: now } : {}),
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
  if (created.kind === "existing") return reuseBatch(db, deps, req.task, created.batch);
  await sendOrThrow(db, deps, created.batch.id, req.task);
  return { batchId: created.batch.id, items: req.items.length, reused: false };
}

/** Sends from a stage job; a lease held by another sender is an error, so the job is retried after it. */
async function sendOrThrow(db: Db, deps: BatchDeps, batchId: string, task: ModelTask<unknown, unknown>): Promise<void> {
  if ((await sendBatch(db, deps, batchId, task)) === "busy") {
    throw new Error(`ai batch ${batchId} is being sent by another job (lease not run out yet); retry later`);
  }
}

/**
 * The batch of a retried stage job: an unsent one is sent; one a dead letter failed before it was sent is revived
 * first (a manual retry; its reservation must fit the budget again), unless an admin ended the run.
 */
async function reuseBatch(
  db: Db,
  deps: BatchDeps,
  task: ModelTask<unknown, unknown>,
  batch: BatchRow,
): Promise<{ batchId: string; items: number; reused: true }> {
  const reused = { batchId: batch.id, items: batch.requestCount, reused: true as const };
  let current: BatchRow | undefined = batch;
  if (batch.status === "failed") {
    if (batch.providerBatchId !== null || (await isRunEnded(db, batch.runId))) return reused;
    // Failing ended its reservation: it takes it again only if it fits (ruling M4-C-R5).
    const config = deps.config ?? getConfig();
    current = await db.transaction(async (tx) => {
      await lockBudget(tx);
      await assertBatchBudget(tx, Number(batch.estimatedCostEur ?? 0), config, nowOf(deps), deps.reservationScope);
      return reviveBatch(tx, batch);
    });
    if (!current) return reused;
  }
  if (isUnsent(current.status)) await sendOrThrow(db, deps, current.id, task);
  return reused;
}

/**
 * Sends an unsent batch from a poll job (a follow-up batch, or one revived by a manual retry) after checking that its
 * reservation still fits today's budget. Over the budget, or while another sender's lease runs, a `send` poll is
 * scheduled for later instead (`deferred`), so only this batch waits, not the whole poll queue.
 */
async function sendFromPoll(db: Db, deps: BatchDeps, batch: BatchRow, task: ModelTask<unknown, unknown>): Promise<"sent" | "deferred" | "none"> {
  const config = deps.config ?? getConfig();
  const now = nowOf(deps);
  const defer = async (delaySeconds: number, slot: string) => {
    await enqueueBatchJob(deps.boss, { key: `send:${batch.id}:${slot}`, batchId: batch.id, mode: "send" }, delaySeconds);
    return "deferred" as const;
  };
  try {
    await assertSendBudget(db, deps);
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    const delay = config.models.batch.budgetRetrySeconds;
    getLog().warn({ batchId: batch.id, spentEur: err.spentEur, budgetEur: err.budgetEur }, "batch send put off: anthropic budget reached");
    return defer(delay, String(Math.floor(now.getTime() / (delay * 1000))));
  }
  let result: SendResult;
  try {
    result = await sendBatch(db, deps, batch.id, task);
  } catch (err) {
    // The adapter's own budget check (spend booked since ours): `sendBatch` gave the claim back, only this batch waits.
    if (!(err instanceof BudgetExceeded)) throw err;
    const delay = config.models.batch.budgetRetrySeconds;
    getLog().warn({ batchId: batch.id, spentEur: err.spentEur, budgetEur: err.budgetEur }, "batch send refused by the adapter budget check, put off");
    return defer(delay, String(Math.floor(now.getTime() / (delay * 1000))));
  }
  if (result === "busy") {
    const [row] = await db.select({ leaseUntil: aiBatches.leaseUntil }).from(aiBatches).where(eq(aiBatches.id, batch.id));
    const leaseUntil = row?.leaseUntil ?? now;
    return defer(Math.max(1, Math.ceil((leaseUntil.getTime() - now.getTime()) / 1000) + 1), `lease:${leaseUntil.getTime()}`);
  }
  return result === "none" ? "none" : "sent";
}

/** Records the unit's outcome and, when that finishes the stage, enqueues the next one, in the caller's transaction. */
async function settleUnit(tx: Db, boss: PgBoss, batch: BatchRow, outcome: "done" | "failed"): Promise<void> {
  const result = await recordJobOutcome(tx, batch.runId, batch.stage, batch.outcomeKey, outcome);
  if (result.nextStage) await enqueueRunAdvance(boss, batch.runId, result.nextStage, tx);
}

/**
 * Stores the results of a collected batch and books it as one `external_calls` row, in the transaction of its
 * conditional transition (ruling M4-P4): `submitted → ended`, or for a failed batch the provider may still bill
 * (`from` `failed`) setting `ended_at` while it stays failed. Only the call that wins the transition books it, and the
 * same transition ends its reservation. Only still pending items take a result: a retryable failure on the first
 * attempt becomes `retried` (resent later), any other failure `failed`. Booking a failed batch also writes the tokens
 * and cost onto items its expiry failed, without changing their status.
 */
async function storeResults(
  db: Db,
  deps: BatchDeps,
  batch: BatchRow,
  collected: CollectedBatch<unknown>,
  from: "submitted" | "failed",
): Promise<void> {
  const now = nowOf(deps);
  await db.transaction(async (tx) => {
    const [won] = await tx
      .update(aiBatches)
      .set({ status: from === "submitted" ? "ended" : "failed", endedAt: now, costEur: collected.costEur.toFixed(6) })
      .where(and(eq(aiBatches.id, batch.id), eq(aiBatches.status, from), isNull(aiBatches.endedAt)))
      .returning({ id: aiBatches.id });
    if (!won) return;
    const results = new Map(collected.results.map((r) => [r.customId, r]));
    const items = await tx
      .select({ id: aiBatchItems.id, attempt: aiBatchItems.attempt, status: aiBatchItems.status })
      .from(aiBatchItems)
      .where(
        and(
          eq(aiBatchItems.batchId, batch.id),
          from === "failed"
            ? sql`(${aiBatchItems.status} = 'pending' or (${aiBatchItems.status} = 'failed' and ${aiBatchItems.costEur} is null))`
            : eq(aiBatchItems.status, "pending"),
        ),
      );
    for (const item of items) {
      const r = results.get(item.id) ?? { customId: item.id, ok: false as const, error: ERROR_NO_RESULT, retryable: true };
      // Input tokens of an item: uncached, cache-written and cache-read input together.
      const tokens = r.usage
        ? { inputTokens: r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens, outputTokens: r.usage.outputTokens }
        : {};
      const costEur = r.costEur !== undefined ? { costEur: r.costEur.toFixed(6) } : {};
      if (item.status === "failed") {
        // Failed already (its batch expired): it keeps its status and error, but carries what it was billed, so the
        // cost per subject sums every billed attempt (ruling M4-G-R3).
        if (r.usage || r.costEur !== undefined) await tx.update(aiBatchItems).set({ ...tokens, ...costEur }).where(eq(aiBatchItems.id, item.id));
        continue;
      }
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

/**
 * Hands every successful, not yet distributed item to the handler, each in its own transaction, at most once. An item
 * whose handler throws keeps its error (`distribution_error`) and the others still go out; when any failed, this
 * throws once at the end, so the poll is retried for the failed items only.
 */
async function distribute(db: Db, deps: BatchDeps, batch: BatchRow, handle: BatchHandler): Promise<void> {
  const ids = await db
    .select({ id: aiBatchItems.id })
    .from(aiBatchItems)
    .where(and(eq(aiBatchItems.batchId, batch.id), eq(aiBatchItems.status, "succeeded"), isNull(aiBatchItems.distributedAt)))
    .orderBy(aiBatchItems.id);
  const failures: Array<{ id: string; error: string }> = [];
  const handlerCtx: BatchHandlerContext = { config: deps.config ?? getConfig() };
  for (const { id } of ids) {
    try {
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
        }, handlerCtx);
        await tx
          .update(aiBatchItems)
          .set({ distributedAt: nowOf(deps), distributionError: null })
          .where(eq(aiBatchItems.id, id));
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ id, error });
      await db
        .update(aiBatchItems)
        .set({ distributionError: error })
        .where(and(eq(aiBatchItems.id, id), isNull(aiBatchItems.distributedAt)));
    }
  }
  if (failures.length > 0) {
    getLog().warn({ batchId: batch.id, failed: failures.length, items: ids.length, first: failures[0] }, "batch items not distributed");
    throw new Error(`${failures.length} of ${ids.length} items of batch ${batch.id} could not be distributed; first: ${failures[0]!.error}`);
  }
}

/**
 * Closes a distributed batch (ruling M4-P3): in one transaction the batch becomes `distributed` and either its
 * `retried` items move into a follow-up batch of the same unit (attempt 2, `submitting`, sent after the commit), or
 * the unit is done. Only when no successful item is left undistributed.
 */
async function closeBatch(db: Db, deps: BatchDeps, batch: BatchRow, entry: BatchHandlerEntry): Promise<void> {
  await db.transaction(async (tx) => {
    const [closed] = await tx
      .update(aiBatches)
      .set({ status: "distributed" })
      .where(
        and(
          eq(aiBatches.id, batch.id),
          eq(aiBatches.status, "ended"),
          sql`not exists (select 1 from ${aiBatchItems} where ${aiBatchItems.batchId} = ${batch.id}
            and ${aiBatchItems.status} = 'succeeded' and ${aiBatchItems.distributedAt} is null)`,
        ),
      )
      .returning({ id: aiBatches.id });
    if (!closed) return;
    await reportFailedItems(tx, batch, entry);
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
        ...(deps.now ? { createdAt: nowOf(deps) } : {}),
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
 * Hands items of the batch to the entry's fail handler, in the caller's transaction; only called by the transaction
 * that wins the batch's transition (at least once per item, see `BatchFailHandler`):
 * - `failed`: the items that failed for good (close, expiry);
 * - `undistributed`: every item that will not be distributed any more because the batch is given up (run ended by an
 *   admin, dead letter): failed, retried or pending ones and successful ones not yet distributed (billed all the same).
 */
async function reportFailedItems(
  tx: Db,
  batch: BatchRow,
  entry: BatchHandlerEntry | undefined,
  scope: "failed" | "undistributed" = "failed",
  reason?: string,
): Promise<void> {
  if (!entry?.fail) return;
  const which =
    scope === "failed"
      ? eq(aiBatchItems.status, "failed")
      : sql`(${aiBatchItems.status} <> 'succeeded' or ${aiBatchItems.distributedAt} is null)`;
  const failed = await tx
    .select()
    .from(aiBatchItems)
    .where(and(eq(aiBatchItems.batchId, batch.id), which))
    .orderBy(aiBatchItems.id);
  for (const item of failed) {
    await entry.fail(tx, {
      id: item.id,
      subjectType: item.subjectType,
      subjectId: item.subjectId,
      error: item.error ?? item.distributionError ?? reason ?? null,
      usage: { inputTokens: item.inputTokens ?? 0, outputTokens: item.outputTokens ?? 0 },
      costEur: Number(item.costEur ?? 0),
      batch: { id: batch.id, model: batch.model, promptVersion: batch.promptVersion, runId: batch.runId, stage: batch.stage },
    });
  }
}

/** Booking poll of a batch (mode `book`), `delaySeconds` from now, in the caller's transaction when given. */
async function enqueueBooking(boss: PgBoss, batchId: string, n: number, delaySeconds: number, tx?: Db): Promise<void> {
  await enqueueBatchJob(boss, { key: `book:${batchId}:${n}`, batchId, n, mode: "book" }, delaySeconds, tx);
}

/**
 * Gives up on a batch the provider has not finished within `maxHours`: the batch and its open items fail and the
 * unit is recorded as failed, once. The provider may still bill it, so a booking poll cancels and books it.
 */
async function expireBatch(db: Db, deps: BatchDeps, batch: BatchRow, entry: BatchHandlerEntry | undefined): Promise<void> {
  await db.transaction(async (tx) => {
    const [failed] = await tx
      .update(aiBatches)
      .set({ status: "failed" })
      .where(and(eq(aiBatches.id, batch.id), eq(aiBatches.status, "submitted")))
      .returning({ pollCount: aiBatches.pollCount });
    if (!failed) return;
    await tx
      .update(aiBatchItems)
      .set({ status: "failed", error: ERROR_MAX_HOURS })
      .where(and(eq(aiBatchItems.batchId, batch.id), eq(aiBatchItems.status, "pending")));
    await reportFailedItems(tx, batch, entry);
    await settleUnit(tx, deps.boss, batch, "failed");
    await enqueueBooking(deps.boss, batch.id, failed.pollCount, 0, tx);
  });
  getLog().warn({ batchId: batch.id, providerBatchId: batch.providerBatchId }, "batch exceeded maxHours, unit failed");
}

/**
 * Puts a batch the dead-letter handler failed back into the state it failed in, so a manual retry continues it: not
 * yet sent (`submitting`, or `sending` with its stale claim when a send was attempted, so the provider list is checked
 * first), sent but not collected (`submitted`, items still pending) or collected (`ended`). A batch failed for
 * running past `maxHours` (its items failed) stays failed. Returns the revived row, or nothing when the row changed
 * since `batch` was read. Exported for tests.
 */
export async function reviveBatch(db: Db, batch: BatchRow): Promise<BatchRow | undefined> {
  let status: "submitting" | "sending" | "submitted" | "ended";
  if (batch.endedAt !== null) status = "ended";
  else {
    const [pending] = await db
      .select({ id: aiBatchItems.id })
      .from(aiBatchItems)
      .where(and(eq(aiBatchItems.batchId, batch.id), eq(aiBatchItems.status, "pending")))
      .limit(1);
    if (!pending) return undefined;
    if (batch.providerBatchId !== null) status = "submitted";
    else status = batch.claimId === null ? "submitting" : "sending";
  }
  // Guarded on `ended_at` as read: a booking poll that collected the batch meanwhile wins (the batch stays failed, a
  // later retry revives it as collected), so a revived running batch never carries results already stored.
  const [revived] = await db
    .update(aiBatches)
    .set({ status })
    .where(
      and(
        eq(aiBatches.id, batch.id),
        eq(aiBatches.status, "failed"),
        status === "ended" ? sql`${aiBatches.endedAt} is not null` : isNull(aiBatches.endedAt),
      ),
    )
    .returning();
  if (revived) getLog().info({ batchId: batch.id, status }, "failed batch revived");
  return revived;
}

/**
 * After a batch is distributed: sends its follow-up batch when that is still waiting to be sent (also when a
 * dead-lettered poll job failed it and is retried by hand). Returns `resubmitted` when the batch had a follow-up,
 * `waiting` when its send was put off.
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
  const current =
    followUp.status === "failed"
      ? await db.transaction(async (tx) => {
          const revived = await reviveBatch(tx, followUp);
          if (revived?.status === "submitted") {
            // Revived as sent: its own poll chain ended with the dead letter (whose job id the chain id would collide
            // with), so it gets a poll of its own in the revive's transaction (no revived batch without its poll),
            // which continues the chain from the batch's poll count. Each revival has its own key: a revived poll that
            // dead-letters again before advancing the poll count must not reuse the id of the first revive poll.
            const config = deps.config ?? getConfig();
            await enqueueBatchJob(
              deps.boss,
              { key: `revive:${revived.id}:${revived.pollCount}:${newId()}`, batchId: revived.id },
              config.models.batch.pollSeconds,
              tx,
            );
          }
          return revived;
        })
      : followUp;
  if (current && isUnsent(current.status) && (await sendFromPoll(db, deps, current, entry.task)) === "deferred") return "waiting";
  return "resubmitted";
}

/**
 * Asks the provider once to cancel a batch that will not be distributed or was given up; a failing cancel is logged
 * and tried again by the next poll (the provider ends every batch after 24 h anyway).
 */
async function requestCancel(db: Db, deps: BatchDeps, batch: BatchRow): Promise<void> {
  if (batch.cancelRequestedAt !== null || batch.providerBatchId === null) return;
  try {
    await deps.model.cancelBatch(batch.providerBatchId);
  } catch (err) {
    getLog().warn({ err, batchId: batch.id, providerBatchId: batch.providerBatchId }, "batch cancel failed, retried by the next poll");
    return;
  }
  await db
    .update(aiBatches)
    .set({ cancelRequestedAt: nowOf(deps) })
    .where(and(eq(aiBatches.id, batch.id), isNull(aiBatches.cancelRequestedAt)));
}

/**
 * The next poll of a batch still running at the provider (`poll` chain or `book` chain): one conditional
 * `poll_count + 1` from the poll's own number, so a redelivered poll whose successor is scheduled already does nothing.
 * A regular poll past `maxHours` (from `submitted_at`) expires the batch instead.
 */
async function scheduleNextPoll(
  db: Db,
  deps: BatchDeps,
  batch: BatchRow,
  n: number | undefined,
  kind: "poll" | "book",
  entry?: BatchHandlerEntry,
): Promise<PollResult> {
  const config = deps.config ?? getConfig();
  const now = nowOf(deps);
  const since = batch.submittedAt ?? batch.createdAt;
  if (kind === "poll" && now.getTime() - since.getTime() > config.models.batch.maxHours * 3_600_000) {
    await expireBatch(db, deps, batch, entry);
    return "failed";
  }
  await db.transaction(async (tx) => {
    const [next] = await tx
      .update(aiBatches)
      .set({ pollCount: sql`${aiBatches.pollCount} + 1` })
      .where(
        and(
          eq(aiBatches.id, batch.id),
          eq(aiBatches.status, kind === "poll" ? "submitted" : "failed"),
          eq(aiBatches.pollCount, n ?? batch.pollCount),
        ),
      )
      .returning({ pollCount: aiBatches.pollCount });
    if (!next) return;
    if (kind === "poll") await enqueueBatchPoll(deps.boss, batch.id, next.pollCount, config.models.batch.pollSeconds, tx);
    else await enqueueBooking(deps.boss, batch.id, next.pollCount, config.models.batch.pollSeconds, tx);
  });
  return "waiting";
}

/** A poll whose number is behind the batch's poll count was redelivered: its successor runs the chain. */
const isStalePoll = (batch: BatchRow, n: number | undefined) => n !== undefined && n !== batch.pollCount;

/**
 * Booking poll (mode `book`, ruling M4-C-R5) of a failed batch the provider may still bill (sent, never collected):
 * cancels it at the provider, polls until it ended and then books its cost and stores its results while it stays
 * failed, which ends its reservation. A later manual retry can distribute the stored results.
 */
async function bookFailedBatch(db: Db, deps: BatchDeps, batch: BatchRow, entry: BatchHandlerEntry, n: number | undefined): Promise<PollResult> {
  const config = deps.config ?? getConfig();
  if (batch.status !== "failed") return "waiting";
  if (batch.providerBatchId === null || batch.endedAt !== null || isStalePoll(batch, n)) return "failed";
  await requestCancel(db, deps, batch);
  const collected = await deps.model.collectBatch(entry.task, batch.providerBatchId, { runId: batch.runId, stage: batch.stage, model: batch.model });
  if (collected.status === "in_progress") {
    const since = batch.submittedAt ?? batch.createdAt;
    if (nowOf(deps).getTime() - since.getTime() > config.models.batch.reservationHours * 3_600_000) {
      getLog().error({ batchId: batch.id, providerBatchId: batch.providerBatchId }, "failed batch never ended at the provider: booking given up");
      return "failed";
    }
    await scheduleNextPoll(db, deps, batch, n, "book");
    return "waiting";
  }
  await storeResults(db, deps, batch, collected, "failed");
  getLog().info({ batchId: batch.id, costEur: collected.costEur }, "failed batch booked");
  return "failed";
}

/**
 * A poll of a run an admin ended (ruling M4-C-R6): nothing is sent or distributed any more. An unsent batch fails; a
 * running one is cancelled at the provider and polled until it ended, then booked (what the provider billed) and
 * failed; a collected one fails. The items of a batch it fails go to the fail handler (`undistributed`).
 */
async function pollEndedRun(db: Db, deps: BatchDeps, batch: BatchRow, entry: BatchHandlerEntry, n: number | undefined): Promise<PollResult> {
  if (batch.status === "submitted") {
    if (isStalePoll(batch, n)) return "waiting";
    await requestCancel(db, deps, batch);
    const collected = await deps.model.collectBatch(entry.task, batch.providerBatchId!, { runId: batch.runId, stage: batch.stage, model: batch.model });
    if (collected.status === "in_progress") return scheduleNextPoll(db, deps, batch, n, "poll", entry);
    await storeResults(db, deps, batch, collected, "submitted");
  }
  const failed = await db.transaction(async (tx) => {
    const rows = await tx
      .update(aiBatches)
      .set({ status: "failed" })
      .where(and(eq(aiBatches.id, batch.id), inArray(aiBatches.status, ["submitting", "sending", "ended"])))
      .returning();
    // Nothing of it is distributed any more: every item that is not goes to the fail handler (ruling M4-G-R3).
    if (rows[0]) await reportFailedItems(tx, rows[0], entry, "undistributed", ERROR_RUN_ENDED);
    return rows;
  });
  if (failed.length > 0) getLog().info({ batchId: batch.id, runId: batch.runId }, "run ended by admin, batch not distributed");
  return "failed";
}

/**
 * One poll of a batch (job `ai.batch.poll`):
 * 1. still running at the provider: schedules the next poll (job id from `batchId:poll_count`; a redelivered poll
 *    with a stale `n` does nothing), or after `maxHours` fails the batch and its unit;
 * 2. ended: stores the results and books the cost (once);
 * 3. hands each successful item to the task's handler (once), past items whose handler fails;
 * 4. closes the batch: a follow-up batch for retryable failures, sent right away, or the unit is done.
 * Each step can be repeated after a crash or by a doubled job without effect. A failed batch is revived (manual
 * retry of a dead-lettered poll), except by `send` and `book` polls. Mode `book` books a failed batch the provider may
 * still bill. A run an admin ended is checked first: nothing is sent or distributed for it any more.
 */
export async function pollBatch(
  db: Db,
  deps: BatchDeps & { handlers: Record<string, BatchHandlerEntry> },
  batchId: string,
  opts: PollOptions = {},
): Promise<PollResult> {
  return pollOnce(db, deps, batchId, opts, 0);
}

/** `pollBatch`; `depth` counts the re-reads after another actor changed the batch mid-poll (at most one). */
async function pollOnce(
  db: Db,
  deps: BatchDeps & { handlers: Record<string, BatchHandlerEntry> },
  batchId: string,
  opts: PollOptions,
  depth: number,
): Promise<PollResult> {
  let batch: BatchRow | undefined = (await db.select().from(aiBatches).where(eq(aiBatches.id, batchId)))[0];
  if (!batch) throw new Error(`ai batch ${batchId} does not exist`);
  const entry = deps.handlers[batch.task];
  if (!entry) throw new Error(`No batch handler for task ${batch.task}`);

  if (opts.mode === "book") return bookFailedBatch(db, deps, batch, entry, opts.n);
  if (await isRunEnded(db, batch.runId)) return pollEndedRun(db, deps, batch, entry, opts.n);

  let n = opts.n;
  if (batch.status === "failed") {
    if (opts.mode === "send") return "failed";
    batch = await reviveBatch(db, batch);
    if (!batch) return "failed";
    // A revived batch continues its chain from wherever it stands.
    n = undefined;
  }
  if (isUnsent(batch.status)) {
    // Revived before it was ever sent, or put off; otherwise its submitter sends it and schedules the first poll.
    await sendFromPoll(db, deps, batch, entry.task);
    return "waiting";
  }
  if (opts.mode === "send") return "waiting";
  if (batch.status === "distributed") return continueUnit(db, deps, batch, entry);

  if (batch.status === "submitted") {
    if (isStalePoll(batch, n)) return "waiting";
    const collected = await deps.model.collectBatch(entry.task, batch.providerBatchId!, {
      runId: batch.runId,
      stage: batch.stage,
      model: batch.model,
    });
    if (collected.status === "in_progress") return scheduleNextPoll(db, deps, batch, n, "poll", entry);
    await storeResults(db, deps, batch, collected, "submitted");
    [batch] = await db.select().from(aiBatches).where(eq(aiBatches.id, batchId));
    if (batch!.status !== "ended") {
      // Another actor (a concurrent poll, a run end, a dead letter) moved the batch: continue from its new state once.
      if (depth === 0 && batch!.status !== "submitted") return pollOnce(db, deps, batchId, {}, depth + 1);
      throw new Error(`ai batch ${batchId} is ${batch!.status} after its results were collected; poll retried later`);
    }
  }

  await distribute(db, deps, batch!, entry.handle);
  await closeBatch(db, deps, batch!, entry);
  return continueUnit(db, deps, batch!, entry);
}

/**
 * Dead-letter branch for an `ai.batch.poll` job (ruling M4-P2), in the dead-letter transaction: fails the open batch
 * of the job's unit (the batch itself or its follow-up) and records the unit as failed, so the stage can finish.
 * A failed batch the provider may still bill keeps its reservation and gets a booking poll (ruling M4-C-R5).
 * A manual retry of the poll job revives the batch and, once distributed, turns the outcome into `done`. With the
 * handler table (passed in by the worker's composition root, ruling M4-P1), every item of a batch it fails that is not
 * distributed goes to its task's fail handler (ruling M4-G-R3).
 */
export async function failBatchUnit(tx: Db, boss: PgBoss, batchId: string, handlers?: Record<string, BatchHandlerEntry>): Promise<boolean> {
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
    .returning();
  // No open batch: the unit already has its outcome (done, or failed after maxHours).
  if (failed.length === 0) return false;
  for (const f of failed) {
    if (f.providerBatchId !== null && f.endedAt === null) await enqueueBooking(boss, f.id, f.pollCount, 0, tx);
    await reportFailedItems(tx, f, handlers?.[f.task], "undistributed", ERROR_DEAD_LETTER);
  }
  await settleUnit(tx, boss, batch, "failed");
  return true;
}

/**
 * Dead-letter branch for a stage job (ruling M4-C-R6), in the dead-letter transaction: a batch of its unit
 * `batch:<key>` that was never sent (`submitting`, `sending`) fails, which ends its reservation, and the unit is
 * recorded as failed, so the stage can finish. A manual retry of the job revives and sends it. Returns whether a batch
 * failed. With the handler table, its items go to their task's fail handler (as in `failBatchUnit`).
 */
export async function failSubmitUnit(
  tx: Db,
  boss: PgBoss,
  job: { runId: string; stage: string; key: string },
  handlers?: Record<string, BatchHandlerEntry>,
): Promise<boolean> {
  const failed = await tx
    .update(aiBatches)
    .set({ status: "failed" })
    .where(
      and(
        eq(aiBatches.runId, job.runId),
        eq(aiBatches.stage, job.stage),
        eq(aiBatches.outcomeKey, batchOutcomeKey(job.key)),
        inArray(aiBatches.status, [...UNSENT_STATUSES]),
      ),
    )
    .returning();
  if (failed.length === 0) return false;
  for (const f of failed) await reportFailedItems(tx, f, handlers?.[f.task], "undistributed", ERROR_DEAD_LETTER);
  await settleUnit(tx, boss, failed[0]!, "failed");
  getLog().warn({ runId: job.runId, stage: job.stage, key: job.key, batchId: failed[0]!.id }, "submit job failed, its unsent batch failed");
  return true;
}

/**
 * "Lauf beenden" for batches (rulings M4-C-R4, R6), after `endRun` has committed and touching only `ai_batches` (lock
 * order: never inside the run's transaction): unsent batches fail, which ends their reservation (a send whose call
 * returns later is still recorded and then cancelled); every running batch gets an immediate poll, which cancels it at
 * the provider, books what it billed and fails it.
 */
export async function endRunBatches(db: Db, boss: PgBoss, runId: string): Promise<{ failed: number; cancelling: number }> {
  return db.transaction(async (tx) => {
    const failed = await tx
      .update(aiBatches)
      .set({ status: "failed" })
      .where(and(eq(aiBatches.runId, runId), inArray(aiBatches.status, [...UNSENT_STATUSES])))
      .returning({ id: aiBatches.id });
    const running = await tx
      .select({ id: aiBatches.id })
      .from(aiBatches)
      .where(and(eq(aiBatches.runId, runId), eq(aiBatches.status, "submitted")));
    for (const { id } of running) await enqueueBatchJob(boss, { key: `end:${id}`, batchId: id }, 0, tx);
    return { failed: failed.length, cancelling: running.length };
  });
}
