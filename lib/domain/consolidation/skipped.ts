import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { CONSOLIDATION_GEO_STAGE } from "@/lib/pipeline/consolidation/stages";

/*
 * The stored marker of a run whose consolidation was skipped (ruling M5-H-R2): the quote fidelity blocked it at the plan
 * of `consolidation.geo`, or the run failed or was ended before that stage. Stored in `runs.params`, not computed live,
 * so the run page keeps offering „Konsolidierung nachholen“ after a recheck has lifted the block.
 */

export type ConsolidationSkipReason = "quote_fidelity" | "run_failed" | "run_ended";

export type ConsolidationSkip = {
  reason: ConsolidationSkipReason;
  /** When the consolidation was skipped (ISO time). */
  at: string;
  /** The consolidation run that caught up on it; null while none has. */
  catchUpRunId: string | null;
};

const SKIP_KEY = "consolidationSkipped";
const CATCH_UP_KEY = "consolidationCatchUpRunId";
const REASONS: readonly ConsolidationSkipReason[] = ["quote_fidelity", "run_failed", "run_ended"];

/** The skip marker in a run's params; null for a run whose consolidation was not skipped. */
export function consolidationSkipOf(params: Record<string, unknown>): ConsolidationSkip | null {
  const raw = params[SKIP_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const { reason, at } = raw as { reason?: unknown; at?: unknown };
  if (!REASONS.includes(reason as ConsolidationSkipReason) || typeof at !== "string") return null;
  const catchUp = params[CATCH_UP_KEY];
  return { reason: reason as ConsolidationSkipReason, at, catchUpRunId: typeof catchUp === "string" ? catchUp : null };
}

/**
 * Marks the run's consolidation as skipped for `reason`: only a run whose `consolidation.geo` stage has not begun (still
 * `pending`) and that is no evaluation run. A later reason replaces an earlier one (a failed run revived later and then
 * blocked by its quote check). Returns whether it marked the run.
 */
export async function markConsolidationSkipped(db: Db, runId: string, reason: ConsolidationSkipReason): Promise<boolean> {
  const { rows } = await db.execute<{ id: string }>(sql`
    update runs set params = params || jsonb_build_object(${SKIP_KEY}::text, jsonb_build_object('reason', ${reason}::text, 'at', now()))
    where id = ${runId}
      and coalesce(params ->> 'evaluation', '') <> 'true'
      and exists (
        select 1 from run_stages s where s.run_id = runs.id and s.stage = ${CONSOLIDATION_GEO_STAGE} and s.status = 'pending'
      )
    returning id
  `);
  return rows.length > 0;
}

/**
 * Removes the skip marker when the run's consolidation does take place after all (a failed run revived, its
 * `consolidation.geo` planned unblocked); a marker that was caught up on stays.
 */
export async function clearConsolidationSkipped(db: Db, runId: string): Promise<void> {
  await db.execute(sql`
    update runs set params = params - ${SKIP_KEY}::text
    where id = ${runId} and params ? ${SKIP_KEY} and not (params ? ${CATCH_UP_KEY})
  `);
}

/** Records the consolidation run that caught up on the run's skipped consolidation. */
export async function recordConsolidationCatchUp(db: Db, runId: string, catchUpRunId: string): Promise<void> {
  await db.execute(sql`
    update runs set params = params || jsonb_build_object(${CATCH_UP_KEY}::text, ${catchUpRunId}::text) where id = ${runId}
  `);
}

/** Removes the record of a catch-up run that never started (its first stage could not be enqueued). */
export async function clearConsolidationCatchUp(db: Db, runId: string, catchUpRunId: string): Promise<void> {
  await db.execute(sql`
    update runs set params = params - ${CATCH_UP_KEY}::text where id = ${runId} and params ->> ${CATCH_UP_KEY} = ${catchUpRunId}
  `);
}
