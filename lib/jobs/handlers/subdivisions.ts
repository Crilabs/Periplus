import { getTransport } from "@/lib/adapters/http";
import { getArchive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { COARSE_STAGE, importCoarse, importCoarseFeatures, importSeas } from "@/lib/pipeline/gazetteer/coarse";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { buildSubdivisions, SUBDIVISIONS_STAGE } from "@/lib/pipeline/subdivisions";

/** Job key of the sea import within the stage `gazetteer.coarse`; every other job is a country code. */
const SEAS_KEY = "seas";

/** The coarse gazetteer: one job for the IHO seas, one per configured country. */
export const gazetteerCoarseStage: StageDefinition = {
  name: COARSE_STAGE,
  queue: "gazetteer.coarse",
  async plan() {
    return [{ key: SEAS_KEY }, ...Object.keys(getConfig().subdivisions.countries).map((country) => ({ key: country, country }))];
  },
};

export const gazetteerCoarseHandler: JobHandler<JobData> = async (data, ctx) => {
  if (!data.runId) throw new Error("gazetteer.coarse job without runId");
  if (data.key === SEAS_KEY) {
    const created = await importSeas(ctx.db, { transport: getTransport(), runId: data.runId });
    ctx.log.info({ created }, "seas imported");
    return;
  }
  if (typeof data.country !== "string") throw new Error("gazetteer.coarse job without country");
  const deps = { transport: getTransport(), archive: getArchive(), runId: data.runId };
  const result = await importCoarse(ctx.db, data.country, deps);
  ctx.log.info({ country: data.country, ...result }, "boundaries imported");
  const features = await importCoarseFeatures(ctx.db, data.country, deps);
  ctx.log.info({ country: data.country, ...features }, "coarse features imported");
};

/** The Landesteil list: one job per run. */
export const subdivisionsBuildStage: StageDefinition = {
  name: SUBDIVISIONS_STAGE,
  queue: "subdivisions.build",
  async plan() {
    return [{ key: "subdivisions" }];
  },
};

export const subdivisionsBuildHandler: JobHandler<JobData> = async (_data, ctx) => {
  const { warnings, ...result } = await buildSubdivisions(ctx.db);
  ctx.log.info({ ...result, deviations: result.deviations.length, warnings: warnings.length }, "subdivisions built");
};
