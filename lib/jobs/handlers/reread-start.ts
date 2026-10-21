import { getConfig } from "@/lib/config";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { startRereadForSubdivision } from "@/lib/pipeline/text/run";
import { subdivisionKeyOf } from "./tiles";

// Imported only by lib/jobs/registry.ts: it reaches a run starter, and through it the stage registry, which would
// close an import cycle from the stage module (ruling M5-P11).

/** Starts the re-read run of the subdivision (`startRereadForSubdivision`); no document to re-read, no run. */
export const mentionsRereadHandler: JobHandler<JobData> = async (data, ctx) => {
  const subdivisionKey = subdivisionKeyOf(data);
  const started = await startRereadForSubdivision(ctx.db, ctx.boss, subdivisionKey, getConfig(), data.runId);
  ctx.log.info({ subdivisionKey, reread: started }, started ? "re-read run started" : "no document to re-read");
};
