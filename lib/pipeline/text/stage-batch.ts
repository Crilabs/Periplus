import { and, asc, eq } from "drizzle-orm";
import { estimateBatchItemCostsEur } from "@/lib/ai/cost";
import type { ModelTask } from "@/lib/ai/types";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiBatchItems } from "@/lib/db/schema";
import { BudgetExceeded } from "@/lib/domain/costs";
import { extendStage, stageAcceptsJobs } from "@/lib/domain/runs";
import { enqueueStageJobs } from "@/lib/jobs/enqueue";
import type { QueueName } from "@/lib/jobs/queues";
import { createLogger } from "@/lib/logger";
import { anthropicHeadroomEur, batchOutcomeKey, sizeBatch, submitStageBatch, type BatchDeps, type BatchItemInput } from "@/lib/pipeline/batches";

/*
 * One stage job that sends its subjects as one message batch (classification, disambiguation; ruling M4-C-R2,
 * M4-D-R2): the batch is sized to today's anthropic headroom, what does not fit goes to exactly one follow-on job
 * `<key>+`, and no room at all defers the job (`BudgetExceeded`). A retried job reuses its batch.
 */

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.text.stage-batch"));

export type StageBatchJob = { runId: string; stage: string; key: string };

export type StageBatchRequest = {
  task: ModelTask<unknown, unknown>;
  queue: QueueName;
  job: StageBatchJob;
  /** The job's subjects, in job order. */
  subjectIds: string[];
  /** Of the given subjects, those still to do (in the given order). */
  open: (ids: string[]) => Promise<string[]>;
  /** The batch items of the given subjects, in their order; a subject that cannot be sent is left out. */
  inputs: (ids: string[]) => Promise<BatchItemInput[]>;
  /** The job data of the follow-on job for the remaining subjects (without `key`). */
  remainderData: (ids: string[]) => Record<string, unknown>;
  /** A model replacing the task's configured one (an extraction run's model). */
  modelOverride?: string;
  /** A prompt version replacing the task's configured one (an extraction run's). */
  promptVersionOverride?: number;
};

/** Items of the job's batch unit (a retried job): those of its first batch, and every subject the unit covers. */
async function unitItems(db: Db, job: StageBatchJob): Promise<{ first: BatchItemInput[]; covered: Set<string> } | null> {
  const rows = await db
    .select({ batchId: aiBatches.id, subjectType: aiBatchItems.subjectType, subjectId: aiBatchItems.subjectId, input: aiBatchItems.input })
    .from(aiBatchItems)
    .innerJoin(aiBatches, eq(aiBatches.id, aiBatchItems.batchId))
    .where(and(eq(aiBatches.runId, job.runId), eq(aiBatches.stage, job.stage), eq(aiBatches.outcomeKey, batchOutcomeKey(job.key))))
    .orderBy(asc(aiBatches.id), asc(aiBatchItems.id));
  if (rows.length === 0) return null;
  const firstId = rows[0]!.batchId;
  return {
    first: rows.filter((r) => r.batchId === firstId).map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId, input: r.input })),
    covered: new Set(rows.map((r) => r.subjectId)),
  };
}

/**
 * Hands the remaining subjects of a job that did not fit into its batch to one more job of the stage (key `<key>+`),
 * extending the stage by it, once: its job id comes from the key, so a retried job enqueues nothing.
 */
async function handOnRemainder(db: Db, deps: BatchDeps, req: StageBatchRequest, remainder: string[]): Promise<void> {
  if (remainder.length === 0) return;
  const { job } = req;
  await db.transaction(async (tx) => {
    if (!(await stageAcceptsJobs(tx, job.runId, job.stage))) return;
    const added = await enqueueStageJobs(deps.boss, req.queue, job.runId, job.stage, [{ key: `${job.key}+`, ...req.remainderData(remainder) }], tx);
    if (added > 0 && !(await extendStage(tx, job.runId, job.stage, added))) {
      throw new Error(`stage ${job.stage} of run ${job.runId} stopped running while locked`);
    }
  });
  getLog().info({ runId: job.runId, stage: job.stage, key: job.key, remainder: remainder.length }, "batch sized to the budget, rest handed on");
}

/**
 * Sends the job's open subjects as one message batch (`submitStageBatch`), sized to the budget headroom; never call it
 * inside a transaction (the provider call of `submitStageBatch` must not run in one).
 */
export async function submitStageJobBatch(
  db: Db,
  deps: BatchDeps,
  req: StageBatchRequest,
): Promise<{ submitted: number; remainder: number; reused: boolean }> {
  const config = deps.config ?? getConfig();
  const { job, task } = req;
  const existing = await unitItems(db, job);
  if (existing) {
    await submitStageBatch(db, deps, {
      task,
      runId: job.runId,
      stage: job.stage,
      key: job.key,
      items: existing.first,
      modelOverride: req.modelOverride,
      promptVersionOverride: req.promptVersionOverride,
    });
    const remainder = req.subjectIds.filter((id) => !existing.covered.has(id));
    await handOnRemainder(db, deps, req, remainder);
    return { submitted: existing.first.length, remainder: remainder.length, reused: true };
  }

  const items = await req.inputs(await req.open(req.subjectIds));
  if (items.length === 0) return { submitted: 0, remainder: 0, reused: false };
  const now = deps.now?.() ?? new Date();
  const headroom = await anthropicHeadroomEur(db, config, now, deps.reservationScope);
  const costs = estimateBatchItemCostsEur(config, task, items.map((i) => i.input), req.modelOverride, req.promptVersionOverride);
  const n = sizeBatch(costs, headroom, config.models.batch.maxRequests);
  if (n === 0) {
    const budget = config.budgets.anthropic.dailyEur;
    throw new BudgetExceeded("anthropic", budget - headroom, budget);
  }
  const result = await submitStageBatch(db, deps, {
    task,
    runId: job.runId,
    stage: job.stage,
    key: job.key,
    items: items.slice(0, n),
    modelOverride: req.modelOverride,
    promptVersionOverride: req.promptVersionOverride,
  });
  const remainder = items.slice(n).map((i) => i.subjectId);
  await handOnRemainder(db, deps, req, remainder);
  return { submitted: result.items, remainder: remainder.length, reused: result.reused };
}
