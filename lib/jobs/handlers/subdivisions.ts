import { getTransport } from "@/lib/adapters/http";
import { getArchive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { COARSE_STAGE, coarseCountries, importCoarse, importCoarseFeatures, importSeas, SEAS_STAGE } from "@/lib/pipeline/gazetteer/coarse";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { assignCoarse, buildSubdivisions, SUBDIVISIONS_ASSIGN_STAGE, SUBDIVISIONS_STAGE } from "@/lib/pipeline/subdivisions";

/** The IHO seas: one job, a stage before the countries so each country job finds them (B14). */
export const gazetteerSeasStage: StageDefinition = {
  name: SEAS_STAGE,
  queue: "gazetteer.coarse",
  async plan() {
    return [{ key: "seas" }];
  },
};

/** The coarse gazetteer: one job per country, only `params.countries` when the run names them. */
export const gazetteerCoarseStage: StageDefinition = {
  name: COARSE_STAGE,
  queue: "gazetteer.coarse",
  async plan(_db, run) {
    return coarseCountries(run.params).map((country) => ({ key: country, country }));
  },
};

/** Queue `gazetteer.coarse` serves both stages: the seas job, and the boundaries and coarse features of one country. */
export const gazetteerCoarseHandler: JobHandler<JobData> = async (data, ctx) => {
  if (!data.runId) throw new Error("gazetteer.coarse job without runId");
  if (data.stage === SEAS_STAGE) {
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

/**
 * The assignment of the coarse objects: one job per configured country, also in a run limited to some countries, since
 * `subdivisions.build` may have replaced subdivisions of any country.
 */
export const subdivisionsAssignStage: StageDefinition = {
  name: SUBDIVISIONS_ASSIGN_STAGE,
  queue: "subdivisions.build",
  async plan() {
    return Object.keys(getConfig().subdivisions.countries).map((country) => ({ key: country, country }));
  },
};

/** Queue `subdivisions.build` serves both stages: the Landesteil list, and the assignment of one country. */
export const subdivisionsBuildHandler: JobHandler<JobData> = async (data, ctx) => {
  if (data.stage === SUBDIVISIONS_ASSIGN_STAGE) {
    if (typeof data.country !== "string") throw new Error("subdivisions.assign job without country");
    const result = await assignCoarse(ctx.db, data.country);
    ctx.log.info({ country: data.country, ...result }, "coarse objects assigned");
    return;
  }
  const { warnings, ...result } = await buildSubdivisions(ctx.db);
  ctx.log.info({ ...result, deviations: result.deviations.length, warnings: warnings.length }, "subdivisions built");
};
