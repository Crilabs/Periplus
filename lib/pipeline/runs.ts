import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { markConsolidationSkipped } from "@/lib/domain/consolidation/skipped";
import { blockUncheckedRuns } from "@/lib/domain/extraction/run-status";
import { failOpenUnits } from "@/lib/domain/extraction/unit-status";
import { beginStage, createRun, endCleanupPending, endRun, markEndCleanupDone } from "@/lib/domain/runs";
import { STAGES } from "@/lib/jobs/stages";
import { cancelRunJobs, enqueueRunAdvance, enqueueStageJobs } from "@/lib/jobs/enqueue";
import { createLogger } from "@/lib/logger";
import { endRunBatches } from "@/lib/pipeline/batches";
import type { QueueName } from "@/lib/jobs/queues";
import type { JobData } from "@/lib/jobs/worker";

export { enqueueRunAdvance, enqueueStageJobs, type RunAdvanceData } from "@/lib/jobs/enqueue";

export type StageDefinition = {
  name: string;
  queue: QueueName;
  plan(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]>;
};

function stageDefinition(name: string): StageDefinition {
  const stage = STAGES[name];
  if (!stage) throw new Error(`unknown stage ${name}`);
  return stage;
}

/** Creates the run, then plans and enqueues its first stage. */
export async function startRun(
  db: Db,
  boss: PgBoss,
  input: Parameters<typeof createRun>[1],
): Promise<{ id: string }> {
  for (const name of input.stages) stageDefinition(name);
  const { id } = await createRun(db, input);
  if (input.stages.length > 0) await enqueueStage(db, boss, id, input.stages[0]);
  return { id };
}

/**
 * Plans a pending stage, marks it running with its job count and enqueues its jobs in one transaction.
 * A stage that plans no jobs finishes at once; the move to the following stage is then enqueued as its own
 * `run.advance` job in the same transaction, so every stage transition is a separate, retryable job.
 * The run row is locked first: a run that is no longer queued or running (ended by an admin, failed, finished) plans
 * nothing, and „Lauf beenden“ (which updates the same row) waits for a plan in progress, so its cleanup sees the
 * plan's units (ruling GR-8). Returns whether the stage was planned.
 */
export async function enqueueStage(db: Db, boss: PgBoss, runId: string, stageName: string): Promise<boolean> {
  const stage = stageDefinition(stageName);
  return db.transaction(async (tx) => {
    const [run] = await tx.select({ params: runs.params, status: runs.status }).from(runs).where(eq(runs.id, runId)).for("update");
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status !== "queued" && run.status !== "running") {
      createLogger("runs").info({ runId, stage: stageName, status: run.status }, "run no longer active, stage not planned");
      return false;
    }
    const jobs = await stage.plan(tx, { id: runId, params: (run.params ?? {}) as Record<string, unknown> });
    const begun = await beginStage(tx, runId, stage.name, jobs.length);
    await enqueueStageJobs(boss, stage.queue, runId, stage.name, jobs, tx);
    if (begun.nextStage) await enqueueRunAdvance(boss, runId, begun.nextStage, tx);
    return true;
  });
}

/**
 * "Lauf beenden": ends a queued or running run by hand (`endRun`, recording who and when), cancels its jobs that
 * have not started and, after that commit, ends its message batches (`endRunBatches`: unsent ones fail, running ones
 * are cancelled at the provider by their next poll and booked), fails its extraction units that are still open and
 * blocks its extraction runs not checked yet (reason `run_ended`). When every step has run, the cleanup is recorded
 * on the run (`markEndCleanupDone`).
 * A run an admin ended earlier whose cleanup did not complete (a step threw, e.g. the job queue was unreachable) is
 * cleaned up again: every step is idempotent (ruling GR-8). For any other run that has ended nothing happens.
 * `ended`: this call ended the run; `cleanedUp`: this call ran the cleanup.
 */
export async function endRunByAdmin(
  db: Db,
  boss: PgBoss,
  runId: string,
  by: string,
): Promise<{ ended: boolean; cleanedUp: boolean; cancelledJobs: number }> {
  const ended = await endRun(db, runId, by);
  if (!ended && !(await endCleanupPending(db, runId))) return { ended: false, cleanedUp: false, cancelledJobs: 0 };
  const cancelledJobs = await cancelRunJobs(boss, runId);
  const batches = await endRunBatches(db, boss, runId);
  // Its stages never finish now: extraction units still open fail here (ruling M4-G-R3).
  const failedUnits = (await failOpenUnits(db, runId)).length;
  // Nor does its check stage: its unchecked extraction runs are blocked, never left running (ruling M4-H-R3).
  const blockedExtractionRuns = (await blockUncheckedRuns(db, runId, "run_ended")).length;
  // Nor its consolidation, if it has not begun: stored for „Konsolidierung nachholen“ (ruling M5-H-R2).
  await markConsolidationSkipped(db, runId, "run_ended");
  await markEndCleanupDone(db, runId);
  createLogger("runs").info({ runId, by, ended, cancelledJobs, batches, failedUnits, blockedExtractionRuns }, "run ended by admin, cleaned up");
  return { ended, cleanedUp: true, cancelledJobs };
}
