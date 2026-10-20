import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import type { TaskDraft } from "./changes";

/*
 * The open profile tasks (`conflict`, `uncertain_change`) of one geo object, locked and dismissed the one way the
 * consolidation (`consolidateGeo`) and the place merge (`mergePlaceInto`) both use (rulings M5-F-R4 b, M5-FIN-R1 M-6).
 */

export type OpenTask = { id: string; kind: TaskDraft["kind"]; attribute: string; context: unknown };

/** The subject id prefix of an object's profile tasks: `<geoObjectId>:`. */
export const subjectPrefix = (geoObjectId: string) => `${geoObjectId}:`;

/**
 * Locks the open `conflict` / `uncertain_change` tasks of the object in one statement, by task id (the order a
 * decision locking several of them must follow). Under READ COMMITTED a row a concurrent decision holds is waited
 * for and re-checked: a task decided meanwhile is not returned (ruling M5-F-R2).
 */
export async function lockOpenTasks(tx: Db, geoObjectId: string): Promise<Map<string, OpenTask>> {
  const prefix = subjectPrefix(geoObjectId);
  const { rows } = await tx.execute<{ id: string; kind: TaskDraft["kind"]; subject_id: string; context: unknown }>(sql`
    select id, kind::text as kind, subject_id, context from review_tasks
    where kind in ('conflict', 'uncertain_change') and left(subject_id, ${prefix.length}) = ${prefix} and status = 'open'
    order by id
    for update
  `);
  return new Map(rows.map((r) => [`${r.kind}:${r.subject_id.slice(prefix.length)}`, { id: r.id, kind: r.kind, attribute: r.subject_id.slice(prefix.length), context: r.context }]));
}

/** Dismisses the (locked) tasks `ids` with `context.dismissedReason` `reason`. */
export async function dismissTasks(tx: Db, ids: string[], reason: "superseded" | "object_ended"): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`
    update review_tasks set status = 'dismissed', context = context || ${JSON.stringify({ dismissedReason: reason })}::jsonb
    where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
}
