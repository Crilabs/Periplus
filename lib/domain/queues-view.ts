import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { hasPgBossSchema } from "@/lib/domain/jobs-view";
import { isQueuePaused } from "@/lib/jobs/controls";
import { DEAD_LETTER_QUEUE, QUEUES, type QueueName } from "@/lib/jobs/queues";

export type QueueStats = { queued: number; active: number; failed: number; paused: boolean; pausable: boolean };

/** Work queues plus the dead-letter queue, so a stuck or failing dead-letter queue is visible. */
export const VIEW_QUEUES = [...QUEUES, DEAD_LETTER_QUEUE] as const;
export type ViewQueue = QueueName | typeof DEAD_LETTER_QUEUE;
export type JobsView = Record<ViewQueue, QueueStats>;

type Counts = Pick<QueueStats, "queued" | "active" | "failed">;
const ZERO: Counts = { queued: 0, active: 0, failed: 0 };

const isWorkQueue = (queue: ViewQueue): queue is QueueName => (QUEUES as readonly string[]).includes(queue);

/**
 * Live job counts per queue and state; none on a fresh installation where the worker has not yet
 * created pg-boss' schema.
 */
async function countJobs(db: Db): Promise<Array<{ name: string; state: string; n: number }>> {
  if (!(await hasPgBossSchema(db))) return [];
  const result = await db.execute<{ name: string; state: string; n: number }>(
    sql`select name, state::text as state, count(*)::int as n from pgboss.job
        where name in (${sql.join(VIEW_QUEUES.map((q) => sql`${q}`), sql`, `)}) and state in ('created', 'retry', 'active', 'failed')
        group by name, state`,
  );
  return result.rows;
}

/**
 * Queue stats straight from pg-boss' job table, so it needs no running boss instance. Counts are
 * read live rather than from pg-boss' maintenance-refreshed counters, so overview and jobs page agree.
 * Only work queues can be paused; the dead-letter queue is always reported as running.
 */
export async function jobsFromDb(db: Db, now?: Date): Promise<JobsView> {
  const byQueue = new Map<string, Counts>();
  for (const row of await countJobs(db)) {
    const counts = byQueue.get(row.name) ?? { ...ZERO };
    if (row.state === "active") counts.active += row.n;
    else if (row.state === "failed") counts.failed += row.n;
    else counts.queued += row.n;
    byQueue.set(row.name, counts);
  }
  // One query after another: `db` may be a transaction, whose single connection must not run queries concurrently.
  const view: Partial<JobsView> = {};
  for (const queue of VIEW_QUEUES) {
    const pausable = isWorkQueue(queue);
    const paused = pausable ? await isQueuePaused(db, queue, now) : false;
    view[queue] = { ...(byQueue.get(queue) ?? ZERO), paused, pausable };
  }
  return view as JobsView;
}

/** Queue stats for the jobs page; same source as the overview. */
export async function queuesView(db: Db): Promise<JobsView> {
  return jobsFromDb(db);
}
