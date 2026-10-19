import { z } from "zod";
import { getTransport } from "@/lib/adapters/http";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { EMBED_STAGE, embedChunks, planEmbedChunks } from "@/lib/pipeline/embed";
import type { StageDefinition } from "@/lib/pipeline/runs";

/** Stage `embed.chunks`: one job per source and batch of chunks without an embedding. */
export const embedChunksStage: StageDefinition = {
  name: EMBED_STAGE,
  queue: "embed.chunks",
  plan: (db, run) => planEmbedChunks(db, run),
};

const jobSchema = z.object({ chunkIds: z.array(z.string().min(1)).min(1), sourceId: z.string().min(1).optional() });

/** Embeds one batch of chunks with Voyage (a fixed API endpoint, not crawled content: the plain transport). */
export const embedChunksHandler: JobHandler<JobData> = async (data, ctx) => {
  const { chunkIds, sourceId } = jobSchema.parse(data);
  const result = await embedChunks(
    ctx.db,
    chunkIds,
    { transport: getTransport() },
    { db: ctx.db, runId: data.runId, stage: data.stage, sourceId },
  );
  ctx.log.info({ sourceId, chunks: chunkIds.length, ...result }, "chunks embedded");
};
