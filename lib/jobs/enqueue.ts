import { sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { v5 as uuidv5 } from "uuid";
import type { Db } from "@/lib/db/client";
import { BATCH_POLL_QUEUE, QUEUES, RUN_ADVANCE_QUEUE, type QueueName } from "./queues";
import type { JobData } from "./worker";

// Kept apart from lib/pipeline/runs (which reaches the stage registry and thereby every handler), so job
// handlers can enqueue follow-up jobs without an import cycle (ruling M3-P1).

/** Fixed namespace for deterministic job ids (UUIDv5 of `runId:stage:key`). */
const JOB_ID_NAMESPACE = "5b0e6f3c-2f6a-4c1e-9d7b-8a1f4e2c9b30";

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

/**
 * What an `ai.batch.poll` job does with its batch:
 * - no mode: the regular poll (also the manual retry of a dead-lettered one); `n` is its place in the poll chain;
 * - `send`: sends a batch whose send was put off (budget, a lease held by another sender), never revives it;
 * - `book`: cancels a failed batch the provider may still bill and books its cost once it ended (ruling M4-C-R5).
 */
export type BatchPollMode = "send" | "book";

/**
 * Job data of an `ai.batch.poll` job: deliberately without `runId` and `stage`, so the worker records no stage outcome
 * for it and an admin's "Lauf beenden" does not cancel it (the batch is still booked when it ends; ruling M4-P2).
 */
export type BatchPollData = { key: string; batchId: string; n?: number; mode?: BatchPollMode };

/**
 * Enqueues poll number `n` of a batch's regular poll chain, `delaySeconds` from now, in the caller's transaction when
 * given. Its id (UUIDv5 of `batchId:n`) makes a repeated enqueue of the same poll a no-op; `n` travels in the data, so
 * a redelivered poll whose successor exists already does nothing (ruling M4-C-R6).
 */
export async function enqueueBatchPoll(boss: PgBoss, batchId: string, n: number, delaySeconds: number, tx?: Db): Promise<void> {
  const data: BatchPollData = { key: `poll:${batchId}:${n}`, batchId, n };
  await boss.insert(
    BATCH_POLL_QUEUE,
    [{ id: uuidv5(`${batchId}:${n}`, JOB_ID_NAMESPACE), data, startAfter: `${delaySeconds} seconds` }],
    tx ? { db: fromDrizzle(tx, sql) } : {},
  );
}

/**
 * Enqueues an `ai.batch.poll` job outside the regular chain (`key` e.g. `send:<id>:<slot>`, `book:<id>:<n>`,
 * `end:<id>`), `delaySeconds` from now; the job id is derived from `key`, so a repeated enqueue is a no-op.
 */
export async function enqueueBatchJob(
  boss: PgBoss,
  job: { key: string; batchId: string; n?: number; mode?: BatchPollMode },
  delaySeconds: number,
  tx?: Db,
): Promise<void> {
  const data: BatchPollData = { ...job };
  await boss.insert(
    BATCH_POLL_QUEUE,
    [{ id: uuidv5(job.key, JOB_ID_NAMESPACE), data, startAfter: `${delaySeconds} seconds` }],
    tx ? { db: fromDrizzle(tx, sql) } : {},
  );
}

/**
 * Cancels every job of the run that has not started yet (created or waiting for a retry) on every queue, including
 * budget-deferred copies and `run.advance`; returns how many. Jobs already active finish on their own (the worker
 * skips the handler of a job whose run an admin ended).
 */
export async function cancelRunJobs(boss: PgBoss, runId: string): Promise<number> {
  let cancelled = 0;
  for (const queue of QUEUES) {
    for (;;) {
      const jobs = await boss.findJobs<JobData>(queue, { data: { runId }, queued: true, limit: 1000 });
      if (jobs.length === 0) break;
      await boss.cancel(
        queue,
        jobs.map((j) => j.id),
      );
      cancelled += jobs.length;
      if (jobs.length < 1000) break;
    }
  }
  return cancelled;
}
