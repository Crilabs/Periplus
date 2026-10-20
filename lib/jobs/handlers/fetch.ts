import { z } from "zod";
import { createConverters, type RenderPage } from "@/lib/adapters/fetch";
import { getRenderer } from "@/lib/adapters/fetch/browser";
import { getCrawlTransport } from "@/lib/adapters/fetch/guarded";
import { createSimulatedFetcher, simulatedTransport, type SimulatedFetcher } from "@/lib/adapters/fetch/simulated";
import { getTransport, type Transport } from "@/lib/adapters/http";
import { runPdftotext } from "@/lib/adapters/pdf";
import { getArchive } from "@/lib/adapters/s3";
import { createAnthropicClient } from "@/lib/ai/anthropic";
import { getConfig } from "@/lib/config";
import { loadScenario } from "@/lib/domain/revisit/scenario";
import { getEnv, type Env } from "@/lib/env";
import { enqueueStageJobs } from "@/lib/jobs/enqueue";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { FETCH_SOURCE_STAGE, prepareSourceCrawl } from "@/lib/pipeline/fetch/source";
import { FETCH_URL_STAGE, fetchUrl, planFetchUrls } from "@/lib/pipeline/fetch/url";
import type { StageDefinition } from "@/lib/pipeline/runs";

/** Stage `fetch.source`: one job per source of the run (`run.params.sourceIds`). */
export const fetchSourceStage: StageDefinition = {
  name: FETCH_SOURCE_STAGE,
  queue: "fetch.source",
  async plan(_db, run) {
    const ids = z.array(z.string().min(1)).parse(run.params.sourceIds ?? []);
    return ids.map((sourceId) => ({ key: sourceId, sourceId }));
  },
};

/** Stage `fetch.url`: one job per planned frontier URL and per uploaded document; jobs add more as links are found. */
export const fetchUrlStage: StageDefinition = {
  name: FETCH_URL_STAGE,
  queue: "fetch.url",
  plan: planFetchUrls,
};

/** The page renderer of this process: Playwright unless `PERIPLUS_RENDERER=off` (then `render: auto` never renders). */
export function crawlRenderPage(env: Pick<Env, "PERIPLUS_RENDERER"> = getEnv()): RenderPage | undefined {
  return env.PERIPLUS_RENDERER === "off" ? undefined : getRenderer().render;
}

const runIdOf = (data: JobData): string => z.string().min(1).parse(data.runId);

let scenarioFetcher: { path: string; fetcher: Promise<SimulatedFetcher> } | undefined;

/**
 * The simulated web of a process with `PERIPLUS_SIMULATION` (its scenario loaded once per process), else null. A
 * failed load is not kept: the next job reads the file again.
 */
export function simulatedFetcherFor(env: Pick<Env, "PERIPLUS_SIMULATION"> = getEnv()): Promise<SimulatedFetcher> | null {
  const path = env.PERIPLUS_SIMULATION;
  if (!path) return null;
  if (scenarioFetcher?.path !== path) {
    const fetcher = loadScenario(path).then(createSimulatedFetcher);
    fetcher.catch(() => {
      if (scenarioFetcher?.fetcher === fetcher) scenarioFetcher = undefined;
    });
    scenarioFetcher = { path, fetcher };
  }
  return scenarioFetcher.fetcher;
}

/** The crawl's transport: the simulated one in a simulation (robots.txt 404, nothing else), else the guarded network. */
function crawlTransport(env: Pick<Env, "PERIPLUS_SIMULATION"> = getEnv()): Transport {
  return env.PERIPLUS_SIMULATION ? simulatedTransport : getCrawlTransport();
}

/** Reads robots.txt for the source and queues its start URLs (or pauses it on an explicit ban). */
export const fetchSourceHandler: JobHandler<JobData> = async (data, ctx) => {
  const sourceId = z.string().min(1).parse(data.sourceId);
  const runId = runIdOf(data);
  const result = await prepareSourceCrawl(
    ctx.db,
    sourceId,
    { transport: crawlTransport(), archive: getArchive() },
    { db: ctx.db, runId, stage: data.stage, sourceId },
  );
  ctx.log.info({ sourceId, ...result }, "source prepared for crawling");
};

const urlJobSchema = z.object({
  sourceId: z.string().min(1),
  url: z.string().min(1),
  depth: z.number().int().min(0),
  documentId: z.string().min(1).optional(),
  maxPages: z.number().int().min(1).optional(),
});

/** Fetches, converts and archives one URL; new links become jobs of the same stage. */
export const fetchUrlHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = urlJobSchema.parse(data);
  const runId = runIdOf(data);
  const cfg = getConfig().fetch;
  const simulated = await simulatedFetcherFor();
  // A simulation answers every page from its scenario: no converter service, renderer or model is ever asked.
  const deps = simulated
    ? {
        transport: simulatedTransport,
        converters: createConverters({ transport: simulatedTransport, cfg }),
        pdf: { pdftotext: runPdftotext },
        simulated,
      }
    : {
        transport: getCrawlTransport(),
        converters: createConverters({ transport: getTransport(), renderPage: crawlRenderPage(), cfg }),
        pdf: { pdftotext: runPdftotext, model: getEnv().ANTHROPIC_API_KEY ? createAnthropicClient(ctx.db) : undefined },
      };
  const result = await fetchUrl(
    ctx.db,
    job,
    {
      ...deps,
      archive: getArchive(),
      enqueue: (tx, jobs) => enqueueStageJobs(ctx.boss, "fetch.url", runId, FETCH_URL_STAGE, jobs, tx),
    },
    { db: ctx.db, runId, stage: data.stage, sourceId: job.sourceId },
  );
  ctx.log.info({ url: job.url, sourceId: job.sourceId, ...result }, "url fetched");
};
