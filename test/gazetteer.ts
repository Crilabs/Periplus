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
