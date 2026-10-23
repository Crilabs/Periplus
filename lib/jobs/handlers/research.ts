import { z } from "zod";
import { createConverters } from "@/lib/adapters/fetch";
import { getCrawlTransport } from "@/lib/adapters/fetch/guarded";
import { getTransport } from "@/lib/adapters/http";
import { runPdftotext } from "@/lib/adapters/pdf";
import { getArchive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { assessPages, planResearchAssess, RESEARCH_ASSESS_QUEUE, RESEARCH_ASSESS_STAGE } from "@/lib/pipeline/research/assess";
import { fetchResearchPage, planResearchFetch, RESEARCH_FETCH_STAGE } from "@/lib/pipeline/research/fetch";
import { planResearchSearch, RESEARCH_SEARCH_STAGE, searchCandidate } from "@/lib/pipeline/research/search";
import { modelClientFor } from "./ai-batch";
import { crawlRenderPage, simulatedFetchDeps, simulatedFetcherFor } from "./fetch";

/** Stage `research.search`: one job per candidate of the run (`run.params.subdivisionKey` or `placeIds`). */
export const researchSearchStage: StageDefinition = {
  name: RESEARCH_SEARCH_STAGE,
  queue: "research.search",
  plan: planResearchSearch,
};

/** Stage `research.fetch`: one job per distinct hit URL of the run's candidates. */
export const researchFetchStage: StageDefinition = {
  name: RESEARCH_FETCH_STAGE,
  queue: "research.fetch",
  plan: (db, run) => planResearchFetch(db, run),
};

/** Stage `research.assess`: the unassessed hit page versions of the run's candidates, as message batches. */
export const researchAssessStage: StageDefinition = {
  name: RESEARCH_ASSESS_STAGE,
  queue: RESEARCH_ASSESS_QUEUE,
  plan: (db, run) => planResearchAssess(db, run),
};

const runIdOf = (data: JobData): string => z.string().min(1).parse(data.runId);

const searchJobSchema = z.object({ placeId: z.uuid() });

/** Makes the positive and negative queries of one candidate and records its hits. */
export const researchSearchHandler: JobHandler<JobData> = async (data, ctx) => {
  const { placeId } = searchJobSchema.parse(data);
  const result = await searchCandidate(ctx.db, placeId, { transport: getTransport(), archive: getArchive() }, { db: ctx.db, runId: runIdOf(data), stage: data.stage });
  ctx.log.info({ placeId, ...result }, "candidate searched");
};

const fetchJobSchema = z.object({ url: z.string().min(1) });

/** Fetches, converts and archives one hit page (no frontier, no links). */
export const researchFetchHandler: JobHandler<JobData> = async (data, ctx) => {
  const { url } = fetchJobSchema.parse(data);
  const runId = runIdOf(data);
  const cfg = getConfig().fetch;
  const simulated = await simulatedFetcherFor(getEnv(), (loaded) => ctx.log.info(loaded, "simulation scenario loaded"));
  const deps = simulated
    ? simulatedFetchDeps(simulated, cfg)
    : {
        transport: getCrawlTransport(),
        converters: createConverters({ transport: getTransport(), renderPage: crawlRenderPage(), cfg }),
        pdf: { pdftotext: runPdftotext, model: getEnv().ANTHROPIC_API_KEY ? modelClientFor(ctx.db) : undefined },
      };
  const result = await fetchResearchPage(ctx.db, url, { ...deps, archive: getArchive(), enqueue: async () => 0 }, { db: ctx.db, runId, stage: data.stage });
  ctx.log.info({ url, ...result }, "research page fetched");
};

const assessJobSchema = z.object({
  runId: z.string().uuid(),
  stage: z.string().min(1),
  key: z.string().min(1),
  documentVersionIds: z.array(z.string().uuid()).min(1),
});

/** Sends one job's page versions to `assess-page` as a message batch; the poll job stores the assessments. */
export const researchAssessHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = assessJobSchema.parse(data);
  const result = await assessPages(ctx.db, { model: modelClientFor(ctx.db), boss: ctx.boss, archive: getArchive() }, job);
  ctx.log.info({ versions: job.documentVersionIds.length, ...result }, "page assessment batch submitted");
};
