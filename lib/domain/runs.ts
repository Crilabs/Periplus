import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { externalCalls, jobOutcomes, runStages, runs } from "@/lib/db/schema";
import type { RunKind, RunScopeType, RunStageStatus, RunStatus } from "@/lib/db/schema";
import { blockUncheckedRuns } from "@/lib/domain/extraction/run-status";
import { failOpenUnits } from "@/lib/domain/extraction/unit-status";

export type { RunKind, RunStatus };

export type RunScope = { type: RunScopeType; id: string };

export type RunStageView = {
  stage: string;
  ordinal: number;
  total: number;
  done: number;
  failed: number;
  status: RunStageStatus;
};

export type RunView = {
  id: string;
  kind: RunKind;
  scope: RunScope;
  status: RunStatus;
  triggeredBy: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  failureReason: string | null;
  /** Who ended the run by hand ("Lauf beenden"), and when; null for a run that ended by itself. */
  endedBy: string | null;
  endedAt: Date | null;
  costEur: number;
  stages: RunStageView[];
};

export async function createRun(
  db: Db,
  input: { kind: RunKind; scope: RunScope; stages: string[]; params?: Record<string, unknown>; triggeredBy: string },
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(runs)
      .values({
        kind: input.kind,
        scopeType: input.scope.type,
        scopeId: input.scope.id,
        stages: input.stages,
        params: input.params ?? {},
        triggeredBy: input.triggeredBy,
      })
      .returning({ id: runs.id });
    if (input.stages.length > 0) {
      await tx
        .insert(runStages)
        .values(input.stages.map((stage, ordinal) => ({ runId: run.id, stage, ordinal, status: "pending" as const })));
    }
    return { id: run.id };
  });
}

/** The failure reason of a run whose stage `stage` finished with every job failed. */
export function stageFailedReason(stage: string): string {
  return `stage ${stage} failed completely`;
}

/**
 * Follows up a stage the caller just finished (it won the transition). A stage whose jobs all failed fails
 * the run with `stageFailedReason` and plans nothing further (ruling F-R1), so later stages never run on
 * missing data; otherwise it reports the next stage or, after the last one, finishes the run. First it fails the
 * run's extraction units that are still open (`failOpenUnits`). A failed run never reaches its quote check, so its
 * unchecked extraction runs are blocked (`run_failed`, ruling M4-FIN-R1) for "Belegtreue neu prüfen".
 */
async function afterStageFinished(
  db: Db,
  stageRow: { runId: string; stage: string; ordinal: number; total: number; failed: number },
): Promise<{ nextStage: string | null; runFinished: boolean }> {
  // Units of this run that are still open now can never be sent or distributed (ruling M4-G-R3).
  await failOpenUnits(db, stageRow.runId);
  if (stageRow.total > 0 && stageRow.failed === stageRow.total) {
    await db
      .update(runs)
      .set({ status: "failed", finishedAt: sql`now()`, failureReason: stageFailedReason(stageRow.stage) })
      .where(and(eq(runs.id, stageRow.runId), eq(runs.status, "running")));
    await blockUncheckedRuns(db, stageRow.runId, "run_failed");
    return { nextStage: null, runFinished: true };
  }
  const [next] = await db
    .select({ stage: runStages.stage })
    .from(runStages)
    .where(and(eq(runStages.runId, stageRow.runId), eq(runStages.ordinal, stageRow.ordinal + 1)));
  if (next) return { nextStage: next.stage, runFinished: false };
  await db
    .update(runs)
    .set({ status: "finished", finishedAt: sql`now()` })
    .where(and(eq(runs.id, stageRow.runId), eq(runs.status, "running")));
  return { nextStage: null, runFinished: true };
}

export async function beginStage(
  db: Db,
  runId: string,
  stage: string,
  total: number,
): Promise<{ stageFinished: boolean; nextStage: string | null; runFinished: boolean }> {
  await db
    .update(runs)
    .set({ status: "running", startedAt: sql`coalesce(${runs.startedAt}, now())` })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])));
  const [row] = await db
    .update(runStages)
    .set({ total, status: total === 0 ? "finished" : "running" })
    .where(and(eq(runStages.runId, runId), eq(runStages.stage, stage), eq(runStages.status, "pending")))
    .returning();
  if (!row) throw new Error(`stage ${stage} of run ${runId} is not pending`);
  if (total === 0) {
    const follow = await afterStageFinished(db, row);
    return { stageFinished: true, ...follow };
  }
  return { stageFinished: false, nextStage: null, runFinished: false };
}

/**
 * Whether `stage` of the run can still take jobs: the stage is running and the run is queued or running (not
 * finished, failed or ended by an admin). Locks the stage row until the caller's transaction ends, so a caller that
 * gets `true` can enqueue and `extendStage` in the same transaction. A job retried after its stage finished gets
 * `false`.
 */
export async function stageAcceptsJobs(db: Db, runId: string, stage: string): Promise<boolean> {
  const [row] = await db
    .select({ status: runStages.status, runStatus: runs.status })
    .from(runStages)
    .innerJoin(runs, eq(runs.id, runStages.runId))
    .where(and(eq(runStages.runId, runId), eq(runStages.stage, stage)))
    .for("update", { of: runStages });
  return row?.status === "running" && (row.runStatus === "queued" || row.runStatus === "running");
}

/**
 * Adds `by` jobs to a running stage (a crawl job that discovered new pages). Callers extend in the transaction that
 * enqueues the new jobs and before their own job's outcome is recorded, so the stage cannot finish in between.
 * Returns false (and changes nothing) when the stage is not running.
 */
export async function extendStage(db: Db, runId: string, stage: string, by: number): Promise<boolean> {
  const [row] = await db
    .update(runStages)
    .set({ total: sql`${runStages.total} + ${by}` })
    .where(and(eq(runStages.runId, runId), eq(runStages.stage, stage), eq(runStages.status, "running")))
    .returning({ id: runStages.id });
  return row !== undefined;
}

export type JobOutcome = "done" | "failed";

export type JobOutcomeResult = { recorded: boolean; stageFinished: boolean; nextStage: string | null; runFinished: boolean };

const NOTHING_FINISHED = { stageFinished: false, nextStage: null, runFinished: false } as const;

/**
 * Records the outcome of the job `key` in a stage, once per (run, stage, key):
 * - first outcome: counts it; the call that completes the stage finishes it and reports the follow-up;
 * - same outcome again: `recorded: false`, nothing changes;
 * - `done` after `failed` (e.g. a manual retry): rewrites the outcome and moves one count from `failed`
 *   to `done`, also on a finished stage, without any stage transition; a run that failed because this stage
 *   failed completely continues (`reviveRun`, rulings T3-R1 and F-R1): after its last stage it is finished,
 *   otherwise running again with the next stage reported, which the caller enqueues in the same transaction;
 * - `failed` after `done`: `recorded: false`, a success is never downgraded.
 */
export async function recordJobOutcome(
  db: Db,
  runId: string,
  stage: string,
  key: string,
  outcome: JobOutcome,
): Promise<JobOutcomeResult> {
  return db.transaction(async (tx) => {
    // A concurrent insert of the same key waits on the primary key, so exactly one caller inserts.
    const [inserted] = await tx
      .insert(jobOutcomes)
      .values({ runId, stage, key, outcome })
      .onConflictDoNothing()
      .returning({ key: jobOutcomes.key });
    if (!inserted) {
      const upgrade = await upgradeOutcome(tx, runId, stage, key, outcome);
      return { ...NOTHING_FINISHED, recorded: upgrade.recorded, nextStage: upgrade.nextStage };
    }

    // Single atomic increment; row locking serialises concurrent callers, so each sees a distinct counter value.
    const [row] = await tx
      .update(runStages)
      .set(outcome === "done" ? { done: sql`${runStages.done} + 1` } : { failed: sql`${runStages.failed} + 1` })
      .where(and(eq(runStages.runId, runId), eq(runStages.stage, stage), eq(runStages.status, "running")))
      .returning();
    if (!row) throw new Error(`stage ${stage} of run ${runId} is not running`);
    if (row.done + row.failed < row.total) return { recorded: true, ...NOTHING_FINISHED };

    // Conditional transition: exactly one caller can flip running -> finished.
    const [finished] = await tx
      .update(runStages)
      .set({ status: "finished" })
      .where(and(eq(runStages.id, row.id), eq(runStages.status, "running")))
      .returning();
    if (!finished) return { recorded: true, ...NOTHING_FINISHED };
    const follow = await afterStageFinished(tx, finished);
    return { recorded: true, stageFinished: true, ...follow };
  });
}

/** Turns a recorded `failed` into `done`; returns whether anything changed and the stage the run resumes with. */
async function upgradeOutcome(
  db: Db,
  runId: string,
  stage: string,
  key: string,
  outcome: JobOutcome,
): Promise<{ recorded: boolean; nextStage: string | null }> {
  if (outcome !== "done") return { recorded: false, nextStage: null };
  const [flipped] = await db
    .update(jobOutcomes)
    .set({ outcome: "done", updatedAt: sql`now()` })
    .where(
      and(
        eq(jobOutcomes.runId, runId),
        eq(jobOutcomes.stage, stage),
        eq(jobOutcomes.key, key),
        eq(jobOutcomes.outcome, "failed"),
      ),
    )
    .returning({ key: jobOutcomes.key });
  if (!flipped) return { recorded: false, nextStage: null };
  await db
    .update(runStages)
    .set({ done: sql`${runStages.done} + 1`, failed: sql`${runStages.failed} - 1` })
    .where(and(eq(runStages.runId, runId), eq(runStages.stage, stage)));
  return { recorded: true, nextStage: await reviveRun(db, runId, stage) };
}

/**
 * A run failed because `stage` failed completely continues once that stage has a success again: after its
 * last stage it counts as finished (its `finished_at` stays the time it ended); otherwise it is running
 * again and the next stage, still pending, is returned for the caller to enqueue. The conditional update
 * lets exactly one of several concurrent successes revive the run. A run failed for any other reason
 * (e.g. a stage transition) stays failed.
 */
async function reviveRun(db: Db, runId: string, stage: string): Promise<string | null> {
  const [current] = await db
    .select({ ordinal: runStages.ordinal })
    .from(runStages)
    .where(and(eq(runStages.runId, runId), eq(runStages.stage, stage)));
  if (!current) return null;
  const [next] = await db
    .select({ stage: runStages.stage, status: runStages.status })
    .from(runStages)
    .where(and(eq(runStages.runId, runId), eq(runStages.ordinal, current.ordinal + 1)));
  if (next && next.status !== "pending") return null;
  const revived = await db
    .update(runs)
    .set(next ? { status: "running", failureReason: null, finishedAt: null } : { status: "finished", failureReason: null })
    .where(and(eq(runs.id, runId), eq(runs.status, "failed"), eq(runs.failureReason, stageFailedReason(stage))))
    .returning({ id: runs.id });
  return revived.length > 0 && next ? next.stage : null;
}

/**
 * Ends a run as failed, e.g. when moving to its next stage failed for good. Keeps the first reason. Its unchecked
 * extraction runs are blocked (`run_failed`, ruling M4-FIN-R1), as the run never reaches its quote check.
 */
export async function failRun(db: Db, runId: string, reason: string): Promise<void> {
  await db
    .update(runs)
    .set({ status: "failed", finishedAt: sql`coalesce(${runs.finishedAt}, now())`, failureReason: reason })
    .where(and(eq(runs.id, runId), sql`${runs.failureReason} is null`));
  await blockUncheckedRuns(db, runId, "run_failed");
}

/**
 * Puts a failed run back to running, e.g. when its failed stage transition (`run.advance`) is retried:
 * clears the reason and the end time, so the run ends again when its last stage finishes. Returns whether
 * the run was failed.
 */
export async function resumeRun(db: Db, runId: string): Promise<boolean> {
  const resumed = await db
    .update(runs)
    .set({ status: "running", failureReason: null, finishedAt: null })
    // A run an admin ended stays ended.
    .where(and(eq(runs.id, runId), eq(runs.status, "failed"), isNull(runs.endedBy)))
    .returning({ id: runs.id });
  return resumed.length > 0;
}

/** Failure reason of a run an admin ended ("Lauf beenden"); who and when are in `ended_by`/`ended_at`. */
export const RUN_ENDED_REASON = "ended by admin";

/**
 * Ends a queued or running run by hand ("Lauf beenden", e.g. a crawl stuck after a worker crash): status `failed`
 * with `RUN_ENDED_REASON`, `finished_at` and `ended_at` now, `ended_by` the admin. Returns whether the run was
 * active; a run that has ended already is left as it is. Its jobs that still start do nothing (the worker checks
 * `isRunEnded`), and no retry resumes it.
 */
export async function endRun(db: Db, runId: string, by: string): Promise<boolean> {
  const ended = await db
    .update(runs)
    .set({ status: "failed", finishedAt: sql`now()`, failureReason: RUN_ENDED_REASON, endedBy: by, endedAt: sql`now()` })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])))
    .returning({ id: runs.id });
  return ended.length > 0;
}

/** Whether an admin ended the run by hand. */
export async function isRunEnded(db: Db, runId: string): Promise<boolean> {
  const [row] = await db.select({ endedBy: runs.endedBy }).from(runs).where(eq(runs.id, runId));
  return row?.endedBy != null;
}

type RunRow = typeof runs.$inferSelect;

async function toViews(db: Db, rows: RunRow[]): Promise<RunView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const stageRows = await db
    .select()
    .from(runStages)
    .where(inArray(runStages.runId, ids))
    .orderBy(runStages.runId, runStages.ordinal);
  const costRows = await db
    .select({ runId: externalCalls.runId, cost: sql<string>`coalesce(sum(${externalCalls.costEur}), 0)` })
    .from(externalCalls)
    .where(inArray(externalCalls.runId, ids))
    .groupBy(externalCalls.runId);
  const costs = new Map(costRows.map((c) => [c.runId, Number(c.cost)]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    scope: { type: r.scopeType, id: r.scopeId },
    status: r.status,
    triggeredBy: r.triggeredBy,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    failureReason: r.failureReason,
    endedBy: r.endedBy,
    endedAt: r.endedAt,
    costEur: costs.get(r.id) ?? 0,
    stages: stageRows
      .filter((s) => s.runId === r.id)
      .map((s) => ({ stage: s.stage, ordinal: s.ordinal, total: s.total, done: s.done, failed: s.failed, status: s.status })),
  }));
}

export async function getRun(db: Db, id: string): Promise<RunView | null> {
  const rows = await db.select().from(runs).where(eq(runs.id, id));
  return (await toViews(db, rows))[0] ?? null;
}

/** Newest first; `before` is a run id cursor (ids are UUIDv7, so id order is creation order). */
export async function listRuns(db: Db, opts: { limit: number; before?: string }): Promise<RunView[]> {
  const rows = await db
    .select()
    .from(runs)
    .where(opts.before ? lt(runs.id, opts.before) : undefined)
    .orderBy(desc(runs.id))
    .limit(opts.limit);
  return toViews(db, rows);
}
