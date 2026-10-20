import { getConfig } from "@/lib/config";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { AREA_IMPORT_STAGE, runAreaImport } from "@/lib/pipeline/areas-import";
import type { StageDefinition } from "@/lib/pipeline/runs";

/** Stage `areas.import`: one job importing all bot files; the report goes to the job log. */
export const areaImportStage: StageDefinition = {
  name: AREA_IMPORT_STAGE,
  queue: "areas.import",
  async plan() {
    return [{ key: "import" }];
  },
};

export const areaImportHandler: JobHandler<JobData> = async (_data, ctx) => {
  const reports = await runAreaImport(ctx.db, getConfig());
  ctx.log.info({ reports }, "areas imported");
};
