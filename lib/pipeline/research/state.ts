import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { bundleFactsTask, type BundleFactsInput } from "@/lib/ai/tasks/bundle-facts";
import type { ModelTask } from "@/lib/ai/types";
import { resolveTaskModel } from "@/lib/ai/cost";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiBatchItems, berthStates } from "@/lib/db/schema";
import { bundleFacts, bundleInput, freeFacts, storeStateFacts } from "@/lib/domain/research/state-facts";
import type { QueueName } from "@/lib/jobs/queues";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import type { BatchDeps, BatchHandlerEntry, BatchItemInput } from "@/lib/pipeline/batches";
import { submitStageJobBatch } from "@/lib/pipeline/text/stage-batch";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

/*
 * Batch part of the stage `research.state` (plan N4a task 3): the free facts of each berth go out as one request per
 * berth (`bundle-facts`), as message batches of at most `extraction.unitsPerBatch` berths per job. A berth with fewer
 * than two free facts has nothing to bundle and is stored directly. The batch handler stores the bundled facts in
 * `berth_states.facts`; a broken answer stores the free facts one by one, a failed item keeps the earlier bundling (else one by one). The stage registration and the
 * other columns of the state (core values, landing, nearby) are task 6.
 */

const SUBJECT = "place";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("pipeline.research.state"));

const task = bundleFactsTask as ModelTask<unknown, unknown>;

export type BundleFactsJob = { runId: string; stage: string; key: string; placeIds: string[] };

/** The model and prompt version the configuration bundles with now. */
export function activeBundler(config: AppConfig): { model: string; promptVersion: number } {
  const { model, taskConfig } = resolveTaskModel(config, bundleFactsTask.name);
  return { model, promptVersion: taskConfig.promptVersion };
}

/**
 * Plan of the bundling: the given places with at least one free fact, or with facts stored in their state that may
 * now be gone, `unitsPerBatch` places per job (ids in order).
 */
export async function planBundleFacts(db: Db, placeIds: string[], config: AppConfig = getConfig()): Promise<JobData[]> {
  const todo: string[] = [];
  for (const id of [...placeIds].sort()) {
    if ((await freeFacts(db, id, config)).length > 0 || (await storedFactCount(db, id)) > 0) todo.push(id);
  }
  const size = config.extraction.unitsPerBatch;
  const jobs: JobData[] = [];
  for (let i = 0; i * size < todo.length; i++) jobs.push({ key: `bundle:${i}`, placeIds: todo.slice(i * size, (i + 1) * size) });
  return jobs;
}

async function storedFactCount(db: Db, placeId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`jsonb_array_length(${berthStates.facts})` }).from(berthStates).where(eq(berthStates.placeId, placeId));
  return row?.n ?? 0;
}

/** Of `ids`, the places not in an unfinished batch of the task (another run's job may have sent them already). */
async function openPlaces(db: Db, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const busy = await db
    .select({ id: aiBatchItems.subjectId })
    .from(aiBatchItems)
    .innerJoin(aiBatches, eq(aiBatches.id, aiBatchItems.batchId))
    .where(
      and(
        eq(aiBatchItems.subjectType, SUBJECT),
        inArray(aiBatchItems.subjectId, ids),
        eq(aiBatches.task, bundleFactsTask.name),
        notInArray(aiBatches.status, ["distributed", "failed"]),
      ),
    );
  const taken = new Set(busy.map((r) => r.id));
  return ids.filter((id) => !taken.has(id));
}

/**
 * The batch items of the places, in their order: a berth with at least two free facts is sent, any other is stored
 * directly (its facts one by one, or none), so no request is made for it.
 */
async function bundleInputs(db: Db, ids: string[], config: AppConfig): Promise<BatchItemInput[]> {
  const items: BatchItemInput[] = [];
  for (const id of ids) {
    const free = await freeFacts(db, id, config);
    if (free.length < 2) {
      await storeStateFacts(db, id, bundleFacts(free, [], null));
      continue;
    }
    const input: BundleFactsInput = { facts: free.map(bundleInput) };
    items.push({ subjectType: SUBJECT, subjectId: id, input });
  }
  return items;
}

/**
 * One bundling job: its places not yet in an unfinished batch go out as one message batch, sized to today's anthropic
 * headroom; what does not fit goes to a follow-on job, no room at all defers the job (`BudgetExceeded`). A retried job
 * reuses its batch. `queue` is the stage's queue, where the follow-on job goes (task 6). Never call it inside a transaction.
 */
export async function bundleFactsJob(db: Db, deps: BatchDeps, job: BundleFactsJob, queue: QueueName): Promise<{ submitted: number; remainder: number; reused: boolean }> {
  const config = deps.config ?? getConfig();
  return submitStageJobBatch(db, deps, {
    task,
    queue,
    job,
    subjectIds: job.placeIds,
    open: (ids) => openPlaces(db, ids),
    inputs: (ids) => bundleInputs(db, ids, config),
    remainderData: (ids) => ({ placeIds: ids }),
  });
}

/** Stores the bundled facts of the place from the free facts now and the model's groups (none: one by one). */
async function storeBundle(db: Db, placeId: string, offered: BundleFactsInput["facts"], groups: Parameters<typeof bundleFacts>[2], config: AppConfig) {
  await storeStateFacts(db, placeId, bundleFacts(await freeFacts(db, placeId, config), offered, groups));
}

/**
 * Batch handler of `bundle-facts`: stores one berth's bundled facts. Only a result of the poll's active model and
 * prompt version (`ctx.config`) writes; a stale one is dropped and logged. An answer with a broken group drops that
 * group (`validGroups`); one that does not fit the schema stores the facts one by one. An item that failed keeps the
 * facts stored earlier that are still free, and stores one by one only where nothing was stored.
 */
export const bundleFactsBatchEntry: BatchHandlerEntry = {
  task,
  handle: async (db, item, ctx) => {
    const active = activeBundler(ctx.config);
    if (item.batch.model !== active.model || item.batch.promptVersion !== active.promptVersion) {
      getLog().warn({ placeId: item.subjectId, model: item.batch.model, promptVersion: item.batch.promptVersion, active }, "stale fact bundling dropped");
      return;
    }
    const offered = (item.input as BundleFactsInput).facts;
    const parsed = bundleFactsTask.output.safeParse(item.output);
    if (!parsed.success) getLog().warn({ placeId: item.subjectId, error: parsed.error.message }, "bundling answer does not fit the schema, facts stored one by one");
    await storeBundle(db, item.subjectId, offered, parsed.success ? parsed.data.groups : null, ctx.config);
  },
  fail: async (db, item) => {
    getLog().warn({ placeId: item.subjectId, error: item.error }, "fact bundling failed");
    // The fail hook gets no poll configuration; `getConfig()` is the configuration the poll job runs with in production
    // (the same loaded one it passes as `ctx.config`), and the free facts depend on it only through the active models.
    const free = await freeFacts(db, item.subjectId, getConfig());
    const [row] = await db.select({ facts: berthStates.facts }).from(berthStates).where(eq(berthStates.placeId, item.subjectId));
    if (row && row.facts.length > 0) {
      // keep the earlier bundling where it still stands; a failed run must not undo it
      const stillFree = new Set(free.map((f) => f.id));
      await storeStateFacts(db, item.subjectId, row.facts.filter((f) => stillFree.has(f.factId)));
      return;
    }
    await storeStateFacts(db, item.subjectId, bundleFacts(free, [], null));
  },
};
