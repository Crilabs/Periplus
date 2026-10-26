import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { reviewDecisions, reviewTasks } from "@/lib/db/schema";

/*
 * Decisions the system takes itself (the research confirmation, the kind switch by evidence): recorded like an admin's
 * decision as a decided pseudo task with one `review_decisions` row by `system`.
 */

export const SYSTEM_ACTOR = "system";

/** Whether an open duplicate review (`geo_object_pair`) names the object on either side. */
export async function hasOpenPairTask(tx: Db, geoObjectId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ open: boolean }>(sql`
    select exists (
      select 1 from review_tasks
      where kind = 'place_candidate' and subject_type = 'geo_object_pair' and status = 'open'
        and (split_part(subject_id, ':', 1) = ${geoObjectId} or split_part(subject_id, ':', 2) = ${geoObjectId})
    ) as open
  `);
  return rows[0]?.open === true;
}

/** One decided pseudo task on the place with its `system` decision (also used by the research confirmation). */
export async function recordDecision(tx: Db, placeId: string, subjectType: "place_kind" | "place_status", previous: string, decision: Record<string, unknown>, now: Date) {
  const [task] = await tx
    .insert(reviewTasks)
    .values({ kind: "place_candidate", subjectType, subjectId: placeId, context: { previous }, status: "decided" })
    .returning({ id: reviewTasks.id });
  await tx.insert(reviewDecisions).values({ taskId: task!.id, decision, decidedBy: SYSTEM_ACTOR, decidedAt: now });
}
