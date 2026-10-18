import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { queueControls } from "@/lib/db/schema";
import type { BudgetExceeded } from "@/lib/domain/costs";
import { createLogger } from "@/lib/logger";

const log = createLogger("queue-controls");

/** `until` null = paused until resumed. */
export async function pauseQueue(
  db: Db,
  queue: string,
  until: Date | null,
  reason: string,
  by: string,
): Promise<void> {
  await db
    .insert(queueControls)
    .values({ queue, pausedUntil: until, reason, updatedBy: by })
    .onConflictDoUpdate({
      target: queueControls.queue,
      set: { pausedUntil: until, reason, updatedBy: by },
    });
}

/** Removes the pause row; `by` is recorded in the log since the row is gone afterwards. */
export async function resumeQueue(db: Db, queue: string, by: string): Promise<void> {
  await db.delete(queueControls).where(eq(queueControls.queue, queue));
  log.info({ queue, by }, "queue resumed");
}

export async function isQueuePaused(db: Db, queue: string, now: Date = new Date()): Promise<boolean> {
  const [row] = await db.select().from(queueControls).where(eq(queueControls.queue, queue));
  if (!row) return false;
  return row.pausedUntil === null || row.pausedUntil.getTime() > now.getTime();
}

/** Pauses the given queues until the next 00:00 UTC after `now`; returns the pause end. */
export async function pauseForBudget(
  db: Db,
  err: BudgetExceeded,
  queues: string[],
  now: Date = new Date(),
): Promise<Date> {
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  for (const queue of queues) await pauseQueue(db, queue, until, `budget:${err.service}`, "system");
  return until;
}
