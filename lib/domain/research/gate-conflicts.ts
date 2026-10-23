import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { createReviewTask } from "@/lib/domain/review";

/*
 * Conflicts of the reference gate as review tasks (plan N3): a confirmed place the reference does not know is asked
 * about once; the human decision „Liegeplatz“ / „Kein Liegeplatz“ is the only thing that changes a status, and the gate
 * reads it back (`gateDecisions`). The task says „nicht in der Referenz“, never a value of the reference.
 */

/** Subject type of the task; its subject id is the place id. */
export const RESEARCH_CONFLICT_SUBJECT = "research_conflict";

/** The status reason of a place a human decided is no berth. */
export const NOT_BERTH_REASON = "Kein Liegeplatz laut Prüfung (Navily-Test)";

/**
 * Makes the open research-conflict tasks match `conflictPlaceIds`: one open task per place (none twice, none again for a
 * place a human decided already), and an open task of a place that is no conflict any more is dismissed with
 * `context.dismissedReason` `no_longer_conflict`. `threshold`: the confirmation threshold the conflict was found at.
 * Returns the tasks created and the open ones after the sync.
 */
export async function syncConflictTasks(db: Db, conflictPlaceIds: string[], threshold: number): Promise<{ created: number; open: number }> {
  const ids = [...new Set(conflictPlaceIds)].sort();
  return db.transaction(async (tx) => {
    const decided = new Set(
      ids.length === 0
        ? []
        : (
            await tx
              .select({ id: reviewTasks.subjectId })
              .from(reviewTasks)
              .where(and(eq(reviewTasks.kind, "research_conflict"), eq(reviewTasks.status, "decided"), inArray(reviewTasks.subjectId, ids)))
          ).map((r) => r.id),
    );
    const wanted = ids.filter((id) => !decided.has(id));
    let created = 0;
    for (const placeId of wanted) {
      const task = await createReviewTask(tx, { kind: "research_conflict", subjectType: RESEARCH_CONFLICT_SUBJECT, subjectId: placeId, context: { threshold } });
      if (task.created) created++;
    }
    await tx
      .update(reviewTasks)
      .set({ status: "dismissed", context: sql`${reviewTasks.context} || ${JSON.stringify({ dismissedReason: "no_longer_conflict" })}::jsonb` })
      .where(
        and(
          eq(reviewTasks.kind, "research_conflict"),
          eq(reviewTasks.status, "open"),
          wanted.length === 0 ? undefined : notInArray(reviewTasks.subjectId, wanted),
        ),
      );
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(reviewTasks)
      .where(and(eq(reviewTasks.kind, "research_conflict"), eq(reviewTasks.status, "open")));
    return { created, open: n };
  });
}

/**
 * The human decisions on the research conflicts of `placeIds`: the newest decision of each place, whatever the place's
 * status now (a place rejected by „Kein Liegeplatz“ stays in the gate count as an error). Places without a decision
 * are left out.
 */
export async function gateDecisions(db: Db, placeIds: string[]): Promise<Map<string, "berth" | "not_berth">> {
  if (placeIds.length === 0) return new Map();
  const rows = await db
    .select({ placeId: reviewTasks.subjectId, decision: reviewDecisions.decision })
    .from(reviewTasks)
    .innerJoin(reviewDecisions, eq(reviewDecisions.taskId, reviewTasks.id))
    .where(and(eq(reviewTasks.kind, "research_conflict"), eq(reviewTasks.status, "decided"), inArray(reviewTasks.subjectId, [...new Set(placeIds)])))
    .orderBy(desc(reviewDecisions.decidedAt), desc(reviewDecisions.id));
  const out = new Map<string, "berth" | "not_berth">();
  for (const r of rows) {
    const action = (r.decision as { action?: unknown }).action;
    if ((action === "berth" || action === "not_berth") && !out.has(r.placeId)) out.set(r.placeId, action);
  }
  return out;
}
