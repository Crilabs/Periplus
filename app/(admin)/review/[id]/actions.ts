"use server";

import { redirect } from "next/navigation";
import { z, ZodError } from "zod";
import { changeRateEnum, DOC_TYPES } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { retryFailedJob } from "@/lib/domain/jobs-view";
import {
  DecisionNotAllowed,
  decideReviewTask,
  reviewDecisionSchema,
  TaskNotOpen,
  type ReviewDecision,
} from "@/lib/domain/review-decisions";
import { nextTaskHref } from "@/lib/domain/review-view";
import { getBoss } from "@/lib/jobs/boss";
import type { QueueName } from "@/lib/jobs/queues";
import { requireAdmin } from "@/lib/security/require-admin";
import type { CrawlRules } from "@/lib/domain/sources/crawl-rules";
import { parseCrawlRulesForm } from "../../_components/crawl-rules-fields";

const taskFieldsSchema = z.object({
  taskId: z.uuid(),
  openedAt: z.iso.datetime().optional(),
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

const approvalFieldsSchema = z.object({
  type: z.enum(DOC_TYPES),
  // A blank field is invalid, never 0 (as on the source page).
  weight: z.string().trim().min(1).pipe(z.coerce.number<string>().min(0).max(1)),
  changeRate: z.enum(changeRateEnum.enumValues),
});

const taskFields = (formData: FormData) =>
  taskFieldsSchema.parse({ taskId: formData.get("taskId"), openedAt: formData.get("openedAt") || undefined });

/**
 * Decides the task, then redirects to the next open task of the same kind (or `/review`). An already decided
 * task redirects back with `?stale=1`, a decision that does not fit the task with `?error=1`.
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
    await decideReviewTask(
      db,
      { taskId: task.taskId, decision, decidedBy, openedAt: task.openedAt ? new Date(task.openedAt) : undefined },
      { retryJob },
    );
    target = await nextTaskHref(db, task.taskId);
  } catch (e) {
    if (e instanceof TaskNotOpen) target = `/review/${task.taskId}?stale=1`;
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
    decision: formData.get("decision"),
  });
  await decideAndRedirect(admin.email, fields, reviewDecisionSchema.parse(fields.decision));
}

/**
 * Approves a source proposal from the approval form (`type`, `weight`, `changeRate` and the `CrawlRulesFields`).
 * Invalid fields redirect back with `?invalid=<field>,…` and write nothing; otherwise see `decideAndRedirect`.
 */
export async function approveSourceAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const task = taskFields(formData);
  const values = approvalFieldsSchema.safeParse({
    type: formData.get("type"),
    weight: formData.get("weight") ?? "",
    changeRate: formData.get("changeRate"),
  });
  const invalid = values.success ? [] : values.error.issues.map((i) => String(i.path[0]));
  let crawlRules: CrawlRules | undefined;
  try {
    crawlRules = parseCrawlRulesForm(formData);
  } catch (e) {
    if (!(e instanceof ZodError)) throw e;
    invalid.push(...e.issues.map((i) => String(i.path[0])));
  }
  if (!values.success || !crawlRules) {
    return redirect(`/review/${task.taskId}?invalid=${[...new Set(invalid)].join(",")}`);
  }
  await decideAndRedirect(admin.email, task, { action: "approve", ...values.data, crawlRules });
}
