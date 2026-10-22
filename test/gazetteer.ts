import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geoObjects, reviewTasks } from "@/lib/db/schema";

/**
 * Geo objects created by the calling test's transaction (`created_at = now()`, the transaction start).
 * Other test files commit geo rows to the shared database meanwhile, so never count geo objects or
 * review tasks database-wide; scope them to these rows.
 */
export const createdInThisTransaction = sql`${geoObjects.createdAt} = now()`;

export async function ownGeoObjectIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: geoObjects.id }).from(geoObjects).where(createdInThisTransaction);
  return rows.map((r) => r.id);
}

/** `place_candidate` pair tasks (`subjectId "<id>:<id>"`) naming at least one of `objectIds`, by id. */
export async function pairTasksOf(db: Db, objectIds: string[]): Promise<Array<{ id: string; subjectId: string }>> {
  if (objectIds.length === 0) return [];
  return db
    .select({ id: reviewTasks.id, subjectId: reviewTasks.subjectId })
    .from(reviewTasks)
    .where(
      and(
        eq(reviewTasks.kind, "place_candidate"),
        eq(reviewTasks.subjectType, "geo_object_pair"),
        or(
          inArray(sql`split_part(${reviewTasks.subjectId}, ':', 1)`, objectIds),
          inArray(sql`split_part(${reviewTasks.subjectId}, ':', 2)`, objectIds),
        ),
      ),
    )
    .orderBy(reviewTasks.id);
}

/** The pair task of `a` and `b` with its decision (`action`, `decidedBy`), or undefined without one. */
export async function pairTaskOf(
  db: Db,
  a: string,
  b: string,
): Promise<{ status: string; action: string | null; decidedBy: string | null } | undefined> {
  const { rows } = await db.execute<{ status: string; action: string | null; decided_by: string | null }>(sql`
    select t.status, d.decision->>'action' as action, d.decided_by
    from review_tasks t left join review_decisions d on d.task_id = t.id
    where t.kind = 'place_candidate' and t.subject_id = ${[a, b].sort().join(":")}`);
  const [row] = rows;
  return row && { status: row.status, action: row.action, decidedBy: row.decided_by };
}
