import { z } from "zod";
import { createConverters, type RenderPage } from "@/lib/adapters/fetch";
import { getRenderer } from "@/lib/adapters/fetch/browser";
import { getCrawlTransport } from "@/lib/adapters/fetch/guarded";
import { createSimulatedFetcher, simulatedTransport, type SimulatedFetcher } from "@/lib/adapters/fetch/simulated";
import { getTransport, type Transport } from "@/lib/adapters/http";
import { runPdftotext } from "@/lib/adapters/pdf";
import { getArchive } from "@/lib/adapters/s3";
import { modelClientFor } from "./ai-batch";
import { getConfig } from "@/lib/config";
import { parseScenario, readScenarioFile } from "@/lib/domain/revisit/scenario";
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

let scenarioCache: { path: string; hash: string; fetcher: SimulatedFetcher } | undefined;

/** What `simulatedFetcherFor` reports when it (re)loads a scenario. */
export type ScenarioLoaded = { path: string; name: string; hash: string };

/**
 * The simulated web of a process with `PERIPLUS_SIMULATION`, else null. The scenario is cached by path and content
 * hash: each job reads the file, and an edited file (e.g. an entry added between two `sim:revisit` calls while the
 * worker keeps running) is validated and used at once instead of the old one (`onLoad` names it). A failed load is
 * not kept: the job fails and the next one reads the file again.
 */
export async function simulatedFetcherFor(
  env: Pick<Env, "PERIPLUS_SIMULATION"> = getEnv(),
  onLoad?: (loaded: ScenarioLoaded) => void,
): Promise<SimulatedFetcher | null> {
  const path = env.PERIPLUS_SIMULATION;
  if (!path) return null;
  const { hash, text } = await readScenarioFile(path);
  if (scenarioCache?.path === path && scenarioCache.hash === hash) return scenarioCache.fetcher;
  const scenario = parseScenario(text, path);
  scenarioCache = { path, hash, fetcher: createSimulatedFetcher(scenario) };
  onLoad?.({ path, name: scenario.name, hash });
  return scenarioCache.fetcher;
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

/**
 * The fetch dependencies of a simulation (ruling M7-P8): every page from the scenario's fetcher, the simulated
 * transport for robots.txt and the converters, no converter service, renderer or model. Shared with the revisit
 * integration test, so it drives exactly this wiring (ruling M7-G-R3).
 */
export function simulatedFetchDeps(simulated: SimulatedFetcher, cfg: ReturnType<typeof getConfig>["fetch"]) {
  return {
    transport: simulatedTransport,
    converters: createConverters({ transport: simulatedTransport, cfg }),
    pdf: { pdftotext: runPdftotext },
    simulated,
  };
}

/** Fetches, converts and archives one URL; new links become jobs of the same stage. */
export const fetchUrlHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = urlJobSchema.parse(data);
  const runId = runIdOf(data);
  const cfg = getConfig().fetch;
  const simulated = await simulatedFetcherFor(getEnv(), (loaded) => ctx.log.info(loaded, "simulation scenario loaded"));
  // A simulation answers every page from its scenario: no converter service, renderer or model is ever asked.
  const deps = simulated
    ? simulatedFetchDeps(simulated, cfg)
    : {
        transport: getCrawlTransport(),
        converters: createConverters({ transport: getTransport(), renderPage: crawlRenderPage(), cfg }),
        // The model client of the worker (`setModelClientFactory`), like every other AI stage (OPS-7).
        pdf: { pdftotext: runPdftotext, model: getEnv().ANTHROPIC_API_KEY ? modelClientFor(ctx.db) : undefined },
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
