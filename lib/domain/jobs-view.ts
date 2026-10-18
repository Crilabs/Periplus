import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { DEAD_LETTER_QUEUE, type QueueName } from "@/lib/jobs/queues";

export type FailedJob = { id: string; queue: string; key: string; stage: string | null; error: string; failedAt: Date };

/** Readable error of a failed job from its pg-boss output (a serialised Error, a string or anything else). */
export function errorText(output: unknown): string {
  if (output && typeof output === "object" && "message" in output) return String(output.message);
  if (output === null || output === undefined) return "unknown error";
  return typeof output === "string" ? output : JSON.stringify(output);
}

/** False on a fresh installation where the worker has not yet created pg-boss' schema. */
export async function hasPgBossSchema(db: Db): Promise<boolean> {
  const [row] = (await db.execute<{ ready: boolean }>(sql`select to_regclass('pgboss.job') is not null as ready`)).rows;
  return row?.ready === true;
}

/**
 * Jobs of a run that failed for good, newest first, straight from pg-boss' job table. The dead-letter
 * copies in system.dead carry the same data and are left out; a retried job drops out once it is no
 * longer `failed`. Empty while pg-boss' schema does not exist yet.
 */
export async function failedJobsOfRun(db: Db, runId: string): Promise<FailedJob[]> {
  if (!(await hasPgBossSchema(db))) return [];
  const result = await db.execute<{
    id: string;
    name: string;
    key: string | null;
    stage: string | null;
    output: unknown;
    failed_at: string | Date;
  }>(sql`
    select id, name, data->>'key' as key, data->>'stage' as stage, output, coalesce(completed_on, created_on) as failed_at
    from pgboss.job
    where state = 'failed' and data->>'runId' = ${runId} and name <> ${DEAD_LETTER_QUEUE}
    order by failed_at desc, id`);
  return result.rows.map((r) => ({
    id: r.id,
    queue: r.name,
    key: r.key ?? "",
    stage: r.stage,
    error: errorText(r.output),
    failedAt: new Date(r.failed_at),
  }));
}

/**
 * Sends a failed job back to its queue for one more attempt. An open `failed_job` review task stays open;
 * a later success flips the run outcome (see `recordJobOutcome`).
 */
export async function retryFailedJob(boss: PgBoss, queue: QueueName, jobId: string): Promise<void> {
  await boss.retry(queue, jobId);
}
