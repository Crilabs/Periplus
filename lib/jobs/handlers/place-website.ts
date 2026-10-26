import { z } from "zod";
import { getCrawlTransport } from "@/lib/adapters/fetch/guarded";
import { getTransport } from "@/lib/adapters/http";
import { getArchive } from "@/lib/adapters/s3";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { PLACE_WEBSITE_STAGE } from "@/lib/pipeline/places/stage-name";
import { planPlaceWebsites, runPlaceWebsiteJob } from "@/lib/pipeline/places/website-stage";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { modelClientFor } from "./ai-batch";

/** Stage `places.website`: one job per marina or port of the run's subdivision without website. */
export const placeWebsiteStage: StageDefinition = {
  name: PLACE_WEBSITE_STAGE,
  queue: "places.website",
  plan: planPlaceWebsites,
};

const jobSchema = z.object({ placeId: z.uuid(), geoObjectId: z.uuid(), runId: z.uuid() });

/**
 * Finds, records and approves the website of one place (`runPlaceWebsiteJob`). The search goes through DataForSEO, the
 * hits' pages through the crawl transport (address guard: the URLs come from search results).
 */
export const placeWebsiteHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = jobSchema.parse(data);
  const result = await runPlaceWebsiteJob(ctx.db, job, {
    transport: getTransport(),
    crawlTransport: getCrawlTransport(),
    archive: getArchive(),
    model: modelClientFor(ctx.db),
  });
  ctx.log.info({ placeId: job.placeId, ...result }, "place website");
};
