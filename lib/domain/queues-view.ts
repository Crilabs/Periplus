import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { isQueuePaused } from "@/lib/jobs/controls";
import { QUEUES, type QueueName } from "@/lib/jobs/queues";

export type QueueStats = { queued: number; active: number; failed: number; paused: boolean };
export type JobsView = Record<QueueName, QueueStats>;

type Counts = Omit<QueueStats, "paused">;
const ZERO: Counts = { queued: 0, active: 0, failed: 0 };

async function withPaused(db: Db, counts: (queue: QueueName) => Counts, now?: Date): Promise<JobsView> {
  const entries = await Promise.all(
    QUEUES.map(async (queue) => [queue, { ...counts(queue), paused: await isQueuePaused(db, queue, now) }] as const),
  );
  return Object.fromEntries(entries) as JobsView;
}

/** Queue stats straight from pg-boss' job table, so it needs no running boss instance. */
export async function jobsFromDb(db: Db, now?: Date): Promise<JobsView> {
  const result = await db.execute<{ name: string; state: string; n: number }>(
    sql`select name, state::text as state, count(*)::int as n from pgboss.job
        where name in (${sql.join(QUEUES.map((q) => sql`${q}`), sql`, `)}) and state in ('created', 'retry', 'active', 'failed')
        group by name, state`,
  );
  const byQueue = new Map<string, Counts>();
  for (const row of result.rows) {
    const counts = byQueue.get(row.name) ?? { ...ZERO };
    if (row.state === "active") counts.active += row.n;
    else if (row.state === "failed") counts.failed += row.n;
    else counts.queued += row.n;
    byQueue.set(row.name, counts);
  }
  return withPaused(db, (queue) => byQueue.get(queue) ?? ZERO, now);
}

/** Queue stats from pg-boss' own counters (used by the jobs page). */
export async function queuesView(db: Db, boss: PgBoss): Promise<JobsView> {
  const stats = new Map((await boss.getQueues([...QUEUES])).map((q) => [q.name, q]));
  return withPaused(db, (queue) => {
    const q = stats.get(queue);
    return q ? { queued: q.queuedCount, active: q.activeCount, failed: q.failedCount } : ZERO;
  });
}
