import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { freezeRevisitRun, REVISIT_FREEZE_STAGE } from "@/lib/pipeline/revisit-stages";
import type { StageDefinition } from "@/lib/pipeline/runs";

/** Stage `revisit.freeze`: exactly one job, after the crawl and before the text stages (ruling M7-P6). */
export const revisitFreezeStage: StageDefinition = {
  name: REVISIT_FREEZE_STAGE,
  queue: "revisit.freeze",
  async plan() {
    return [{ key: "freeze" }];
  },
};

/** Freezes the revisit run's version set and gone objects (`freezeRevisitRun`; a retry keeps the first list). */
export const revisitFreezeHandler: JobHandler<JobData> = async (_data, ctx) => {
  if (!ctx.runId) throw new Error("revisit.freeze needs the job's run");
  const frozen = await freezeRevisitRun(ctx.db, ctx.runId);
  ctx.log.info(
    { runId: ctx.runId, versions: frozen.documentVersionIds.length, goneGeoObjects: frozen.goneGeoObjectIds.length, frozenBefore: frozen.frozenBefore },
    "revisit run frozen",
  );
};
