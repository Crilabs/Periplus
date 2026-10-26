import { and, asc, eq, inArray, isNotNull, notExists } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { assessPageTask, type AssessPageInput } from "@/lib/ai/tasks/assess-page";
import type { ModelTask } from "@/lib/ai/types";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, pageAssessments, researchHits } from "@/lib/db/schema";
import { firstWords } from "@/lib/domain/research/util/dates";
import { activeAssessor, storeAssessment } from "@/lib/domain/research/assessment";
import { researchCandidates } from "@/lib/domain/research/candidates";
import type { QueueName } from "@/lib/jobs/queues";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import type { BatchDeps, BatchHandlerEntry, BatchItemInput } from "@/lib/pipeline/batches";
import { submitStageJobBatch } from "@/lib/pipeline/stage-batch";
import { titleOf } from "@/lib/domain/documents/title";
import { researchScope } from "./search";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

/*
 * Stage `research.assess`: every current version of a hit page of the run's candidates without an assessment by the
 * active model and prompt version is assessed from its title, URL and first `research.assessWords` words, as message
 * batches of at most `extraction.unitsPerBatch` versions per job. A page that is a hit of several candidates is
 * assessed once. The batch handler stores the result (`storeAssessment`).
 */

export const RESEARCH_ASSESS_STAGE = "research.assess";
export const RESEARCH_ASSESS_QUEUE = "research.assess" satisfies QueueName;
const SUBJECT = "document_version";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.research.assess"));

const task = assessPageTask as ModelTask<unknown, unknown>;

export type AssessJob = { runId: string; stage: string; key: string; documentVersionIds: string[] };
export type AssessDeps = BatchDeps & { archive: Pick<Archive, "get"> };

/** Of `ids`, those without an assessment by the active model and prompt version, in id order. */
async function unassessed(db: Db, ids: string[], config: AppConfig): Promise<string[]> {
  if (ids.length === 0) return [];
  const { model, promptVersion } = activeAssessor(config);
  const rows = await db
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(
      and(
        inArray(documentVersions.id, ids),
        notExists(
          db
            .select({ one: pageAssessments.id })
            .from(pageAssessments)
            .where(
              and(
                eq(pageAssessments.documentVersionId, documentVersions.id),
                eq(pageAssessments.model, model),
                eq(pageAssessments.promptVersion, promptVersion),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(documentVersions.id));
  return rows.map((r) => r.id);
}

/**
 * Plan of the stage `research.assess`: the current versions of the hit documents (either purpose) of the run's
 * candidates that the active configuration has not assessed, `unitsPerBatch` per job.
 */
export async function planResearchAssess(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  config: AppConfig = getConfig(),
): Promise<JobData[]> {
  const placeIds = await researchCandidates(db, researchScope(run.params));
  if (placeIds.length === 0) return [];
  const current = await db
    .selectDistinct({ id: documents.currentVersionId })
    .from(documents)
    .innerJoin(researchHits, eq(researchHits.urlNormalized, documents.urlNormalized))
    .where(and(inArray(researchHits.placeId, placeIds), isNotNull(documents.currentVersionId)));
  const todo = await unassessed(db, current.map((r) => r.id!), config);
  const size = config.extraction.unitsPerBatch;
  const jobs: JobData[] = [];
  for (let i = 0; i * size < todo.length; i++) {
    jobs.push({ key: `assess:${i}`, documentVersionIds: todo.slice(i * size, (i + 1) * size) });
  }
  return jobs;
}

/** The task inputs of the versions, in the given order; a version whose Markdown is missing in the archive is skipped. */
export async function assessInputs(db: Db, archive: Pick<Archive, "get">, ids: string[], config: AppConfig): Promise<BatchItemInput[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: documentVersions.id, mdKey: documentVersions.mdKey, fetchedAt: documentVersions.fetchedAt, publishedAt: documentVersions.publishedAt, url: documents.url })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(inArray(documentVersions.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items: BatchItemInput[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    const body = await archive.get(row.mdKey);
    if (body === null) {
      getLog().warn({ versionId: id, mdKey: row.mdKey }, "archived markdown missing, version not assessed");
      continue;
    }
    const md = new TextDecoder().decode(body);
    const input: AssessPageInput = {
      title: titleOf(md),
      url: row.url,
      fetchedAt: row.fetchedAt.toISOString().slice(0, 10),
      publishedAt: row.publishedAt,
      text: firstWords(md, config.research.assessWords),
    };
    items.push({ subjectType: SUBJECT, subjectId: id, input });
  }
  return items;
}

/**
 * One assessment job: its versions still unassessed go out as one message batch, sized to today's anthropic headroom;
 * what does not fit goes to a follow-on job, no room at all defers the job (`BudgetExceeded`). A retried job reuses
 * its batch. Never call it inside a transaction.
 */
export async function assessPages(
  db: Db,
  deps: AssessDeps,
  job: AssessJob,
): Promise<{ submitted: number; remainder: number; reused: boolean }> {
  const config = deps.config ?? getConfig();
  return submitStageJobBatch(db, deps, {
    task,
    queue: RESEARCH_ASSESS_QUEUE,
    job,
    subjectIds: job.documentVersionIds,
    open: (ids) => unassessed(db, ids, config),
    inputs: (ids) => assessInputs(db, deps.archive, ids, config),
    remainderData: (ids) => ({ documentVersionIds: ids }),
  });
}

/**
 * Batch handler of `assess-page`: stores one version's assessment. Only a result of the poll's active model and prompt
 * version (`ctx.config`) writes; a stale one is dropped and logged.
 */
export const assessPageBatchEntry: BatchHandlerEntry = {
  task,
  handle: async (db, item, ctx) => {
    const out = assessPageTask.output.parse(item.output);
    const active = activeAssessor(ctx.config);
    if (item.batch.model !== active.model || item.batch.promptVersion !== active.promptVersion) {
      getLog().warn(
        { versionId: item.subjectId, model: item.batch.model, promptVersion: item.batch.promptVersion, active },
        "stale page assessment dropped",
      );
      return;
    }
    const [version] = await db
      .select({ fetchedAt: documentVersions.fetchedAt, publishedAt: documentVersions.publishedAt })
      .from(documentVersions)
      .where(eq(documentVersions.id, item.subjectId));
    if (!version) throw new Error(`document version ${item.subjectId} does not exist`);
    await storeAssessment(db, item.subjectId, out, {
      model: item.batch.model,
      promptVersion: item.batch.promptVersion,
      runId: item.batch.runId,
      fetchedAt: version.fetchedAt,
      publishedAt: version.publishedAt,
    });
  },
};
