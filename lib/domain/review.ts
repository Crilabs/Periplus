import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { reviewTasks, type ReviewKind } from "@/lib/db/schema";

export type ReviewTaskInput = {
  kind: ReviewKind;
  subjectType: string;
  subjectId: string;
  context: Record<string, unknown>;
  priority?: number;
};

/**
 * Opens a review task unless an open one for the same (kind, subjectId) exists; then returns that one.
 * Backed by the partial unique index `review_tasks_open_subject_unique`, so it is safe under concurrency.
 */
export async function createReviewTask(db: Db, input: ReviewTaskInput): Promise<{ id: string; created: boolean }> {
  const [inserted] = await db
    .insert(reviewTasks)
    .values({
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      context: input.context,
      priority: input.priority ?? 0,
    })
    .onConflictDoNothing({
      target: [reviewTasks.kind, reviewTasks.subjectId],
      where: sql`${reviewTasks.status} = 'open'`,
    })
    .returning({ id: reviewTasks.id });
  if (inserted) return { id: inserted.id, created: true };

  const [existing] = await db
    .select({ id: reviewTasks.id })
    .from(reviewTasks)
    .where(
      and(eq(reviewTasks.kind, input.kind), eq(reviewTasks.subjectId, input.subjectId), eq(reviewTasks.status, "open")),
    );
  if (!existing) throw new Error(`open review task for ${input.kind}/${input.subjectId} vanished during insert`);
  return { id: existing.id, created: false };
}

/**
 * Whether a task of this kind for this subject was ever decided; with `contextContains`, only tasks whose context
 * contains that JSON fragment count.
 */
export async function hasDecidedTask(
  db: Db,
  kind: ReviewKind,
  subjectId: string,
  contextContains?: Record<string, unknown>,
): Promise<boolean> {
  const [row] = await db
    .select({ id: reviewTasks.id })
    .from(reviewTasks)
    .where(
      and(
        eq(reviewTasks.kind, kind),
        eq(reviewTasks.subjectId, subjectId),
        eq(reviewTasks.status, "decided"),
        contextContains ? sql`${reviewTasks.context} @> ${JSON.stringify(contextContains)}::jsonb` : undefined,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The open task of this kind for this subject, if any. */
export async function openTaskFor(db: Db, kind: ReviewKind, subjectId: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: reviewTasks.id })
    .from(reviewTasks)
    .where(and(eq(reviewTasks.kind, kind), eq(reviewTasks.subjectId, subjectId), eq(reviewTasks.status, "open")));
  return row ?? null;
}
