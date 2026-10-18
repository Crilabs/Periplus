"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { retryFailedJob } from "@/lib/domain/jobs-view";
import { openTaskFor } from "@/lib/domain/review";
import { decideReviewTask, TaskNotOpen } from "@/lib/domain/review-decisions";
import { getBoss } from "@/lib/jobs/boss";
import { QUEUES, type QueueName } from "@/lib/jobs/queues";
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
