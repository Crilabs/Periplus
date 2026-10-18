import { and, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { externalCalls } from "@/lib/db/schema";

const DAY_MS = 24 * 3_600_000;

/** True when no external_calls row (committed, or written by `db`'s own transaction) lies in [from, to). */
export async function isQuiet(db: Db, from: Date, to: Date): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(externalCalls)
    .where(and(gte(externalCalls.at, from), lt(externalCalls.at, to)));
  return row!.n === 0;
}

/**
 * Returns `pick()`'s first result whose span has no external_calls rows.
 *
 * external_calls is append-only and shared by all test files, so spend sums over a time window are only
 * exact in a window nobody wrote to. Write the test's own calls inside `withRollback`: they never become
 * visible to other files and never pile up, so a quiet span stays quiet. Spans lie in the years 4000-9999,
 * past anything the app or older test runs wrote.
 */
export async function findQuietSpan<T>(db: Db, pick: () => { value: T; from: Date; to: Date }): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { value, from, to } = pick();
    if (await isQuiet(db, from, to)) return value;
  }
  throw new Error("no quiet span for external_calls found in 20 attempts");
}

/** Random UTC year in 4000-9999. */
export function farFutureYear(): number {
  return 4000 + Math.floor(Math.random() * 6000);
}

/** Start of a random far-future UTC day with no external_calls from `marginDays` before to `marginDays` after it. */
export function quietDay(db: Db, marginDays = 2): Promise<Date> {
  return findQuietSpan(db, () => {
    const day = new Date(Date.UTC(farFutureYear(), 0, 1) + Math.floor(Math.random() * 365) * DAY_MS);
    return { value: day, from: new Date(day.getTime() - marginDays * DAY_MS), to: new Date(day.getTime() + (marginDays + 1) * DAY_MS) };
  });
}
