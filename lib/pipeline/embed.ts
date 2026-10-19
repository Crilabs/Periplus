import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { CallContext, Transport } from "@/lib/adapters/http";
import { embedTexts } from "@/lib/adapters/voyage";
import { getConfig, type EmbeddingsConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { chunks, documents, documentVersions } from "@/lib/db/schema";
import type { JobData } from "@/lib/jobs/worker";

// No import of ./runs here: the job handlers import this module (import cycle through the stage registry).

export const EMBED_STAGE = "embed.chunks";

/** Most chunks one `embed.chunks` plan takes on (a backfill over all chunks continues in the next run). */
export const EMBED_PLAN_LIMIT = 10_000;

/**
 * Plan of the stage `embed.chunks`: the chunks without an embedding of the versions this run wrote (`params.all`:
 * of all versions, the backfill), the newest `EMBED_PLAN_LIMIT` by id (a backfill continues with older ones in the
 * next run), ordered by id. Carried chunks count like new ones: a chunk
 * carried from an origin without an embedding has none either. One job per source and `cfg.batchSize` chunks
 * (`{ key: <first chunk id>, chunkIds, sourceId }`), so every Voyage call is booked on one source.
 */
export async function planEmbedChunks(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  cfg: EmbeddingsConfig = getConfig().embeddings,
): Promise<JobData[]> {
  const rows = await db
    .select({ id: chunks.id, sourceId: documents.sourceId })
    .from(chunks)
    .innerJoin(documentVersions, eq(documentVersions.id, chunks.documentVersionId))
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(and(isNull(chunks.embedding), run.params.all === true ? undefined : eq(documentVersions.runId, run.id)))
    .orderBy(desc(chunks.id))
    .limit(EMBED_PLAN_LIMIT);
  rows.reverse();
  const bySource = new Map<string, string[]>();
  for (const r of rows) {
    const ids = bySource.get(r.sourceId);
    if (ids) ids.push(r.id);
    else bySource.set(r.sourceId, [r.id]);
  }
  const jobs: JobData[] = [];
  for (const [sourceId, ids] of bySource) {
    for (let i = 0; i < ids.length; i += cfg.batchSize) {
      const chunkIds = ids.slice(i, i + cfg.batchSize);
      jobs.push({ key: chunkIds[0]!, chunkIds, sourceId });
    }
  }
  return jobs;
}

/**
 * Job `embed.chunks`: embeds the `text` of those of `chunkIds` that still have no embedding (in one Voyage call)
 * and sets `embedding` and `embedding_model` — the only columns of the append-only `chunks` an update may change.
 * A chunk embedded meanwhile (a retry, an overlapping run) is neither sent nor overwritten.
 */
export async function embedChunks(
  db: Db,
  chunkIds: string[],
  deps: { transport: Transport },
  ctx: CallContext,
  cfg: EmbeddingsConfig = getConfig().embeddings,
): Promise<{ embedded: number }> {
  if (chunkIds.length === 0) return { embedded: 0 };
  const rows = await db
    .select({ id: chunks.id, text: chunks.text })
    .from(chunks)
    .where(and(inArray(chunks.id, chunkIds), isNull(chunks.embedding)))
    .orderBy(asc(chunks.id));
  if (rows.length === 0) return { embedded: 0 };
  const { vectors } = await embedTexts(deps.transport, rows.map((r) => r.text), ctx, cfg);
  return db.transaction(async (tx) => {
    let embedded = 0;
    for (const [i, row] of rows.entries()) {
      const updated = await tx
        .update(chunks)
        .set({ embedding: vectors[i]!, embeddingModel: cfg.model })
        .where(and(eq(chunks.id, row.id), isNull(chunks.embedding)))
        .returning({ id: chunks.id });
      embedded += updated.length;
    }
    return { embedded };
  });
}

/**
 * Checks that `chunks.embedding` is a `vector(<cfg.dimension>)` column (a changed dimension in
 * `config/embeddings.json` needs a migration first); throws naming both. The worker calls this at start.
 */
export async function assertEmbeddingDimension(db: Db, cfg: EmbeddingsConfig): Promise<void> {
  const { rows } = await db.execute<{ type: string | null }>(sql`
    select format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a
    where a.attrelid = 'chunks'::regclass and a.attname = 'embedding' and not a.attisdropped`);
  const actual = rows[0]?.type ?? null;
  const expected = `vector(${cfg.dimension})`;
  if (actual !== expected) {
    throw new Error(`chunks.embedding is ${actual ?? "missing"}, but config/embeddings.json needs ${expected}`);
  }
}
