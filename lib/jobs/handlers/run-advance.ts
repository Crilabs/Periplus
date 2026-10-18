import { getRun } from "@/lib/domain/runs";
import { enqueueStage } from "@/lib/pipeline/runs";
import type { JobData, JobHandler } from "@/lib/jobs/worker";

/**
 * Plans and enqueues the next stage of a run. A stage that is no longer pending was already advanced
 * (e.g. this job is repeated after its first attempt committed), so the job does nothing.
 */
export const advanceHandler: JobHandler<JobData> = async (data, ctx) => {
  const runId = String(data.runId);
  const nextStage = String(data.nextStage);
  const run = await getRun(ctx.db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const stage = run.stages.find((s) => s.stage === nextStage);
  if (!stage) throw new Error(`run ${runId} has no stage ${nextStage}`);
  if (stage.status !== "pending") {
    ctx.log.info({ nextStage, status: stage.status }, "stage already advanced, skipping");
    return;
  }
  await enqueueStage(ctx.db, ctx.boss, runId, nextStage);
};
