import { z } from "zod";
import { getTransport } from "@/lib/adapters/http";
import { getArchive } from "@/lib/adapters/s3";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { CHECK_QUEUE, CHECK_STAGE, checkExtractionRun, planCheck } from "@/lib/pipeline/text/check";
import { CLASSIFY_QUEUE, CLASSIFY_STAGE, classifyVersions, planClassify } from "@/lib/pipeline/text/classify";
import { DISAMBIGUATE_QUEUE, DISAMBIGUATE_STAGE, disambiguateMatches, planDisambiguate } from "@/lib/pipeline/text/disambiguate";
import { EXTRACT_QUEUE, EXTRACT_STAGE, extractUnits, planExtraction } from "@/lib/pipeline/text/extract";
import { GEOCODE_QUEUE, GEOCODE_STAGE, geocodeCandidate, planGeocode } from "@/lib/pipeline/text/geocode";
import { ROUTE_QUEUE, ROUTE_STAGE, extractRoutes, planRoutes } from "@/lib/pipeline/text/routes";
import { MENTIONS_QUEUE, MENTIONS_STAGE, matchVersions, planMentions } from "@/lib/pipeline/text/mentions";
import { modelClientFor } from "./ai-batch";

/*
 * Text stages are planned lazily, when each stage starts (`enqueueStage`). They therefore plan from the run's frozen
 * version set (`frozenRunVersions`, ruling M4-E-R2), never from a re-resolved `pending`/`tileId`/`areaKey`: the
 * passes written by `mentions.batch` would make `pending` empty for every later stage. `mentions.geocode` plans from it
 * as well, and so do `extraction.mention` and `extraction.route`. `extraction.check` plans from the run's extraction runs, which come from
 * that set.
 */

/** Stage `classify.document_version`: one job per `unitsPerBatch` versions of the text run. */
export const classifyDocumentVersionStage: StageDefinition = {
  name: CLASSIFY_STAGE,
  queue: CLASSIFY_QUEUE,
  plan: (db, run) => planClassify(db, run),
};

const classifyJobSchema = z.object({
  runId: z.string().uuid(),
  stage: z.string().min(1),
  key: z.string().min(1),
  documentVersionIds: z.array(z.string().uuid()).min(1),
});

/** Sends one job's versions to the classification as a message batch; the poll job stores the results. */
export const classifyDocumentVersionHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = classifyJobSchema.parse(data);
  const result = await classifyVersions(ctx.db, { model: modelClientFor(ctx.db), boss: ctx.boss, archive: getArchive() }, job);
  ctx.log.info({ versions: job.documentVersionIds.length, ...result }, "classification batch submitted");
};

/** Stage `mentions.batch`: the deterministic name match, `versionsPerJob` versions per job. */
export const mentionsBatchStage: StageDefinition = {
  name: MENTIONS_STAGE,
  queue: MENTIONS_QUEUE,
  plan: (db, run) => planMentions(db, run),
};

const mentionsJobSchema = z.object({
  runId: z.string().uuid(),
  stage: z.string().min(1),
  key: z.string().min(1),
  versionIds: z.array(z.string().uuid()).min(1),
});

/** Matches one job's versions (each in its own transaction; a retried job adds nothing twice). */
export const mentionsBatchHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = mentionsJobSchema.parse(data);
  const counts = await matchVersions(ctx.db, job);
  ctx.log.info({ versions: job.versionIds.length, ...counts }, "versions matched");
};

/** Stage `mentions.disambiguate`: the pending ambiguous matches of the run, `unitsPerBatch` per job. */
export const mentionsDisambiguateStage: StageDefinition = {
  name: DISAMBIGUATE_STAGE,
  queue: DISAMBIGUATE_QUEUE,
  plan: (db, run) => planDisambiguate(db, run),
};

const disambiguateJobSchema = z.object({
  runId: z.string().uuid(),
  stage: z.string().min(1),
  key: z.string().min(1),
  ambiguousIds: z.array(z.string().uuid()).min(1),
});

/** Sends one job's ambiguous matches to the disambiguation as a message batch; the poll job applies the answers. */
export const disambiguateMentionsHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = disambiguateJobSchema.parse(data);
  const result = await disambiguateMatches(ctx.db, { model: modelClientFor(ctx.db), boss: ctx.boss }, job);
  ctx.log.info({ matches: job.ambiguousIds.length, ...result }, "disambiguation batch submitted");
};

/** Stage `mentions.geocode`: one job per name candidate of the run's unmatched names (spec 06, new names). */
export const mentionsGeocodeStage: StageDefinition = {
  name: GEOCODE_STAGE,
  queue: GEOCODE_QUEUE,
  plan: (db, run) => planGeocode(db, run),
};

const geocodeJobSchema = z.object({
  runId: z.string().uuid(),
  stage: z.string().min(1),
  key: z.string().min(1),
  candidateId: z.string().uuid(),
});

/** Searches one name candidate in Nominatim (at most one request per second) and opens its review task. */
export const geocodeNameCandidateHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = geocodeJobSchema.parse(data);
  const result = await geocodeCandidate(ctx.db, job.candidateId, { transport: getTransport() }, { runId: job.runId });
  ctx.log.info({ candidateId: job.candidateId, ...(result ?? { skipped: "decided" }) }, "name candidate geocoded");
};

/** Stage `extraction.mention`: the run's pending mentions as extraction units, `unitsPerBatch` units per job. */
export const extractionMentionStage: StageDefinition = {
  name: EXTRACT_STAGE,
  queue: EXTRACT_QUEUE,
  plan: (db, run) => planExtraction(db, run),
};

const extractJobSchema = z.object({
  runId: z.string().uuid(),
  stage: z.string().min(1),
  key: z.string().min(1),
  extractionRunId: z.string().uuid(),
  unitIds: z.array(z.string().uuid()).min(1),
});

/** Sends one job's extraction units to `extract-facts` as a message batch; the poll job stores the facts. */
export const extractMentionsHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = extractJobSchema.parse(data);
  const result = await extractUnits(ctx.db, { model: modelClientFor(ctx.db), boss: ctx.boss }, job);
  ctx.log.info({ units: job.unitIds.length, ...result }, "extraction batch submitted");
};

/** Stage `extraction.route`: the run's trip reports without a route, `unitsPerBatch` versions per job. */
export const extractionRouteStage: StageDefinition = {
  name: ROUTE_STAGE,
  queue: ROUTE_QUEUE,
  plan: (db, run) => planRoutes(db, run),
};

const routeJobSchema = z
  .object({
    runId: z.string().uuid(),
    stage: z.string().min(1),
    key: z.string().min(1),
    extractionRunId: z.string().uuid(),
    versionIds: z.array(z.string().uuid()).optional(),
    sectionIds: z.array(z.string().min(1)).optional(),
  })
  .refine((j) => (j.versionIds?.length ?? 0) + (j.sectionIds?.length ?? 0) > 0, "a route job needs versions or sections");

/** Sends one job's report sections to `extract-route` as a message batch; the poll job stores the routes. */
export const extractRoutesHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = routeJobSchema.parse(data);
  const result = await extractRoutes(ctx.db, { model: modelClientFor(ctx.db), boss: ctx.boss, archive: getArchive() }, job);
  ctx.log.info({ versions: job.versionIds?.length ?? 0, sections: job.sectionIds?.length ?? 0, ...result }, "route batch submitted");
};

/** Stage `extraction.check`: one job per extraction run of the run (stats, quote check, finished or blocked). */
export const extractionCheckStage: StageDefinition = {
  name: CHECK_STAGE,
  queue: CHECK_QUEUE,
  plan: (db, run) => planCheck(db, run),
};

const checkJobSchema = z.object({
  runId: z.string().uuid(),
  stage: z.string().min(1),
  key: z.string().min(1),
  extractionRunId: z.string().uuid(),
});

/** Checks the quotes of one extraction run again and finishes or blocks it. */
export const checkExtractionRunHandler: JobHandler<JobData> = async (data, ctx) => {
  const job = checkJobSchema.parse(data);
  const result = await checkExtractionRun(ctx.db, job.extractionRunId);
  ctx.log.info({ extractionRunId: job.extractionRunId, facts: result.facts, verified: result.verified, ratio: result.ratio }, "extraction run checked");
};
