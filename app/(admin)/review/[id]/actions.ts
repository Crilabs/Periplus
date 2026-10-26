"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getArchive } from "@/lib/adapters/s3";
import { getDb } from "@/lib/db/client";
import { retryFailedJob } from "@/lib/domain/jobs-view";
import {
  DecisionNotAllowed,
  decideReviewTask,
  reviewDecisionSchema,
  TaskContextChanged,
  TaskNotOpen,
  type ReviewDecision,
} from "@/lib/domain/review-decisions";
import { nextTaskHref } from "@/lib/domain/review-view";
import { getBoss } from "@/lib/jobs/boss";
import type { QueueName } from "@/lib/jobs/queues";
import { imageRunAfter } from "@/lib/pipeline/follow-ups";
import { requireAdmin } from "@/lib/security/require-admin";

const taskFieldsSchema = z.object({
  taskId: z.uuid(),
  openedAt: z.iso.datetime().optional(),
  /** The context key of a place image task as shown. */
  taskKey: z.string().max(64).optional(),
});

const fieldsSchema = taskFieldsSchema.extend({
  decision: z.string().transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "decision is not valid JSON" });
      return z.NEVER;
    }
  }),
});

/** `href` with `?notice=run_not_started` (the review pages show it): the decision stands, a follow-up run did not start. */
const withRunNotice = (href: string) => `${href}${href.includes("?") ? "&" : "?"}notice=run_not_started`;

/**
 * Decides the task, then starts the image run of „Neu erzeugen“ on a place image (after the decision committed), then redirects to the next open task of the same kind (or
 * `/review`), with `?notice=run_not_started` when a follow-up run failed to start. An already decided task redirects
 * back with `?stale=1`, a task that changed since it was shown with `?changed=1`, a decision that does
 * not fit the task with `?error=1`.
 */
async function decideAndRedirect(
  decidedBy: string,
  task: z.infer<typeof taskFieldsSchema>,
  decision: ReviewDecision,
): Promise<void> {
  const db = getDb();
  const retryJob = async (queue: QueueName, jobId: string) => retryFailedJob(db, await getBoss(), queue, jobId);

  let target: string;
  try {
    const { regenerateImage } = await decideReviewTask(
      db,
      {
        taskId: task.taskId,
        decision,
        decidedBy,
        openedAt: task.openedAt ? new Date(task.openedAt) : undefined,
        taskKey: task.taskKey,
      },
      { retryJob, archive: getArchive() },
    );
    // the follow-ups of the committed decision (UI-16); a scope that is not ready is no failure here: the decision
    // asked for nothing that could run
    const followUps = [
      ...(regenerateImage ? [await imageRunAfter(db, getBoss, { ...regenerateImage, triggeredBy: decidedBy })] : []),
    ];
    target = await nextTaskHref(db, task.taskId);
    if (followUps.some((f) => f.status === "failed")) target = withRunNotice(target);
  } catch (e) {
    if (e instanceof TaskNotOpen) target = `/review/${task.taskId}?stale=1`;
    else if (e instanceof TaskContextChanged) target = `/review/${task.taskId}?changed=1`;
    else if (e instanceof DecisionNotAllowed) target = `/review/${task.taskId}?error=1`;
    else throw e;
  }
  redirect(target);
}

/** Decides a review task from a decision form (`taskId`, `openedAt`, `decision` as JSON); see `decideAndRedirect`. */
export async function decideAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const fields = fieldsSchema.parse({
    taskId: formData.get("taskId"),
    openedAt: formData.get("openedAt") || undefined,
    taskKey: formData.get("taskKey") ?? undefined,
    decision: formData.get("decision"),
  });
  await decideAndRedirect(admin.email, fields, reviewDecisionSchema.parse(fields.decision));
}
