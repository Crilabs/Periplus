import { getTransport } from "@/lib/adapters/http";
import { getArchive } from "@/lib/adapters/s3";
import { gazetteerScope } from "@/lib/domain/gazetteer/scope";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { DATASETS_STAGE, datasetKindsOf, importDataset } from "@/lib/pipeline/datasets";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { subdivisionKeyOf } from "./tiles";

/** Stage `datasets.import`: one job per requested dataset (`run.params.datasets`, default all) of `run.params.subdivisionKey`. */
export const datasetsImportStage: StageDefinition = {
  name: DATASETS_STAGE,
  queue: "datasets.import",
  async plan(db, run) {
    const subdivisionKey = subdivisionKeyOf(run.params);
    await gazetteerScope(db, subdivisionKey); // fail planning for an unknown subdivision
    return datasetKindsOf(run.params).map((dataset) => ({ key: `${dataset}:${subdivisionKey}`, dataset, subdivisionKey }));
  },
};

/** Imports `data.dataset` for `data.subdivisionKey`. */
export const datasetsImportHandler: JobHandler<JobData> = async (data, ctx) => {
  const scope = await gazetteerScope(ctx.db, subdivisionKeyOf(data));
  const [dataset] = datasetKindsOf({ datasets: [data.dataset] });
  const result = await importDataset(
    ctx.db,
    dataset!,
    { scope, runId: data.runId },
    { transport: getTransport(), archive: getArchive() },
  );
  ctx.log.info({ subdivisionKey: scope.key, dataset, ...result }, "dataset imported");
};
