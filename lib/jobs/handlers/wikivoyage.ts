import { getTransport } from "@/lib/adapters/http";
import { areaByKey } from "@/lib/config";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { seedWikivoyage, WIKIVOYAGE_STAGE } from "@/lib/pipeline/sources/wikivoyage";
import { areaKeyOf } from "./tiles";

/** Stage `sources.wikivoyage`: one job for the run's area (`run.params.areaKey`). */
export const wikivoyageStage: StageDefinition = {
  name: WIKIVOYAGE_STAGE,
  queue: "sources.wikivoyage",
  async plan(_db, run) {
    const areaKey = areaKeyOf(run.params);
    areaByKey(areaKey); // fail planning for an unknown area
    return [{ key: areaKey, areaKey }];
  },
};

/** Queues the Wikivoyage articles of the area; Wikidata is a fixed API endpoint, so the plain transport. */
export const wikivoyageHandler: JobHandler<JobData> = async (data, ctx) => {
  const areaKey = areaKeyOf(data);
  const result = await seedWikivoyage(ctx.db, areaKey, { transport: getTransport() }, { db: ctx.db, runId: data.runId, stage: data.stage });
  ctx.log.info({ areaKey, ...result }, "wikivoyage articles queued");
};
