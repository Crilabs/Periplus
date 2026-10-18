import { eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { reviewKindEnum, reviewTasks, workerHeartbeats, type ReviewKind } from "@/lib/db/schema";
import { budgetStatus, type BudgetStatus } from "@/lib/domain/costs";
import { jobsFromDb, type JobsView } from "@/lib/domain/queues-view";
import { listRuns, type RunView } from "@/lib/domain/runs";

export const REVIEW_KINDS: readonly ReviewKind[] = reviewKindEnum.enumValues;

export type Overview = {
  openReviewTasks: Record<ReviewKind, number>;
  jobs: JobsView;
  budgets: BudgetStatus[];
  workers: Array<{ workerId: string; beatAgeSeconds: number }>;
  recentRuns: RunView[];
};

export async function overview(db: Db, now: Date = new Date()): Promise<Overview> {
  const [reviewRows, jobs, budgets, beats, recentRuns] = await Promise.all([
    db
      .select({ kind: reviewTasks.kind, n: sql<number>`count(*)::int` })
      .from(reviewTasks)
      .where(eq(reviewTasks.status, "open"))
      .groupBy(reviewTasks.kind),
    jobsFromDb(db, now),
    budgetStatus(db, undefined, now),
    db.select().from(workerHeartbeats),
    listRuns(db, { limit: 5 }),
  ]);
  const openReviewTasks = Object.fromEntries(REVIEW_KINDS.map((kind) => [kind, 0])) as Record<ReviewKind, number>;
  for (const row of reviewRows) openReviewTasks[row.kind] = row.n;
  return {
    openReviewTasks,
    jobs,
    budgets,
    workers: beats.map((b) => ({
      workerId: b.workerId,
      beatAgeSeconds: Math.max(0, Math.round((now.getTime() - b.beatAt.getTime()) / 1000)),
    })),
    recentRuns,
  };
}
