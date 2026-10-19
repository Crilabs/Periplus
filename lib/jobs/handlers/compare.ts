import { z } from "zod";
import { createConverters } from "@/lib/adapters/fetch";
import { getCrawlTransport } from "@/lib/adapters/fetch/guarded";
import { getTransport } from "@/lib/adapters/http";
import { getArchive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { COMPARE_STAGE, compareSample, planCompareSamples } from "@/lib/pipeline/compare-converters";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { crawlRenderPage } from "./fetch";

/** Stage `compare.converters`: one job per sample page of the run (`run.params.sampleIds`). */
export const compareConvertersStage: StageDefinition = {
  name: COMPARE_STAGE,
  queue: "compare.converters",
  plan: planCompareSamples,
};

const jobSchema = z.object({ sampleId: z.string().min(1), runId: z.string().min(1) });

/**
 * Converts one sample page with all three converters. The page itself goes through the crawl transport (crawled
 * address, guarded); Jina and Firecrawl are fixed API endpoints (plain transport), as in the crawl.
 */
export const compareConvertersHandler: JobHandler<JobData> = async (data, ctx) => {
  const { sampleId, runId } = jobSchema.parse(data);
  await compareSample(
    ctx.db,
    sampleId,
    {
      transport: getCrawlTransport(),
      archive: getArchive(),
      converters: createConverters({ transport: getTransport(), renderPage: crawlRenderPage(), cfg: getConfig().fetch }),
    },
    { db: ctx.db, runId, stage: data.stage },
  );
  ctx.log.info({ sampleId }, "sample compared");
};
