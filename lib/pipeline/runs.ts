import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { beginStage, createRun } from "@/lib/domain/runs";
import { STAGES } from "@/lib/jobs/stages";
import { enqueueRunAdvance, enqueueStageJobs } from "@/lib/jobs/enqueue";
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
 */
export async function enqueueStage(db: Db, boss: PgBoss, runId: string, stageName: string): Promise<void> {
  const stage = stageDefinition(stageName);
  await db.transaction(async (tx) => {
    const [run] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, runId));
    if (!run) throw new Error(`run ${runId} not found`);
    const jobs = await stage.plan(tx, { id: runId, params: (run.params ?? {}) as Record<string, unknown> });
    const begun = await beginStage(tx, runId, stage.name, jobs.length);
    await enqueueStageJobs(boss, stage.queue, runId, stage.name, jobs, tx);
    if (begun.nextStage) await enqueueRunAdvance(boss, runId, begun.nextStage, tx);
  });
}
