import { z } from "zod";
import type { ModelClient } from "@/lib/ai/types";
import type { Db } from "@/lib/db/client";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { pollBatch } from "@/lib/pipeline/batches";

type ModelClientFactory = (db: Db) => ModelClient;

let modelClientFactory: ModelClientFactory | undefined;

/** Sets how batch jobs get their model client: the worker passes the Anthropic client, tests a `MockModel`. */
export function setModelClientFactory(factory: ModelClientFactory | undefined): void {
  modelClientFactory = factory;
}

/** The model client of batch jobs; throws when the process never set one. */
export function modelClientFor(db: Db): ModelClient {
  if (!modelClientFactory) throw new Error("No model client configured for batch jobs (setModelClientFactory)");
  return modelClientFactory(db);
}

const pollJobSchema = z.object({ batchId: z.string().uuid() });

/** Queue `ai.batch.poll`: one poll of one batch; schedules the next poll itself while the batch runs. */
export const aiBatchPollHandler: JobHandler<JobData> = async (data, ctx) => {
  const { batchId } = pollJobSchema.parse(data);
  const result = await pollBatch(ctx.db, { model: modelClientFor(ctx.db), boss: ctx.boss, handlers: BATCH_HANDLERS }, batchId);
  ctx.log.info({ batchId, result }, "batch polled");
};
