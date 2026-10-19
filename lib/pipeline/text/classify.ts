import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { estimateBatchItemCostsEur, resolveTaskModel } from "@/lib/ai/cost";
import { classifyDocumentTask, type ClassifyDocumentInput } from "@/lib/ai/tasks/classify-document";
import type { ModelTask } from "@/lib/ai/types";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiBatchItems, documents, documentVersions } from "@/lib/db/schema";
import { BudgetExceeded } from "@/lib/domain/costs";
import { firstWords, storeClassification } from "@/lib/domain/mentions/classification";
import { extendStage, stageAcceptsJobs } from "@/lib/domain/runs";
import { enqueueStageJobs } from "@/lib/jobs/enqueue";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import {
  anthropicHeadroomEur,
  batchOutcomeKey,
  sizeBatch,
  submitStageBatch,
  type BatchDeps,
  type BatchHandlerEntry,
  type BatchItemInput,
} from "@/lib/pipeline/batches";
import { textRunParamsSchema, textRunVersions } from "./versions";

/*
 * Stage `classify.document_version` (spec 06): every version of the text run without a classification by the active
 * model and prompt version is classified from its title, URL and first `classifyWords` words, as message batches of
 * at most `unitsPerBatch` versions per job. The batch handler stores the result on the version (ruling M4-P11).
 */

export const CLASSIFY_STAGE = "classify.document_version";
export const CLASSIFY_QUEUE = "classify.document_version" as const;
const SUBJECT = "document_version";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.text.classify"));

const task = classifyDocumentTask as ModelTask<unknown, unknown>;

export type ClassifyJob = { runId: string; stage: string; key: string; documentVersionIds: string[] };
export type ClassifyDeps = BatchDeps & { archive: Pick<Archive, "get"> };

/** The active model and prompt version of the classification. */
function activeClassifier(config: AppConfig): { model: string; promptVersion: number } {
  const { model, taskConfig } = resolveTaskModel(config, classifyDocumentTask.name);
  return { model, promptVersion: taskConfig.promptVersion };
}

/** Of `ids`, those not classified by the active model and prompt version, in id order. */
async function unclassified(db: Db, ids: string[], config: AppConfig): Promise<string[]> {
  if (ids.length === 0) return [];
  const { model, promptVersion } = activeClassifier(config);
  const rows = await db
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(
      and(
        inArray(documentVersions.id, ids),
        or(
          isNull(documentVersions.classifiedModel),
          ne(documentVersions.classifiedModel, model),
          isNull(documentVersions.classifiedPromptVersion),
          ne(documentVersions.classifiedPromptVersion, promptVersion),
        ),
      ),
    )
    .orderBy(asc(documentVersions.id));
  return rows.map((r) => r.id);
}

/** Plan: the run's versions without a classification for the active configuration, `unitsPerBatch` per job. */
export async function planClassify(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  config: AppConfig = getConfig(),
): Promise<JobData[]> {
  const params = textRunParamsSchema.parse(run.params);
  const todo = await unclassified(db, await textRunVersions(db, params, config), config);
  const size = config.extraction.unitsPerBatch;
  const jobs: JobData[] = [];
  for (let i = 0; i * size < todo.length; i++) {
    jobs.push({ key: `classify:${i}`, documentVersionIds: todo.slice(i * size, (i + 1) * size) });
  }
  return jobs;
}

/** The first ATX heading of the Markdown, as the document title. */
function titleOf(md: string): string | null {
  const m = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(md);
  return m ? m[1]!.trim() : null;
}

/** The task inputs of the versions, in the given order; a version whose Markdown is missing in the archive is skipped. */
async function classifyInputs(db: Db, archive: Pick<Archive, "get">, ids: string[], config: AppConfig): Promise<BatchItemInput[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: documentVersions.id, mdKey: documentVersions.mdKey, fetchedAt: documentVersions.fetchedAt, url: documents.url })
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
      getLog().warn({ versionId: id, mdKey: row.mdKey }, "archived markdown missing, version not classified");
      continue;
    }
    const md = new TextDecoder().decode(body);
    const input: ClassifyDocumentInput = {
      title: titleOf(md),
      url: row.url,
      fetchedAt: row.fetchedAt.toISOString().slice(0, 10),
      text: firstWords(md, config.extraction.classifyWords),
    };
    items.push({ subjectType: SUBJECT, subjectId: id, input });
  }
  return items;
}

/** Items of the job's batch unit (a retried job): those of its first batch, and every subject the unit covers. */
async function unitItems(db: Db, job: ClassifyJob): Promise<{ first: BatchItemInput[]; covered: Set<string> } | null> {
  const rows = await db
    .select({ batchId: aiBatches.id, subjectType: aiBatchItems.subjectType, subjectId: aiBatchItems.subjectId, input: aiBatchItems.input })
    .from(aiBatchItems)
    .innerJoin(aiBatches, eq(aiBatches.id, aiBatchItems.batchId))
    .where(and(eq(aiBatches.runId, job.runId), eq(aiBatches.stage, job.stage), eq(aiBatches.outcomeKey, batchOutcomeKey(job.key))))
    .orderBy(asc(aiBatches.id), asc(aiBatchItems.id));
  if (rows.length === 0) return null;
  const firstId = rows[0]!.batchId;
  return {
    first: rows.filter((r) => r.batchId === firstId).map((r) => ({ subjectType: r.subjectType, subjectId: r.subjectId, input: r.input })),
    covered: new Set(rows.map((r) => r.subjectId)),
  };
}

/**
 * Hands the remaining versions of a job that did not fit into its batch to one more job of the stage (key
 * `<key>+`), extending the stage by it, once: its job id comes from the key, so a retried job enqueues nothing.
 */
async function handOnRemainder(db: Db, deps: ClassifyDeps, job: ClassifyJob, remainder: string[]): Promise<void> {
  if (remainder.length === 0) return;
  await db.transaction(async (tx) => {
    if (!(await stageAcceptsJobs(tx, job.runId, job.stage))) return;
    const added = await enqueueStageJobs(
      deps.boss,
      CLASSIFY_QUEUE,
      job.runId,
      job.stage,
      [{ key: `${job.key}+`, documentVersionIds: remainder }],
      tx,
    );
    if (added > 0 && !(await extendStage(tx, job.runId, job.stage, added))) {
      throw new Error(`stage ${job.stage} of run ${job.runId} stopped running while locked`);
    }
  });
  getLog().info({ runId: job.runId, key: job.key, remainder: remainder.length }, "classification batch sized to the budget, rest handed on");
}

/**
 * One classification job: its versions still unclassified go out as one message batch (`submitStageBatch`), sized to
 * today's anthropic headroom (ruling M4-C-R2); what does not fit goes to a follow-on job, and no room at all defers
 * the job (`BudgetExceeded`). A retried job reuses its batch. Never call it inside a transaction (the provider call
 * of `submitStageBatch` must not run in one).
 */
export async function classifyVersions(
  db: Db,
  deps: ClassifyDeps,
  job: ClassifyJob,
): Promise<{ submitted: number; remainder: number; reused: boolean }> {
  const config = deps.config ?? getConfig();
  const existing = await unitItems(db, job);
  if (existing) {
    await submitStageBatch(db, deps, { task, runId: job.runId, stage: job.stage, key: job.key, items: existing.first });
    const remainder = job.documentVersionIds.filter((id) => !existing.covered.has(id));
    await handOnRemainder(db, deps, job, remainder);
    return { submitted: existing.first.length, remainder: remainder.length, reused: true };
  }

  const items = await classifyInputs(db, deps.archive, await unclassified(db, job.documentVersionIds, config), config);
  if (items.length === 0) return { submitted: 0, remainder: 0, reused: false };
  const now = deps.now?.() ?? new Date();
  const headroom = await anthropicHeadroomEur(db, config, now, deps.reservationScope);
  const costs = estimateBatchItemCostsEur(config, task, items.map((i) => i.input));
  const n = sizeBatch(costs, headroom, config.models.batch.maxRequests);
  if (n === 0) {
    const budget = config.budgets.anthropic.dailyEur;
    throw new BudgetExceeded("anthropic", budget - headroom, budget);
  }
  const result = await submitStageBatch(db, deps, { task, runId: job.runId, stage: job.stage, key: job.key, items: items.slice(0, n) });
  const remainder = items.slice(n).map((i) => i.subjectId);
  await handOnRemainder(db, deps, job, remainder);
  return { submitted: result.items, remainder: remainder.length, reused: result.reused };
}

/** Batch handler of `classify-document`: stores one version's classification (ruling M4-P11). */
export const classificationBatchEntry: BatchHandlerEntry = {
  task,
  handle: async (db, item) => {
    const out = classifyDocumentTask.output.parse(item.output);
    const [version] = await db
      .select({ fetchedAt: documentVersions.fetchedAt })
      .from(documentVersions)
      .where(eq(documentVersions.id, item.subjectId));
    if (!version) throw new Error(`document version ${item.subjectId} does not exist`);
    await storeClassification(db, item.subjectId, out, {
      model: item.batch.model,
      promptVersion: item.batch.promptVersion,
      runId: item.batch.runId,
      fetchedAt: version.fetchedAt,
    });
  },
};
