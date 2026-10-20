import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { consolidateGeo, type ConsolidateResult } from "@/lib/domain/consolidation/store";
import { clearConsolidationSkipped, markConsolidationSkipped } from "@/lib/domain/consolidation/skipped";
import { consolidationBlocked, consolidationTargets } from "@/lib/domain/consolidation/targets";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";

/*
 * Stage `consolidation.geo` (plan Task 16): one job per geo object of the run (`consolidationTargets`), each
 * `consolidateGeo` in its own READ COMMITTED transaction, never inside another one (ruling M5-F-R4). No import of
 * `lib/pipeline/runs`: the job handlers import this module.
 */

/**
 * Plan of `consolidation.geo`: nothing when the run's quote fidelity is below 100 % (`consolidationBlocked`, logged
 * `consolidation blocked by quote fidelity` and stored as the run's skip marker, `markConsolidationSkipped`), else one
 * job per target carrying the mode (`evaluation` for an evaluation run), the rules version the run froze at its start
 * (text, geometry and consolidation runs, ruling M7-E-R1; only a run from before that has none, and its consolidation
 * takes the active one, `activeRulesVersion`) and an evaluation run's extraction candidate.
 */
export async function consolidationGeoJobs(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> {
  if (await consolidationBlocked(db, run.id)) {
    createLogger("consolidation").warn({ runId: run.id }, "consolidation blocked by quote fidelity");
    // Stored, so the run page keeps „Konsolidierung nachholen“ once a recheck lifts the block (ruling M5-H-R2).
    await markConsolidationSkipped(db, run.id, "quote_fidelity");
    return [];
  }
  // A failed run revived after all consolidates now: no marker (ruling M5-H-R2).
  await clearConsolidationSkipped(db, run.id);
  const mode = run.params.evaluation === true ? "evaluation" : "regular";
  const rulesVersion = typeof run.params.rulesVersion === "string" ? run.params.rulesVersion : undefined;
  const extraction = mode === "evaluation" ? extractionSchema.optional().parse(run.params.extraction) : undefined;
  return (await consolidationTargets(db, run)).map((geoObjectId) => ({
    key: geoObjectId,
    geoObjectId,
    mode,
    ...(rulesVersion ? { rulesVersion } : {}),
    ...(extraction ? { extraction } : {}),
  }));
}

/** An extraction candidate of an evaluation run (`params.extraction`, ruling M7-P11). */
const extractionSchema = z.strictObject({ model: z.string().min(1), promptVersion: z.number().int().positive() });

const jobSchema = z.object({
  geoObjectId: z.uuid(),
  runId: z.uuid(),
  mode: z.enum(["regular", "evaluation"]),
  rulesVersion: z.string().min(1).optional(),
  extraction: extractionSchema.optional(),
});

/** Job of `consolidation.geo`: consolidates `data.geoObjectId` for the run (run date from the run row). */
export async function consolidateGeoJob(db: Db, data: JobData): Promise<ConsolidateResult> {
  const job = jobSchema.parse(data);
  return consolidateGeo(db, job.geoObjectId, { runId: job.runId, mode: job.mode, rulesVersion: job.rulesVersion, extraction: job.extraction });
}
