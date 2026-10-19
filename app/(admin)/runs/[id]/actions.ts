"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { retryFailedJob } from "@/lib/domain/jobs-view";
import { openTaskFor } from "@/lib/domain/review";
import { decideReviewTask, TaskNotOpen } from "@/lib/domain/review-decisions";
import { getBoss } from "@/lib/jobs/boss";
import { QUEUES, type QueueName } from "@/lib/jobs/queues";
import { endRunByAdmin } from "@/lib/pipeline/runs";
import { recheckBlockedExtractionRun } from "@/lib/pipeline/text/check";
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

/**
 * "Belegtreue neu prüfen": checks the quotes of one blocked extraction run again (after late results, a run ended by
 * hand or a fixed chunk) and finishes it when every quote holds up; a run that is not blocked stays as it is.
 */
export async function recheckExtractionRunAction(input: FormData | { extractionRunId: string }): Promise<void> {
  await requireAdmin();
  const { extractionRunId } = recheckSchema.parse(input instanceof FormData ? Object.fromEntries(input) : input);
  await recheckBlockedExtractionRun(getDb(), extractionRunId);
  refresh();
}
