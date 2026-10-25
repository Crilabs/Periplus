import { and, desc, eq, inArray, lt, ne } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig, type FetchConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { chunks, documentVersions, textShingles } from "@/lib/db/schema";
import { matchCarried } from "@/lib/domain/documents/carry";
import { chunkMarkdown } from "@/lib/domain/documents/chunker";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { newId } from "@/lib/domain/ids";

/*
 * The chunks, carried embeddings and shingles of a stored version, for the old text stages only (`mentions.*`,
 * `extraction.*`, `embed.chunks`). `storeFetched` no longer writes them (N6 Task 2); the old crawl (`fetch.url`) calls
 * this after a new version so the old pipeline keeps working until it is deleted (Task 4). The research pipeline
 * reads the Markdown from the archive and never calls it.
 */

const SHINGLE_BATCH = 5000;
const CHUNK_BATCH = 500;

/** Writes the chunks of `versionId` (none when it has some already), carrying unchanged ones from the version before. */
export async function chunkStoredVersion(db: Db, archive: Archive, versionId: string, cfg: FetchConfig["chunk"] = getConfig().fetch.chunk): Promise<void> {
  const [version] = await db
    .select({ id: documentVersions.id, documentId: documentVersions.documentId, mdKey: documentVersions.mdKey, fetchedAt: documentVersions.fetchedAt })
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId));
  if (!version) throw new Error(`version ${versionId} not found`);
  const [existing] = await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.documentVersionId, versionId)).limit(1);
  if (existing) return;
  const bytes = await archive.get(version.mdKey);
  if (!bytes) throw new Error(`archived markdown ${version.mdKey} is missing`);
  const drafts = chunkMarkdown(new TextDecoder().decode(bytes), cfg);

  await db.transaction(async (tx) => {
    const [previous] = await tx
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(and(eq(documentVersions.documentId, version.documentId), ne(documentVersions.id, versionId), lt(documentVersions.fetchedAt, version.fetchedAt)))
      .orderBy(desc(documentVersions.fetchedAt), desc(documentVersions.id))
      .limit(1);
    const prev = previous
      ? await tx
          .select({ id: chunks.id, textHash: chunks.textHash, carriedFromChunkId: chunks.carriedFromChunkId })
          .from(chunks)
          .where(eq(chunks.documentVersionId, previous.id))
          .orderBy(chunks.ordinal)
      : [];
    const origins = matchCarried(prev, drafts);
    const originIds = [...new Set(origins.filter((o): o is string => o !== null))];
    const embeddings = new Map(
      (originIds.length > 0
        ? await tx.select({ id: chunks.id, embedding: chunks.embedding, embeddingModel: chunks.embeddingModel }).from(chunks).where(inArray(chunks.id, originIds))
        : []
      ).map((c) => [c.id, c]),
    );
    const rows = drafts.map((d, i) => {
      const origin = origins[i] ?? null;
      const source = origin ? embeddings.get(origin) : undefined;
      return {
        id: newId(),
        documentVersionId: versionId,
        ordinal: d.ordinal,
        text: d.text,
        textNormalized: d.textNormalized,
        textHash: d.textHash,
        heading: d.heading,
        charStart: d.charStart,
        charEnd: d.charEnd,
        wordCount: d.wordCount,
        embedding: source?.embedding ?? null,
        embeddingModel: source?.embeddingModel ?? null,
        carriedFromChunkId: origin,
      };
    });
    for (let i = 0; i < rows.length; i += CHUNK_BATCH) await tx.insert(chunks).values(rows.slice(i, i + CHUNK_BATCH));
    const shingles = rows
      .filter((r) => r.carriedFromChunkId === null)
      .flatMap((r) => shingleHashes(r.text).map((shingleHash) => ({ shingleHash, chunkId: r.id })));
    for (let i = 0; i < shingles.length; i += SHINGLE_BATCH) await tx.insert(textShingles).values(shingles.slice(i, i + SHINGLE_BATCH)).onConflictDoNothing();
  });
}
