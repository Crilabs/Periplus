import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

/*
 * Blocks of an extraction run outside its quote check (ruling M4-H-R3). Only the check (`checkQuoteFidelity`) finishes
 * an extraction run, and only for what was stored when it ran. Results distributed after that (a dead-lettered poll
 * retried by hand) are verified when stored, but the check's counters and result no longer cover them, so the run is
 * `blocked` with reason `late_results` until the check is run again. A run ended by hand never reaches its check
 * stage; its unchecked extraction runs are `blocked` with reason `run_ended`. A run that fails (a stage whose jobs all
 * failed, a failed stage transition) never reaches it either; they are `blocked` with reason `run_failed` (ruling
 * M4-FIN-R1). "Belegtreue neu prüfen" lifts either block once every quote holds up. A blocked run is never active
 * (`activeExtractionRun`).
 */

/**
 * Called in the transaction that stores results (facts of a unit, a route) into the extraction run: blocks the run with
 * reason `late_results` when it is no longer `running`. The row lock orders it against the check, which locks the row
 * too: either the check waits and then sees these results, or this waits and then sees the check's status. Returns
 * whether the run was blocked here.
 */
export async function blockLateResults(db: Db, extractionRunId: string): Promise<boolean> {
  const { rows } = await db.execute<{ status: string }>(sql`select status from extraction_runs where id = ${extractionRunId} for update`);
  if (!rows[0] || rows[0].status === "running") return false;
  await db.execute(sql`
    update extraction_runs set status = 'blocked', blocked_reason = 'late_results', finished_at = coalesce(finished_at, now())
    where id = ${extractionRunId}
  `);
  return true;
}

/**
 * Blocks every extraction run of the run that has not been checked yet (no `quote_check`, still `running`) with
 * `reason`: `run_ended` when an admin ends the run, `run_failed` when the run fails, so none of them stays `running`
 * for ever. Returns their ids.
 */
export async function blockUncheckedRuns(db: Db, runId: string, reason: "run_ended" | "run_failed"): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    update extraction_runs set status = 'blocked', blocked_reason = ${reason}, finished_at = now()
    where run_id = ${runId} and status = 'running' and quote_check is null
    returning id
  `);
  return rows.map((r) => r.id);
}
