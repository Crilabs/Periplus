import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { requestPlaceDiscovery } from "@/lib/pipeline/consolidation/followup";

// Imported only by lib/jobs/registry.ts (like run-advance.ts): it reaches a run starter, and through it the stage
// registry, which would close an import cycle from any stage module (ruling M5-P11).

/** Requests a targeted source discovery for the thin places of the run (`requestPlaceDiscovery`). */
export const consolidationFollowupHandler: JobHandler<JobData> = async (data, ctx) => {
  if (typeof data.runId !== "string") throw new Error("runId is required");
  const result = await requestPlaceDiscovery(ctx.db, ctx.boss, data.runId);
  ctx.log.info(result, "consolidation follow-up");
};
