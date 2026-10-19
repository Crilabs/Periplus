import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { classifyDocumentTask, type ClassifyDocumentInput } from "@/lib/ai/tasks/classify-document";
import type { ModelTask } from "@/lib/ai/types";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions } from "@/lib/db/schema";
import { activeClassifier, firstWords, storeClassification } from "@/lib/domain/mentions/classification";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import type { BatchDeps, BatchHandlerEntry, BatchItemInput } from "@/lib/pipeline/batches";
import { submitStageJobBatch } from "./stage-batch";
import { frozenRunVersions } from "./versions";

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
  const todo = await unclassified(db, await frozenRunVersions(db, run.params), config);
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

/**
 * The task inputs of the versions, in the given order; a version whose Markdown is missing in the archive is skipped.
 * Also used by `fixtures:record --ai classify-document`.
 */
export async function classifyInputs(db: Db, archive: Pick<Archive, "get">, ids: string[], config: AppConfig): Promise<BatchItemInput[]> {
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

/**
 * One classification job: its versions still unclassified go out as one message batch, sized to today's anthropic
 * headroom (ruling M4-C-R2); what does not fit goes to a follow-on job, and no room at all defers the job
 * (`BudgetExceeded`). A retried job reuses its batch. Never call it inside a transaction (the provider call of
 * `submitStageBatch` must not run in one).
 */
export async function classifyVersions(
  db: Db,
  deps: ClassifyDeps,
  job: ClassifyJob,
): Promise<{ submitted: number; remainder: number; reused: boolean }> {
  const config = deps.config ?? getConfig();
  return submitStageJobBatch(db, deps, {
    task,
    queue: CLASSIFY_QUEUE,
    job,
    subjectIds: job.documentVersionIds,
    open: (ids) => unclassified(db, ids, config),
    inputs: (ids) => classifyInputs(db, deps.archive, ids, config),
    remainderData: (ids) => ({ documentVersionIds: ids }),
  });
}

/**
 * Batch handler of `classify-document`: stores one version's classification (ruling M4-P11). Only a result of the
 * poll's active classifier (`ctx.config`) writes; a stale one (the model or prompt version changed while the batch
 * ran) is dropped and logged.
 */
export const classificationBatchEntry: BatchHandlerEntry = {
  task,
  handle: async (db, item, ctx) => {
    const out = classifyDocumentTask.output.parse(item.output);
    const active = activeClassifier(ctx.config);
    if (item.batch.model !== active.model || item.batch.promptVersion !== active.promptVersion) {
      getLog().warn(
        { versionId: item.subjectId, model: item.batch.model, promptVersion: item.batch.promptVersion, active },
        "stale classification result dropped",
      );
      return;
    }
    const [version] = await db
      .select({ fetchedAt: documentVersions.fetchedAt })
      .from(documentVersions)
      .where(eq(documentVersions.id, item.subjectId));
    if (!version) throw new Error(`document version ${item.subjectId} does not exist`);
    await storeClassification(
      db,
      item.subjectId,
      out,
      { model: item.batch.model, promptVersion: item.batch.promptVersion, runId: item.batch.runId, fetchedAt: version.fetchedAt },
      ctx.config.extraction.earliestDate,
      active,
    );
  },
};
