import { sql } from "drizzle-orm";
import { fromDrizzle, type Job, type JobWithMetadata, type PgBoss } from "pg-boss";
import type { Logger } from "pino";
import type { QueueConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { BudgetExceeded } from "@/lib/domain/costs";
import { errorText, lockFailedJob } from "@/lib/domain/jobs-view";
import { createReviewTask } from "@/lib/domain/review";
import { failRun, isRunEnded, recordJobOutcome } from "@/lib/domain/runs";
import { createLogger } from "@/lib/logger";
import { failBatchUnit, failSubmitUnit, type BatchHandlerEntry } from "@/lib/pipeline/batches";
import { runEnded } from "@/lib/pipeline/run-ended";
import { isQueuePaused, pauseForBudget } from "./controls";
import { enqueueRunAdvance } from "./enqueue";
import { BATCH_POLL_QUEUE, DEAD_LETTER_QUEUE, QUEUES, RUN_ADVANCE_QUEUE, type QueueName } from "./queues";

export type JobContext = { db: Db; boss: PgBoss; log: Logger; jobId: string; runId?: string };
export type JobHandler<T> = (data: T, ctx: JobContext) => Promise<void>;
export type JobData = { runId?: string; stage?: string; key: string; [k: string]: unknown };

export type WorkerOptions = {
  /** pg-boss polling interval per queue (default 2 s). */
  pollingIntervalSeconds?: number;
  /** How often queue_controls is checked (default 30 s). */
  controlPollMs?: number;
  /**
   * The batch handler table (`BATCH_HANDLERS`), passed in by the composition root (`worker/index.ts`) so this module
   * never imports it (ruling M4-P1): a dead-lettered batch or stage job hands the items it gives up to their task's
   * fail handler (ruling M4-G-R3). Without it nothing is reported.
   */
  batchHandlers?: Record<string, BatchHandlerEntry>;
};

/** Marks a job re-sent after a budget pause, so a manual resume can release it early. */
const BUDGET_DEFERRED = "budgetDeferred";
/** Attempts a job used before it was re-sent after budget pauses; the re-sent job gets only the rest. */
const PRIOR_ATTEMPTS = "priorAttempts";

/**
 * Starts one pg-boss worker per queue in QUEUES plus the dead-letter worker. Each handler is wrapped:
 * success records a `done` outcome and, when it finishes the current stage, enqueues a `run.advance`
 * job for the next one (so a failing transition never fails the job itself);
 * `BudgetExceeded` pauses the queue and defers the job (the failing attempt is not counted, earlier
 * ones are; no outcome); any other error is rethrown so pg-boss retries and finally dead-letters the job.
 * A job of a run an admin ended ("Lauf beenden") does nothing and records no outcome.
 */
export async function startWorkers(
  boss: PgBoss,
  db: Db,
  handlers: Record<QueueName, JobHandler<JobData>>,
  config: Record<string, QueueConfig>,
  options: WorkerOptions = {},
): Promise<{ stop(): Promise<void> }> {
  const log = createLogger("worker");
  const pollingIntervalSeconds = options.pollingIntervalSeconds ?? 2;
  const controlPollMs = options.controlPollMs ?? 30_000;

  /**
   * Records the outcome (once per job key) and, if it finished the stage, enqueues the `run.advance` job
   * in the same transaction. Jobs without `stage` (e.g. `run.advance` itself) record nothing.
   */
  async function settle(tx: Db, data: JobData, outcome: "done" | "failed"): Promise<void> {
    if (!data.runId || !data.stage) return;
    const result = await recordJobOutcome(tx, data.runId, data.stage, data.key, outcome);
    if (result.nextStage) await enqueueRunAdvance(boss, data.runId, result.nextStage, tx);
    // finished after its last stage, or failed by a stage whose jobs all failed (`runEnded`, e.g. the build queue)
    if (result.runFinished) await runEnded(tx, boss, data.runId);
  }

  async function deferForBudget(queue: QueueName, job: Job<JobData>, err: BudgetExceeded): Promise<void> {
    const priorAttempts = (typeof job.data[PRIOR_ATTEMPTS] === "number" ? job.data[PRIOR_ATTEMPTS] : 0) + job.retryCount;
    const retryLimit = Math.max(0, (config[queue]?.retryLimit ?? 0) - priorAttempts);
    await db.transaction(async (tx) => {
      const until = await pauseForBudget(tx, err, [queue]);
      // Same data, no singletonKey: the original job still holds it until this handler returns.
      await boss.send(
        queue,
        { ...job.data, [BUDGET_DEFERRED]: true, [PRIOR_ATTEMPTS]: priorAttempts },
        { startAfter: until, retryLimit, db: fromDrizzle(tx, sql) },
      );
    });
    log.warn({ queue, jobId: job.id, service: err.service, priorAttempts }, "budget exceeded, queue paused and job deferred");
    void syncControls();
  }

  async function runJob(queue: QueueName, job: Job<JobData>): Promise<void> {
    const ctx: JobContext = {
      db,
      boss,
      log: log.child({ queue, jobId: job.id, runId: job.data.runId }),
      jobId: job.id,
      runId: job.data.runId,
    };
    if (job.data.runId && (await isRunEnded(db, job.data.runId))) {
      ctx.log.info("run ended by admin, job skipped");
      return;
    }
    try {
      await handlers[queue](job.data, ctx);
    } catch (err) {
      if (err instanceof BudgetExceeded) return deferForBudget(queue, job, err);
      ctx.log.warn({ err, attempt: job.retryCount + 1 }, "job attempt failed");
      throw err;
    }
    await db.transaction((tx) => settle(tx, job.data, "done"));
  }

  /**
   * Opens the failed_job review task (context with `sourceId` when the job data names one) and records the
   * failure; a `run.advance` job that is still failed fails its run.
   * Errors are logged and rethrown, so system.dead retries the job and, once its attempts are used up,
   * keeps it as `failed` where the overview and jobs views count it.
   */
  async function handleDeadLetter(job: JobWithMetadata<JobData>): Promise<void> {
    const jobId = job.sourceId ?? job.id;
    const runId = job.data.runId;
    const queue = job.sourceName ?? "unknown";
    const error = errorText(job.sourceOutput);
    try {
      await db.transaction(async (tx) => {
        const task = await createReviewTask(tx, {
          kind: "failed_job",
          subjectType: "job",
          subjectId: jobId,
          context: {
            queue,
            key: job.data.key,
            runId,
            stage: job.data.stage,
            error,
            // Offers "pause source" in the review of a job that worked on one source.
            ...(typeof job.data.sourceId === "string" ? { sourceId: job.data.sourceId } : {}),
          },
        });
        // A failed transition fails its run every time: after a manual retry resumed the run, the task of
        // the first failure may still be open. Only while the source job is still failed, though: a late or
        // repeated delivery after a retry must not fail the resumed or finished run.
        if (queue === RUN_ADVANCE_QUEUE && runId && (await lockFailedJob(tx, queue, jobId))) {
          await failRun(tx, runId, `stage transition failed: ${error}`);
          await runEnded(tx, boss, runId);
        }
        // Only the call that opened the task records the failure, so a retried dead-letter job counts once.
        if (!task.created) return;
        await settle(tx, job.data, "failed");
        // A poll job carries no stage: its batch's unit fails instead, so the stage does not wait for it forever.
        if (queue === BATCH_POLL_QUEUE && typeof job.data.batchId === "string") await failBatchUnit(tx, boss, job.data.batchId, options.batchHandlers);
        // A stage job that stored a batch but never got it sent: that batch and its unit fail too (ruling M4-C-R6).
        if (runId && job.data.stage) await failSubmitUnit(tx, boss, { runId, stage: job.data.stage, key: job.data.key }, options.batchHandlers);
      });
    } catch (err) {
      log.error({ err, jobId, runId, deadLetterJobId: job.id, attempt: job.retryCount + 1 }, "dead-letter handling failed");
      throw err;
    }
    log.error({ queue, jobId, runId, key: job.data.key, error }, "job failed permanently");
  }

  /** Pulls budget-deferred jobs forward once their queue runs again (e.g. after a manual resume). */
  async function releaseDeferred(queue: QueueName): Promise<void> {
    const deferred = await boss.findJobs<JobData>(queue, { data: { [BUDGET_DEFERRED]: true }, queued: true });
    const now = new Date();
    for (const job of deferred) {
      if (job.startAfter.getTime() > now.getTime()) await boss.update(queue, undefined, { id: job.id, startAfter: now });
    }
  }

  const active = new Set<QueueName>();
  let syncing: Promise<void> = Promise.resolve();
  let stopped = false;

  async function syncOnce(): Promise<void> {
    for (const queue of QUEUES) {
      if (stopped) return;
      const paused = await isQueuePaused(db, queue);
      if (paused && active.has(queue)) {
        active.delete(queue);
        await boss.offWork(queue, { wait: false });
        log.info({ queue }, "queue paused, worker stopped");
      } else if (!paused && !active.has(queue)) {
        await releaseDeferred(queue);
        await boss.work<JobData>(
          queue,
          { localConcurrency: config[queue]?.concurrency ?? 1, pollingIntervalSeconds },
          async (jobs) => {
            for (const job of jobs) await runJob(queue, job);
          },
        );
        active.add(queue);
        log.info({ queue }, "queue worker started");
      }
    }
  }

  /** Serialised so overlapping timer ticks and budget triggers never double-start a queue. */
  function syncControls(): Promise<void> {
    syncing = syncing.then(syncOnce).catch((err: unknown) => log.error({ err }, "queue control sync failed"));
    return syncing;
  }

  await boss.work<JobData, unknown, { includeMetadata: true; pollingIntervalSeconds: number }>(
    DEAD_LETTER_QUEUE,
    { includeMetadata: true, pollingIntervalSeconds },
    async (jobs) => {
      for (const job of jobs) await handleDeadLetter(job);
    },
  );
  await syncControls();
  const timer = setInterval(() => void syncControls(), controlPollMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await syncing;
      for (const queue of [...active, DEAD_LETTER_QUEUE]) await boss.offWork(queue, { wait: true });
      active.clear();
    },
  };
}
