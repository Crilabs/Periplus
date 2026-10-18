import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { externalCalls, jobOutcomes, runStages, runs } from "@/lib/db/schema";
import type { RunKind, RunScopeType, RunStageStatus, RunStatus } from "@/lib/db/schema";

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

/**
 * Marks a stage finished (caller guarantees it won the transition) and, if it was the last stage,
 * finishes the run. Returns the follow-up the worker needs.
 */
async function afterStageFinished(
  db: Db,
  stageRow: { runId: string; ordinal: number; total: number; failed: number },
): Promise<{ nextStage: string | null; runFinished: boolean }> {
  const [next] = await db
    .select({ stage: runStages.stage })
    .from(runStages)
    .where(and(eq(runStages.runId, stageRow.runId), eq(runStages.ordinal, stageRow.ordinal + 1)));
  if (next) return { nextStage: next.stage, runFinished: false };
  const allFailed = stageRow.total > 0 && stageRow.failed === stageRow.total;
  await db
    .update(runs)
    .set({ status: allFailed ? "failed" : "finished", finishedAt: sql`now()` })
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

export type JobOutcome = "done" | "failed";

export type JobOutcomeResult = { recorded: boolean; stageFinished: boolean; nextStage: string | null; runFinished: boolean };

const NOTHING_FINISHED = { stageFinished: false, nextStage: null, runFinished: false } as const;

/**
 * Records the outcome of the job `key` in a stage, once per (run, stage, key):
 * - first outcome: counts it; the call that completes the stage finishes it and reports the follow-up;
 * - same outcome again: `recorded: false`, nothing changes;
 * - `done` after `failed` (e.g. a manual retry): rewrites the outcome and moves one count from `failed`
 *   to `done`, also on a finished stage, without any stage transition; a run that failed only because its
 *   last stage all failed becomes finished again (`reviveRun`, ruling T3-R1);
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
    if (!inserted) return { recorded: await upgradeOutcome(tx, runId, stage, key, outcome), ...NOTHING_FINISHED };

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

/** Turns a recorded `failed` into `done`; returns whether anything changed. */
async function upgradeOutcome(db: Db, runId: string, stage: string, key: string, outcome: JobOutcome): Promise<boolean> {
  if (outcome !== "done") return false;
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
  if (!flipped) return false;
  await db
    .update(runStages)
    .set({ done: sql`${runStages.done} + 1`, failed: sql`${runStages.failed} - 1` })
    .where(and(eq(runStages.runId, runId), eq(runStages.stage, stage)));
  await reviveRun(db, runId);
  return true;
}

/**
 * A run failed only because every job of its last stage failed (no `failure_reason`) counts as finished
 * once that stage has a success again. A run failed with a reason (e.g. a stage transition) stays failed.
 * Its `finished_at` stays the time it ended.
 */
async function reviveRun(db: Db, runId: string): Promise<void> {
  await db
    .update(runs)
    .set({ status: "finished" })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.status, "failed"),
        sql`${runs.failureReason} is null`,
        sql`exists (
          select 1 from ${runStages} s
          where s.run_id = ${runs.id} and s.status = 'finished' and s.failed < s.total
            and s.ordinal = (select max(l.ordinal) from ${runStages} l where l.run_id = ${runs.id})
        )`,
      ),
    );
}

/** Ends a run as failed, e.g. when moving to its next stage failed for good. Keeps the first reason. */
export async function failRun(db: Db, runId: string, reason: string): Promise<void> {
  await db
    .update(runs)
    .set({ status: "failed", finishedAt: sql`coalesce(${runs.finishedAt}, now())`, failureReason: reason })
    .where(and(eq(runs.id, runId), sql`${runs.failureReason} is null`));
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
    .where(and(eq(runs.id, runId), eq(runs.status, "failed")))
    .returning({ id: runs.id });
  return resumed.length > 0;
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
