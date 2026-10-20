import { getTransport } from "@/lib/adapters/http";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { seedWikivoyage, WIKIVOYAGE_STAGE } from "@/lib/pipeline/sources/wikivoyage";
import { subdivisionKeyOf } from "./tiles";

/** Stage `sources.wikivoyage`: one job for the run's subdivision (`run.params.subdivisionKey`). */
export const wikivoyageStage: StageDefinition = {
  name: WIKIVOYAGE_STAGE,
  queue: "sources.wikivoyage",
  async plan(db, run) {
    const subdivisionKey = subdivisionKeyOf(run.params);
    await requireSubdivision(db, subdivisionKey); // fail planning for an unknown subdivision
    return [{ key: subdivisionKey, subdivisionKey }];
  },
};

/** Queues the Wikivoyage articles of the subdivision; Wikidata is a fixed API endpoint, so the plain transport. */
export const wikivoyageHandler: JobHandler<JobData> = async (data, ctx) => {
  const subdivisionKey = subdivisionKeyOf(data);
  const result = await seedWikivoyage(ctx.db, subdivisionKey, { transport: getTransport() }, { db: ctx.db, runId: data.runId, stage: data.stage });
  ctx.log.info({ subdivisionKey, ...result }, "wikivoyage articles queued");
};
