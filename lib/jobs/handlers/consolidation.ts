import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { consolidationBlocked } from "@/lib/domain/consolidation/targets";
import { CONSOLIDATION_FOLLOWUP_STAGE, CONSOLIDATION_SUMMARY_STAGE } from "@/lib/pipeline/consolidation/stages";
import { summarizeProfile, summaryJobs } from "@/lib/pipeline/consolidation/summary";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { modelClientFor } from "./ai-batch";

/** Stage `consolidation.summary`: one job per profile version to summarize (`summaryTargets`). */
export const consolidationSummaryStage: StageDefinition = {
  name: CONSOLIDATION_SUMMARY_STAGE,
  queue: "consolidation.summary",
  plan: summaryJobs,
};

/** Summarizes profile version `data.version` of `data.geoObjectId` (synchronous model calls, outside any transaction). */
export const consolidationSummaryHandler: JobHandler<JobData> = async (data, ctx) => {
  if (typeof data.geoObjectId !== "string" || typeof data.version !== "number") throw new Error("geoObjectId and version are required");
  const result = await summarizeProfile(ctx.db, { geoObjectId: data.geoObjectId, version: data.version, runId: data.runId }, { model: modelClientFor(ctx.db) });
  ctx.log.info({ geoObjectId: data.geoObjectId, version: data.version, ...result }, "profile summary");
};

/**
 * Stage `consolidation.followup` (plan only, ruling M5-P11; its handler is `consolidation-followup.ts`): one job, none
 * for an evaluation run or a run whose quote fidelity blocked its consolidation.
 */
export const consolidationFollowupStage: StageDefinition = {
  name: CONSOLIDATION_FOLLOWUP_STAGE,
  queue: "consolidation.followup",
  async plan(db, run) {
    if (run.params.evaluation === true) return [];
    if (await consolidationBlocked(db, run.id)) return [];
    return [{ key: "followup" }];
  },
};
