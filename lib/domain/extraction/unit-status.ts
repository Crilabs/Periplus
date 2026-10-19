import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

/*
 * Terminal states of extraction units and what they mean for their mentions (ruling M4-G-R3): a unit that failed for
 * good leaves its mentions `failed` instead of `done` (claimed by a regular run, ruling M4-P17), so they are visible
 * and only an explicit reprocess extracts them again (no automatic retry: every retry costs). A unit a revived batch
 * still completes later turns its mentions back to `done`. Reprocess and comparison runs never claim mentions, so
 * their units change no mention status.
 */

/** Sets the mentions of the given units `failed` where their (regular) extraction run had claimed them. */
export async function failUnitMentions(db: Db, unitIds: string[]): Promise<void> {
  if (unitIds.length === 0) return;
  await db.execute(sql`
    update mentions m set extraction_status = 'failed'
    from extraction_units u join extraction_runs r on r.id = u.extraction_run_id
    where u.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(unitIds)}::jsonb))
      and r.purpose = 'regular' and m.id = any(u.mention_ids) and m.extraction_status = 'done'
  `);
}

/** Sets the `failed` mentions of a unit that completed after all back to `done`. */
export async function restoreUnitMentions(db: Db, unitId: string): Promise<void> {
  await db.execute(sql`
    update mentions m set extraction_status = 'done'
    from extraction_units u
    where u.id = ${unitId} and m.id = any(u.mention_ids) and m.extraction_status = 'failed'
  `);
}

/**
 * Fails every extraction unit of the run that is still `pending` or `submitted`, with its mentions; returns their ids.
 * Called when a stage of the run finishes and when an admin ends the run: stages run in order, so at that point every
 * unit of the run belongs to a stage whose jobs and batches all have their outcome, and an open unit can no longer be
 * sent or distributed (a job left it out, a batch row was never written, a deferred job ran out of attempts). A batch
 * revived by a manual retry may still complete such a unit, which then turns `done` (`restoreUnitMentions`).
 */
export async function failOpenUnits(db: Db, runId: string): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    update extraction_units u set status = 'failed', updated_at = now()
    from extraction_runs r
    where r.id = u.extraction_run_id and r.run_id = ${runId} and u.status in ('pending', 'submitted')
    returning u.id
  `);
  const ids = rows.map((r) => r.id);
  await failUnitMentions(db, ids);
  return ids;
}
