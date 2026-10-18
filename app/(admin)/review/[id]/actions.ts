"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { retryFailedJob } from "@/lib/domain/jobs-view";
import { DecisionNotAllowed, decideReviewTask, reviewDecisionSchema, TaskNotOpen } from "@/lib/domain/review-decisions";
import { nextTaskHref } from "@/lib/domain/review-view";
import { getBoss } from "@/lib/jobs/boss";
import type { QueueName } from "@/lib/jobs/queues";
import { requireAdmin } from "@/lib/security/require-admin";

const fieldsSchema = z.object({
  taskId: z.uuid(),
  openedAt: z.iso.datetime().optional(),
  decision: z.string().transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "decision is not valid JSON" });
      return z.NEVER;
    }
  }),
});

/**
 * Decides a review task from a decision form (`taskId`, `openedAt`, `decision` as JSON), then redirects to the
 * next open task of the same kind (or `/review`). An already decided task redirects back with `?stale=1`, a
 * decision that does not fit the task with `?error=1`.
 */
export async function decideAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const fields = fieldsSchema.parse({
    taskId: formData.get("taskId"),
    openedAt: formData.get("openedAt") || undefined,
    decision: formData.get("decision"),
  });
  const decision = reviewDecisionSchema.parse(fields.decision);
  const db = getDb();
  const retryJob = async (queue: QueueName, jobId: string) => retryFailedJob(db, await getBoss(), queue, jobId);

  let target: string;
  try {
    await decideReviewTask(
      db,
      {
        taskId: fields.taskId,
        decision,
        decidedBy: admin.email,
        openedAt: fields.openedAt ? new Date(fields.openedAt) : undefined,
      },
      { retryJob },
    );
    target = await nextTaskHref(db, fields.taskId);
  } catch (e) {
    if (e instanceof TaskNotOpen) target = `/review/${fields.taskId}?stale=1`;
    else if (e instanceof DecisionNotAllowed) target = `/review/${fields.taskId}?error=1`;
    else throw e;
  }
  redirect(target);
}
