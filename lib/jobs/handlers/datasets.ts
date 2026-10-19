import { getTransport } from "@/lib/adapters/http";
import { getArchive } from "@/lib/adapters/s3";
import { areaByKey } from "@/lib/config";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { DATASETS_STAGE, datasetKindsOf, importDataset } from "@/lib/pipeline/datasets";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { areaKeyOf } from "./tiles";

/** Stage `datasets.import`: one job per requested dataset (`run.params.datasets`, default all) of `run.params.areaKey`. */
export const datasetsImportStage: StageDefinition = {
  name: DATASETS_STAGE,
  queue: "datasets.import",
  async plan(_db, run) {
    const areaKey = areaKeyOf(run.params);
    areaByKey(areaKey); // fail planning for an unknown area
    return datasetKindsOf(run.params).map((dataset) => ({ key: `${dataset}:${areaKey}`, dataset, areaKey }));
  },
};

/** Imports `data.dataset` for `data.areaKey`. */
export const datasetsImportHandler: JobHandler<JobData> = async (data, ctx) => {
  const area = areaByKey(areaKeyOf(data));
  const [dataset] = datasetKindsOf({ datasets: [data.dataset] });
  const result = await importDataset(
    ctx.db,
    dataset!,
    { area, runId: data.runId },
    { transport: getTransport(), archive: getArchive() },
  );
  ctx.log.info({ areaKey: area.key, dataset, ...result }, "dataset imported");
};
