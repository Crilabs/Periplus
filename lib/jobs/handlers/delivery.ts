import { deliveryArchive } from "@/lib/domain/delivery/archive";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { runTriggeredBy } from "@/lib/domain/runs";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { DELIVERY_STAGE, deliverySubdivisionId } from "@/lib/pipeline/delivery";
import type { StageDefinition } from "@/lib/pipeline/runs";

/** Stage `delivery.build`: exactly one job, the subdivision of `run.params.subdivisionId`. */
export const deliveryBuildStage: StageDefinition = {
  name: DELIVERY_STAGE,
  queue: "delivery.build",
  async plan(_db, run) {
    const subdivisionId = deliverySubdivisionId(run.params);
    return [{ key: subdivisionId, subdivisionId }];
  },
};

/**
 * Builds the package of `data.subdivisionId` (spec 08) on the pool (`ctx.db`). A rejected package is a finished job (its
 * report is the result, a retry would build the same package) and is logged as a warning; a failure to read or store
 * throws, so the job is retried.
 */
export const deliveryBuildHandler: JobHandler<JobData> = async (data, ctx) => {
  const subdivisionId = deliverySubdivisionId(data);
  const triggeredBy = ctx.runId ? await runTriggeredBy(ctx.db, ctx.runId) : null;
  const result = await buildDelivery(ctx.db, deliveryArchive(), subdivisionId, { runId: ctx.runId, triggeredBy: triggeredBy ?? undefined });
  const failed = result.report.checks.filter((c) => !c.ok);
  const fields = { subdivisionId, deliveryId: result.deliveryId, status: result.status, dataVersion: result.dataVersion, failedChecks: failed.length };
  if (result.status === "rejected") ctx.log.warn({ ...fields, checks: failed.map((c) => c.name) }, "delivery rejected");
  else ctx.log.info(fields, "delivery built");
};
