import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { externalCalls, runStages, runs } from "@/lib/db/schema";
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

export async function recordJobOutcome(
  db: Db,
  runId: string,
  stage: string,
  outcome: "done" | "failed",
): Promise<{ stageFinished: boolean; nextStage: string | null; runFinished: boolean }> {
  // Single atomic increment; row locking serialises concurrent callers, so each sees a distinct counter value.
  const [row] = await db
    .update(runStages)
    .set(outcome === "done" ? { done: sql`${runStages.done} + 1` } : { failed: sql`${runStages.failed} + 1` })
    .where(and(eq(runStages.runId, runId), eq(runStages.stage, stage), eq(runStages.status, "running")))
    .returning();
  if (!row) throw new Error(`stage ${stage} of run ${runId} is not running`);
  if (row.done + row.failed < row.total) return { stageFinished: false, nextStage: null, runFinished: false };

  // Conditional transition: exactly one caller can flip running -> finished.
  const [finished] = await db
    .update(runStages)
    .set({ status: "finished" })
    .where(and(eq(runStages.id, row.id), eq(runStages.status, "running")))
    .returning();
  if (!finished) return { stageFinished: false, nextStage: null, runFinished: false };
  const follow = await afterStageFinished(db, finished);
  return { stageFinished: true, ...follow };
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
