import { computeMeasurement } from "@/lib/domain/quality/snapshot";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { measurementParams, QUALITY_MEASURE_STAGE } from "@/lib/pipeline/quality-stages";
import type { StageDefinition } from "@/lib/pipeline/runs";

/** Stage `quality.measure`: exactly one job, the subdivision of `run.params.subdivisionKey` (ruling M7-P5). */
export const qualityMeasureStage: StageDefinition = {
  name: QUALITY_MEASURE_STAGE,
  queue: "quality.measure",
  async plan(_db, run) {
    const { subdivisionKey } = measurementParams(run.params);
    return [{ key: subdivisionKey, subdivisionKey }];
  },
};

/**
 * Computes and stores the quality snapshot of the job's measurement run (spec 10). A retried job writes nothing twice
 * (`computeQualitySnapshot` skips a run with rows).
 */
export const qualityMeasureHandler: JobHandler<JobData> = async (_data, ctx) => {
  if (!ctx.runId) throw new Error("quality.measure needs the job's run");
  const result = await computeMeasurement(ctx.db, ctx.runId);
  ctx.log.info({ runId: ctx.runId, subdivisionKey: result.subdivisionKey, rows: result.rows, skipped: result.skipped }, "quality measured");
};
