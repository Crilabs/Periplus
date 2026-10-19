import { z } from "zod";
import { getArchive } from "@/lib/adapters/s3";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { CLASSIFY_QUEUE, CLASSIFY_STAGE, classifyVersions, planClassify } from "@/lib/pipeline/text/classify";
import { DISAMBIGUATE_QUEUE, DISAMBIGUATE_STAGE, disambiguateMatches, planDisambiguate } from "@/lib/pipeline/text/disambiguate";
import { MENTIONS_QUEUE, MENTIONS_STAGE, matchVersions, planMentions } from "@/lib/pipeline/text/mentions";
import { modelClientFor } from "./ai-batch";

/*
 * Text stages are planned lazily, when each stage starts (`enqueueStage`). They therefore plan from the run's frozen
 * version set (`frozenRunVersions`, ruling M4-E-R2), never from a re-resolved `pending`/`tileId`/`areaKey`: the
 * passes written by `mentions.batch` would make `pending` empty for every later stage. The stages added in Task 17
 * (geocode, extraction, routes, check) must plan from the frozen list too.
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
