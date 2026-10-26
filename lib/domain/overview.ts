import { desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { deliveries, reviewTasks, subdivisions, workerHeartbeats, type DeliveryStatus, type ReviewKind } from "@/lib/db/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { budgetStatus, type BudgetStatus } from "@/lib/domain/costs";
import { OFFERED_REVIEW_KINDS } from "@/lib/domain/review";
import { jobsFromDb, type JobsView } from "@/lib/domain/queues-view";
import { listRuns, type RunView } from "@/lib/domain/runs";

export const REVIEW_KINDS: readonly ReviewKind[] = OFFERED_REVIEW_KINDS;

/** Workers whose last heartbeat is older than this are treated as gone and not listed. */
export const WORKER_STALE_MS = 3_600_000;

export type Overview = {
  openReviewTasks: Record<ReviewKind, number>;
  jobs: JobsView;
  budgets: BudgetStatus[];
  workers: Array<{ workerId: string; beatAgeSeconds: number }>;
  recentRuns: RunView[];
  recentDeliveries: RecentDelivery[];
};

/** `scopeName`: the subdivision's name; a pilot package (contract 1.0) shows its configured area's name. */
export type RecentDelivery = { id: string; scopeName: string | null; status: DeliveryStatus; dataVersion: number | null; generatedAt: Date };

/** The latest package builds of all subdivisions, newest first (subdivision, status, data version, build time). */
export async function latestDeliveries(db: Db, limit: number): Promise<RecentDelivery[]> {
  return db
    .select({
      id: deliveries.id,
      scopeName: sql<string | null>`coalesce(${displayNameSql(subdivisions.geoObjectId)}, ${subdivisions.key}, ${displayNameSql(deliveries.areaId)})`,
      status: deliveries.status,
      dataVersion: deliveries.dataVersion,
      generatedAt: deliveries.generatedAt,
    })
    .from(deliveries)
    .leftJoin(subdivisions, eq(subdivisions.id, deliveries.subdivisionId))
    .orderBy(desc(deliveries.createdAt), desc(deliveries.generatedAt), desc(deliveries.id))
    .limit(limit);
}

export async function overview(db: Db, now: Date = new Date()): Promise<Overview> {
  // One query after another: `db` may be a transaction, whose single connection must not run queries concurrently.
  const reviewRows = await db
    .select({ kind: reviewTasks.kind, n: sql<number>`count(*)::int` })
    .from(reviewTasks)
    .where(eq(reviewTasks.status, "open"))
    .groupBy(reviewTasks.kind);
  const jobs = await jobsFromDb(db, now);
  const budgets = await budgetStatus(db, undefined, now);
  const beats = await db
    .select()
    .from(workerHeartbeats)
    .where(gt(workerHeartbeats.beatAt, new Date(now.getTime() - WORKER_STALE_MS)));
  const recentRuns = await listRuns(db, { limit: 5 });
  const recentDeliveries = await latestDeliveries(db, 5);
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
    recentDeliveries,
  };
}
