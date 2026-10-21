import { getConfig, type AppConfig } from "@/lib/config";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { AREA_IMPORT_STAGE, runAreaImport } from "@/lib/pipeline/areas-import";
import type { StageDefinition } from "@/lib/pipeline/runs";

/**
 * Stage `areas.import`: in a subdivision build (`run.params.subdivisionKey`) one job importing the bot file of the
 * subdivision's country, so a broken or slow file of another country never touches the build; without a subdivision
 * one job importing all files. The report goes to the job log.
 */
export const areaImportStage: StageDefinition = {
  name: AREA_IMPORT_STAGE,
  queue: "areas.import",
  async plan(db, run) {
    const key = run.params.subdivisionKey;
    if (typeof key !== "string" || key === "") return [{ key: "import" }];
    const { country } = await requireSubdivision(db, key, { allowExcluded: true });
    return [{ key: country, country }];
  },
};

/** The handler reading the files of `dir` (default `config/area-imports`) with `cfg` (default the app config). */
export function areaImportHandlerFor(dir?: string, cfg?: AppConfig): JobHandler<JobData> {
  return async (data, ctx) => {
    const country = typeof data.country === "string" ? data.country : undefined;
    const reports = await runAreaImport(ctx.db, cfg ?? getConfig(), { dir, country });
    ctx.log.info({ country: country ?? "all", reports }, "areas imported");
  };
}

export const areaImportHandler: JobHandler<JobData> = areaImportHandlerFor();
