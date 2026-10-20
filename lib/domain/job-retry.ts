import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { retryFailedJob } from "@/lib/domain/jobs-view";
import { openTaskFor } from "@/lib/domain/review";
import { decideReviewTask, TaskNotOpen } from "@/lib/domain/review-decisions";
import type { QueueName } from "@/lib/jobs/queues";

/**
 * „Erneut versuchen“ on a failed job (run page, gesamt review UI-16): an open `failed_job` task of the job is decided
 * with `retry` (the decision retries the job last, so a failed retry rolls the decision back); without such a task the
 * job is retried directly. A task decided concurrently (e.g. a double click) only retries, which is idempotent.
 */
export async function retryJobWithTask(db: Db, boss: PgBoss, input: { queue: QueueName; jobId: string; decidedBy: string }): Promise<void> {
  const retry = () => retryFailedJob(db, boss, input.queue, input.jobId);
  const task = await openTaskFor(db, "failed_job", input.jobId);
  if (!task) return retry();
  try {
    await decideReviewTask(
      db,
      { taskId: task.id, decision: { action: "retry" }, decidedBy: input.decidedBy },
      { retryJob: (queue, jobId) => retryFailedJob(db, boss, queue, jobId) },
    );
  } catch (e) {
    if (!(e instanceof TaskNotOpen)) throw e;
    await retry();
  }
}
