import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

/*
 * Locking and dismissing open review tasks the one way the place merge, the gazetteer merge and the confirmation all
 * use (rulings M5-F-R4 b, M5-FIN-R1 M-6).
 */

/** Dismisses the (locked) tasks `ids` with `context.dismissedReason` `reason`. */
export async function dismissTasks(tx: Db, ids: string[], reason: "superseded" | "object_ended" | "auto_confirmed"): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`
    update review_tasks set status = 'dismissed', context = context || ${JSON.stringify({ dismissedReason: reason })}::jsonb
    where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
}

/**
 * Locks the open tasks on the place `placeId` itself (`subject_type = 'place'`: a seed, bay, geocoding or restricted
 * area `place_candidate`) in one statement by id and returns their ids. Taken before any geo object or place row
 * (lock order M5-F-R4), so a merge that ends the place can dismiss them (UI-5).
 */
export async function lockOpenPlaceTasks(tx: Db, placeId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    select id from review_tasks
    where subject_type = 'place' and subject_id = ${placeId} and status = 'open'
    order by id
    for update
  `);
  return rows.map((r) => r.id);
}
