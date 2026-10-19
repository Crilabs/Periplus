import type { ChunkDraft } from "@/lib/domain/documents/chunker";

/**
 * Carry-over of unchanged chunks: for each new chunk the first not yet used previous chunk (in `prev` order, i.e. by
 * ordinal) with the same `textHash`,
 * as the chunk it was originally extracted from (`carriedFromChunkId ?? id`), otherwise null.
 */
export function matchCarried(
  prev: Array<{ id: string; textHash: string; carriedFromChunkId: string | null }>,
  next: ChunkDraft[],
): Array<string | null> {
  const byHash = new Map<string, Array<string>>();
  for (const p of prev) {
    const origins = byHash.get(p.textHash) ?? [];
    origins.push(p.carriedFromChunkId ?? p.id);
    byHash.set(p.textHash, origins);
  }
  return next.map((c) => byHash.get(c.textHash)?.shift() ?? null);
}
