import { z } from "zod";
import { getArchive } from "@/lib/adapters/s3";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { CLASSIFY_QUEUE, CLASSIFY_STAGE, classifyVersions, planClassify } from "@/lib/pipeline/text/classify";
import { modelClientFor } from "./ai-batch";

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
