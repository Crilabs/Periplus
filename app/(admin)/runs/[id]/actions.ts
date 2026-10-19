"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { extractionRuns } from "@/lib/db/schema";
import { retryFailedJob } from "@/lib/domain/jobs-view";
import { openTaskFor } from "@/lib/domain/review";
import { decideReviewTask, TaskNotOpen } from "@/lib/domain/review-decisions";
import { getBoss } from "@/lib/jobs/boss";
import { QUEUES, type QueueName } from "@/lib/jobs/queues";
import { createLogger } from "@/lib/logger";
import { catchUpConsolidation, type CatchUpResult } from "@/lib/pipeline/consolidation/run";
import { endRunByAdmin } from "@/lib/pipeline/runs";
import { recheckBlockedExtractionRun } from "@/lib/pipeline/text/check";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { requireAdmin } from "@/lib/security/require-admin";

const retrySchema = z.object({ queue: z.enum(QUEUES), jobId: z.uuid() });

/** Retries a failed job; an open `failed_job` task of the job is decided with `retry` along the way. */
export async function retryJobAction(input: FormData | { queue: string; jobId: string }): Promise<void> {
  const admin = await requireAdmin();
  const { queue, jobId } = retrySchema.parse(input instanceof FormData ? Object.fromEntries(input) : input);
  const db = getDb();
  const boss = await getBoss();
  const retry = () => retryFailedJob(db, boss, queue, jobId);
  const retryTaskJob = (taskQueue: QueueName, taskJobId: string) => retryFailedJob(db, boss, taskQueue, taskJobId);
  const task = await openTaskFor(db, "failed_job", jobId);
  try {
    if (task) {
      await decideReviewTask(
        db,
        { taskId: task.id, decision: { action: "retry" }, decidedBy: admin.email },
        { retryJob: retryTaskJob },
      );
    } else {
      await retry();
    }
  } catch (e) {
    // Decided concurrently (e.g. a double click): the retry itself is idempotent.
    if (!(e instanceof TaskNotOpen)) throw e;
    await retry();
  }
  refresh();
}

const endRunSchema = z.object({ runId: z.uuid() });

/**
 * "Lauf beenden": ends a queued or running run (e.g. one stuck after a worker crash, which keeps its sources locked)
 * and cancels its jobs that have not started; records the admin and the time on the run. A run that has ended
 * already stays as it is.
 */
export async function endRunAction(input: FormData | { runId: string }): Promise<void> {
  const admin = await requireAdmin();
  const { runId } = endRunSchema.parse(input instanceof FormData ? Object.fromEntries(input) : input);
  await endRunByAdmin(getDb(), await getBoss(), runId, admin.email);
  refresh();
}

const recheckSchema = z.object({ extractionRunId: z.uuid() });

/** The run page with a notice (`?notice=`), after a recheck or a catch-up that started no consolidation. */
const runPage = (runId: string, notice?: string) => (notice ? `/runs/${runId}?notice=${notice}` : `/runs/${runId}`);

/** The notice a catch-up gives the run page; none when it started a run or there was nothing skipped. */
function catchUpNotice(result: CatchUpResult): string | undefined {
  if (result.status === "blocked") return "consolidation_blocked";
  if (result.status === "no_targets") return "consolidation_no_targets";
  return undefined;
}

/**
 * Runs `start` (a consolidation start after a committed recheck or on „Konsolidierung nachholen“): a start that cannot
 * be made (`RunScopeNotReady`) or fails (e.g. the job queue is down) is logged and becomes a notice; what committed
 * before stands (ruling M5-H-R2).
 */
async function startOrNotice(runId: string, start: () => Promise<CatchUpResult>): Promise<string | undefined> {
  try {
    return catchUpNotice(await start());
  } catch (e) {
    createLogger("runs").error({ runId, err: e, notScopeReady: e instanceof RunScopeNotReady }, "consolidation catch-up not started");
    return "consolidation_not_started";
  }
}

/**
 * "Belegtreue neu prüfen": checks the quotes of one blocked extraction run again (after late results, a run ended by
 * hand or a fixed chunk) and finishes it when every quote holds up; a run that is not blocked stays as it is. After
 * that check committed, the consolidation its run skipped starts once nothing blocks it any more
 * (`catchUpConsolidation`, ruling M5-H-R2 I-1).
 */
export async function recheckExtractionRunAction(input: FormData | { extractionRunId: string }): Promise<void> {
  const admin = await requireAdmin();
  const { extractionRunId } = recheckSchema.parse(input instanceof FormData ? Object.fromEntries(input) : input);
  const db = getDb();
  const [er] = await db.select({ runId: extractionRuns.runId }).from(extractionRuns).where(eq(extractionRuns.id, extractionRunId));
  if (er && (await recheckBlockedExtractionRun(db, extractionRunId))) {
    const notice = await startOrNotice(er.runId, async () => catchUpConsolidation(db, await getBoss(), er.runId, admin.email, { afterRecheck: true }));
    // A run still blocked by another extraction run is no news after a recheck: the page shows it.
    if (notice && notice !== "consolidation_blocked") redirect(runPage(er.runId, notice));
  }
  refresh();
}

const catchUpSchema = z.object({ runId: z.uuid() });

/** „Konsolidierung nachholen“: starts the consolidation the run skipped (`catchUpConsolidation`), else says why not. */
export async function catchUpConsolidationAction(input: FormData | { runId: string }): Promise<void> {
  const admin = await requireAdmin();
  const { runId } = catchUpSchema.parse(input instanceof FormData ? Object.fromEntries(input) : input);
  const db = getDb();
  const notice = await startOrNotice(runId, async () => catchUpConsolidation(db, await getBoss(), runId, admin.email));
  redirect(runPage(runId, notice));
}
