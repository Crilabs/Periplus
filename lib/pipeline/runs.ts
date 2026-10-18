import { eq, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { v5 as uuidv5 } from "uuid";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { beginStage, createRun } from "@/lib/domain/runs";
import { STAGES } from "@/lib/jobs/registry";
import { RUN_ADVANCE_QUEUE, type QueueName } from "@/lib/jobs/queues";
import type { JobData } from "@/lib/jobs/worker";

export type StageDefinition = {
  name: string;
  queue: QueueName;
  plan(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]>;
};

/** Fixed namespace for deterministic job ids (UUIDv5 of `runId:stage:key`). */
const JOB_ID_NAMESPACE = "5b0e6f3c-2f6a-4c1e-9d7b-8a1f4e2c9b30";

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
 * A stage that plans no jobs finishes at once and the following stage is enqueued in its place.
 */
export async function enqueueStage(db: Db, boss: PgBoss, runId: string, stageName: string): Promise<void> {
  let next: string | null = stageName;
  while (next) {
    const stage = stageDefinition(next);
    next = await db.transaction(async (tx) => {
      const [run] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, runId));
      if (!run) throw new Error(`run ${runId} not found`);
      const jobs = await stage.plan(tx, { id: runId, params: (run.params ?? {}) as Record<string, unknown> });
      const begun = await beginStage(tx, runId, stage.name, jobs.length);
      await enqueueStageJobs(boss, stage.queue, runId, stage.name, jobs, tx);
      return begun.nextStage;
    });
  }
}

/**
 * Enqueues jobs of a run stage; returns how many were new. Each job gets `singletonKey`
 * `runId:stage:key` and a job id derived from it, so enqueueing the same job again is a no-op
 * (the queue's `standard` policy alone would not deduplicate by singletonKey).
 */
export async function enqueueStageJobs(
  boss: PgBoss,
  queue: QueueName,
  runId: string,
  stage: string,
  jobs: JobData[],
  tx?: Db,
): Promise<number> {
  if (jobs.length === 0) return 0;
  const ids = await boss.insert(
    queue,
    jobs.map((job) => {
      const singletonKey = `${runId}:${stage}:${job.key}`;
      return { id: uuidv5(singletonKey, JOB_ID_NAMESPACE), singletonKey, data: { ...job, runId, stage } };
    }),
    { returnId: true, ...(tx ? { db: fromDrizzle(tx, sql) } : {}) },
  );
  return ids?.length ?? 0;
}

/** Job data of a `run.advance` job. Deliberately without `stage`, so the worker records no stage outcome for it. */
export type RunAdvanceData = { runId: string; nextStage: string; key: string };

/**
 * Enqueues the job that moves a run to `nextStage`, in the caller's transaction when given. Its id and
 * singletonKey `runId:nextStage` make a repeated enqueue a no-op.
 */
export async function enqueueRunAdvance(boss: PgBoss, runId: string, nextStage: string, tx?: Db): Promise<void> {
  const key = `${runId}:${nextStage}`;
  const data: RunAdvanceData = { runId, nextStage, key };
  await boss.insert(RUN_ADVANCE_QUEUE, [{ id: uuidv5(key, JOB_ID_NAMESPACE), singletonKey: key, data }], {
    ...(tx ? { db: fromDrizzle(tx, sql) } : {}),
  });
}
