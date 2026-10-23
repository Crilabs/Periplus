import { eq } from "drizzle-orm";
import { z } from "zod";
import { createConverters } from "@/lib/adapters/fetch";
import { getCrawlTransport } from "@/lib/adapters/fetch/guarded";
import { getTransport } from "@/lib/adapters/http";
import { runPdftotext } from "@/lib/adapters/pdf";
import { getArchive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import { runs } from "@/lib/db/schema";
import { consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import { getEnv } from "@/lib/env";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { assessPages, planResearchAssess, RESEARCH_ASSESS_QUEUE, RESEARCH_ASSESS_STAGE } from "@/lib/pipeline/research/assess";
import { planResearchConfirm, RESEARCH_CONFIRM_STAGE } from "@/lib/pipeline/research/confirm";
import { RESEARCH_EXTRACT_QUEUE, RESEARCH_EXTRACT_STAGE, extractUnits, planResearchExtract } from "@/lib/pipeline/research/extract";
import {
  discoverStops,
  extractResearchRoutes,
  planResearchDiscover,
  planResearchRoutes,
  RESEARCH_DISCOVER_STAGE,
  RESEARCH_ROUTES_QUEUE,
  RESEARCH_ROUTES_STAGE,
} from "@/lib/pipeline/research/routes";
import { fetchResearchPage, planResearchFetch, RESEARCH_FETCH_STAGE } from "@/lib/pipeline/research/fetch";
import { buildBerthState, bundleFactsJob, planResearchState, RESEARCH_STATE_QUEUE, RESEARCH_STATE_STAGE } from "@/lib/pipeline/research/state";
import { planResearchSearch, RESEARCH_SEARCH_STAGE, searchCandidate } from "@/lib/pipeline/research/search";
import { modelClientFor } from "./ai-batch";
import { crawlRenderPage } from "./fetch";

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

/** Stage `research.extract`: the research units (page version × berth) of the run's candidates, as message batches. */
export const researchExtractStage: StageDefinition = {
  name: RESEARCH_EXTRACT_STAGE,
  queue: RESEARCH_EXTRACT_QUEUE,
  plan: (db, run) => planResearchExtract(db, run, getConfig(), getArchive()),
};

/** Stage `research.routes`: the route sections of the trip reports among the run's hit pages, as message batches. */
export const researchRoutesStage: StageDefinition = {
  name: RESEARCH_ROUTES_STAGE,
  queue: RESEARCH_ROUTES_QUEUE,
  plan: (db, run) => planResearchRoutes(db, run),
};

/** Stage `research.discover`: one job per page with open route stops. */
export const researchDiscoverStage: StageDefinition = {
  name: RESEARCH_DISCOVER_STAGE,
  queue: "research.discover",
  plan: (db, run) => planResearchDiscover(db, run),
};

/** Stage `research.confirm`: one job applying the confirmation rule to the run's candidates. */
export const researchConfirmStage: StageDefinition = {
  name: RESEARCH_CONFIRM_STAGE,
  queue: "research.confirm",
  plan: () => planResearchConfirm(),
};

/** Stage `research.state`: the state of each confirmed berth of the run (build jobs and fact bundling batches). */
export const researchStateStage: StageDefinition = {
  name: RESEARCH_STATE_STAGE,
  queue: RESEARCH_STATE_QUEUE,
  plan: (db, run) => planResearchState(db, run),
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
  // No simulation branch: a research fetch always goes to the real web (`fetchResearchPage` does not read `deps.simulated`).
  const deps = {
    transport: getCrawlTransport(),
    converters: createConverters({ transport: getTransport(), renderPage: crawlRenderPage(), cfg }),
    pdf: { pdftotext: runPdftotext, model: getEnv().ANTHROPIC_API_KEY ? modelClientFor(ctx.db) : undefined },
  };
  const result = await fetchResearchPage(ctx.db, url, { ...deps, archive: getArchive(), enqueue: async () => 0 }, { db: ctx.db, runId, stage: data.stage });
  ctx.log.info({ url, ...result }, "research page fetched");
};

const assessJobSchema = z.object({
  runId: z.uuid(),
  stage: z.string().min(1),
  key: z.string().min(1),
  documentVersionIds: z.array(z.uuid()).min(1),
});

/** Sends one job's page versions to `assess-page` as a message batch; the poll job stores the assessments. */
export const researchAssessHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = assessJobSchema.parse(data);
  const result = await assessPages(ctx.db, { model: modelClientFor(ctx.db), boss: ctx.boss, archive: getArchive() }, job);
  ctx.log.info({ versions: job.documentVersionIds.length, ...result }, "page assessment batch submitted");
};

const extractJobSchema = z.object({
  runId: z.uuid(),
  stage: z.string().min(1),
  key: z.string().min(1),
  unitIds: z.array(z.uuid()).min(1),
});

/** Sends one job's research units to `extract-berth` as a message batch; the poll job stores the extractions. */
export const researchExtractHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = extractJobSchema.parse(data);
  const result = await extractUnits(ctx.db, { model: modelClientFor(ctx.db), boss: ctx.boss, archive: getArchive() }, job);
  ctx.log.info({ units: job.unitIds.length, ...result }, "berth extraction batch submitted");
};

const routesJobSchema = z
  .object({
    runId: z.uuid(),
    stage: z.string().min(1),
    key: z.string().min(1),
    versionIds: z.array(z.uuid()).optional(),
    sectionIds: z.array(z.string().min(1)).optional(),
  })
  .refine((j) => (j.versionIds?.length ?? 0) + (j.sectionIds?.length ?? 0) > 0, "a route job needs versions or sections");

/** Sends one job's trip report sections to `extract-route` as a message batch; the poll job stores the stops. */
export const researchRoutesHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = routesJobSchema.parse(data);
  const result = await extractResearchRoutes(ctx.db, { model: modelClientFor(ctx.db), boss: ctx.boss, archive: getArchive() }, job);
  ctx.log.info(
    {
      versions: job.versionIds?.length ?? 0,
      sections: job.sectionIds?.length ?? 0,
      ...result,
    },
    "research route batch submitted",
  );
};

const discoverJobSchema = z.object({
  runId: z.uuid(),
  stage: z.string().min(1),
  key: z.string().min(1),
  documentVersionId: z.uuid(),
});

/** Assigns the open route stops of one page to places (`matchStops`). */
export const researchDiscoverHandler: JobHandler<JobData> = async (data, ctx) => {
  await discoverStops(ctx.db, discoverJobSchema.parse(data));
};

const stateBuildSchema = z.object({ runId: z.uuid(), placeId: z.uuid() });
const stateBundleSchema = z.object({ runId: z.uuid(), stage: z.string().min(1), key: z.string().min(1), placeIds: z.array(z.uuid()).min(1) });

/**
 * Job of `research.state`: a job with `placeIds` sends those berths' free facts to `bundle-facts` as a message batch
 * (the poll job stores the bundled facts); a job with `placeId` builds the berth's state (core values, landing points,
 * reachable) with the rules version the run froze at its start (`params.rulesVersion`, else the active one).
 */
export const researchStateHandler: JobHandler<JobData> = async (data, ctx) => {
  if (Array.isArray(data.placeIds)) {
    const job = stateBundleSchema.parse(data);
    const result = await bundleFactsJob(ctx.db, { model: modelClientFor(ctx.db), boss: ctx.boss }, job, RESEARCH_STATE_QUEUE);
    ctx.log.info({ places: job.placeIds.length, ...result }, "fact bundling batch submitted");
    return;
  }
  const { runId, placeId } = stateBuildSchema.parse(data);
  const [run] = await ctx.db.select({ params: runs.params }).from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} does not exist`);
  const rules = await consolidationConfigFor(ctx.db, (run.params as Record<string, unknown>).rulesVersion);
  const result = await buildBerthState(ctx.db, placeId, { runId, rules });
  ctx.log.info({ placeId, ...result }, "berth state");
};
