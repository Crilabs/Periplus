import { simulationActive } from "@/lib/adapters/simulation";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { consolidationBlocked } from "@/lib/domain/consolidation/targets";
import { consolidateGeoJob, consolidationGeoJobs } from "@/lib/pipeline/consolidation/geo";
import { consolidationHighlightJobs } from "@/lib/pipeline/consolidation/highlights";
import {
  CONSOLIDATION_FOLLOWUP_STAGE,
  CONSOLIDATION_GEO_STAGE,
  CONSOLIDATION_HIGHLIGHTS_STAGE,
  CONSOLIDATION_SUMMARY_STAGE,
} from "@/lib/pipeline/consolidation/stages";
import { summarizeProfile, summaryJobs } from "@/lib/pipeline/consolidation/summary";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { modelClientFor } from "./ai-batch";

/** Stage `consolidation.geo`: one job per geo object of the run (`consolidationTargets`); none when quote fidelity blocks it. */
export const consolidationGeoStage: StageDefinition = {
  name: CONSOLIDATION_GEO_STAGE,
  queue: "consolidation.geo",
  plan: consolidationGeoJobs,
};

/** Consolidates `data.geoObjectId` for the run (`consolidateGeo`, regular or evaluation). */
export const consolidationGeoHandler: JobHandler<JobData> = async (data, ctx) => {
  const result = await consolidateGeoJob(ctx.db, data);
  ctx.log.info({ geoObjectId: data.geoObjectId, ...result }, "geo object consolidated");
};

/**
 * Stage `consolidation.highlights` (spec 16): one job per POI the run's places selected (`consolidationHighlightJobs`);
 * its jobs are `consolidation.geo` jobs, run by `consolidationGeoHandler`.
 */
export const consolidationHighlightsStage: StageDefinition = {
  name: CONSOLIDATION_HIGHLIGHTS_STAGE,
  queue: "consolidation.highlights",
  plan: consolidationHighlightJobs,
};

/** Stage `consolidation.summary`: one job per profile version to summarize (`summaryTargets`). */
export const consolidationSummaryStage: StageDefinition = {
  name: CONSOLIDATION_SUMMARY_STAGE,
  queue: "consolidation.summary",
  plan: summaryJobs,
};

/**
 * Summarizes profile version `data.version` of `data.geoObjectId` with the run's frozen `data.rulesVersion` (synchronous
 * model calls, outside any transaction).
 */
export const consolidationSummaryHandler: JobHandler<JobData> = async (data, ctx) => {
  if (typeof data.geoObjectId !== "string" || typeof data.version !== "number") throw new Error("geoObjectId and version are required");
  if (data.rulesVersion !== undefined && typeof data.rulesVersion !== "string") throw new Error("rulesVersion must be a string");
  const result = await summarizeProfile(
    ctx.db,
    { geoObjectId: data.geoObjectId, version: data.version, runId: data.runId, regenerate: data.regenerate === true, rulesVersion: data.rulesVersion },
    { model: modelClientFor(ctx.db) },
  );
  ctx.log.info({ geoObjectId: data.geoObjectId, version: data.version, ...result }, "profile summary");
};

/**
 * Stage `consolidation.followup` (plan only, ruling M5-P11; its handler is `consolidation-followup.ts`): one job, none
 * for an evaluation run, a run whose quote fidelity blocked its consolidation, or in a simulated revisit (ruling M7-P8:
 * its revisit runs leave the stage out, and no other run of that process may reach DataForSEO either).
 */
export const consolidationFollowupStage: StageDefinition = {
  name: CONSOLIDATION_FOLLOWUP_STAGE,
  queue: "consolidation.followup",
  async plan(db, run) {
    if (run.params.evaluation === true || simulationActive()) return [];
    if (await consolidationBlocked(db, run.id)) return [];
    return [{ key: "followup" }];
  },
};
