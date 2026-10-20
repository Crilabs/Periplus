import { deliveryArchive } from "@/lib/domain/delivery/archive";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { getRun } from "@/lib/domain/runs";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { DELIVERY_STAGE, deliveryAreaId } from "@/lib/pipeline/delivery";
import type { StageDefinition } from "@/lib/pipeline/runs";

/** Stage `delivery.build`: exactly one job, the area of `run.params.areaId`. */
export const deliveryBuildStage: StageDefinition = {
  name: DELIVERY_STAGE,
  queue: "delivery.build",
  async plan(_db, run) {
    const areaId = deliveryAreaId(run.params);
    return [{ key: areaId, areaId }];
  },
};

/**
 * Builds the package of `data.areaId` (spec 08). A rejected package is a finished job (its report is the result, a
 * retry would build the same package); a failure to read or store throws, so the job is retried.
 */
export const deliveryBuildHandler: JobHandler<JobData> = async (data, ctx) => {
  const areaId = deliveryAreaId(data);
  const runId = data.runId ?? ctx.runId;
  const run = runId ? await getRun(ctx.db, runId) : null;
  const result = await buildDelivery(ctx.db, deliveryArchive(), areaId, { runId, triggeredBy: run?.triggeredBy });
  ctx.log.info(
    {
      areaId,
      deliveryId: result.deliveryId,
      status: result.status,
      dataVersion: result.dataVersion,
      failedChecks: result.report.checks.filter((c) => !c.ok).length,
    },
    "delivery built",
  );
};
