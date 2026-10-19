import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import type { FetchConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { chunks, documents, documentVersions, textShingles, type DocType } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { matchCarried } from "./carry";
import { chunkMarkdown } from "./chunker";
import { observedFrom } from "./metadata";
import { contentHash, normalizeMarkdown } from "./normalize";
import { shingleHashes } from "./shingles";

/** `archive/<documentId>/<fetchedAt ISO>_<hash8>.<suffix>`, suffix `raw.<ext>`, `md` or `diff`. */
export function archiveKey(documentId: string, fetchedAt: Date, hash: string, suffix: string): string {
  return `archive/${documentId}/${fetchedAt.toISOString()}_${hash.slice(0, 8)}.${suffix}`;
}

/** The document of `urlNormalized`, created for the source when there is none (concurrent calls create one). */
export async function ensureDocument(
  db: Db,
  input: { sourceId: string; url: string; urlNormalized: string; docType: DocType },
): Promise<{ id: string; created: boolean }> {
  const [inserted] = await db
    .insert(documents)
    .values({ sourceId: input.sourceId, url: input.url, urlNormalized: input.urlNormalized, docType: input.docType })
    .onConflictDoNothing({ target: documents.urlNormalized })
    .returning({ id: documents.id });
  if (inserted) return { id: inserted.id, created: true };
  const [existing] = await db.select({ id: documents.id }).from(documents).where(eq(documents.urlNormalized, input.urlNormalized));
  if (!existing) throw new Error(`document ${input.urlNormalized} neither inserted nor found`);
  return { id: existing.id, created: false };
}

export type FetchedContent = {
  fetchedAt: Date;
  raw: Uint8Array;
  /** File extension of the raw object, e.g. `html`, `pdf`, `csv`. */
  rawExt: string;
  contentType: string | null;
  finalUrl: string | null;
  markdown: string;
  converter: string;
  language: string | null;
  publishedAt: string | null;
  docType: DocType;
  etag: string | null;
  lastModified: string | null;
  simulated?: boolean;
  runId?: string;
};

export type StoreOutcome = "new_version" | "unchanged" | "reverted";

export type StoreResult = { outcome: StoreOutcome; versionId: string; chunks: { created: number; carried: number } };

const SHINGLE_BATCH = 5000;
const CHUNK_BATCH = 500;
const VERSIONS_UNIQUE = "document_versions_document_id_content_hash_unique";

function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let e = error as { code?: string; constraint?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === "23505" && e.constraint === constraint) return true;
  }
  return false;
}

/** Fields every successful check of a page sets: it exists, it was looked at now. */
function checkedFields(at: Date, etag: string | null | undefined, lastModified: string | null | undefined) {
  return {
    lastCheckedAt: at,
    consecutiveGone: 0,
    status: "active" as const,
    ...(etag !== undefined ? { etag } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
  };
}

/** Reports a content that already has a version: `unchanged` when it is the current one, else `reverted` to it. */
async function settleKnown(db: Db, documentId: string, versionId: string, content: FetchedContent): Promise<StoreResult> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ currentVersionId: documents.currentVersionId })
      .from(documents)
      .where(eq(documents.id, documentId))
      .for("update");
    if (!doc) throw new Error(`document ${documentId} not found`);
    await tx
      .update(documents)
      .set({ ...checkedFields(content.fetchedAt, content.etag, content.lastModified), currentVersionId: versionId })
      .where(eq(documents.id, documentId));
    const outcome = doc.currentVersionId === versionId ? "unchanged" : "reverted";
    return { outcome, versionId, chunks: { created: 0, carried: 0 } };
  });
}

async function versionWithHash(db: Db, documentId: string, hash: string): Promise<string | null> {
  const [row] = await db
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(and(eq(documentVersions.documentId, documentId), eq(documentVersions.contentHash, hash)));
  return row?.id ?? null;
}

/**
 * Archives one fetch of a document. The Markdown is normalized and hashed; a hash equal to the current version
 * only marks the document checked (`unchanged`), one equal to an older version makes that one current again
 * (`reverted`). A new content is written to S3 first (`raw`, `md`, and a unified `diff` against the current
 * version's Markdown, none for a first version), then in one transaction the version, its chunks (unchanged ones
 * carried over with the origin's embedding), the shingles of the chunks not carried, and the document. Losing a
 * race on `(document_id, content_hash)` reads the winner and reports it like a known content; S3 objects of the
 * lost attempt stay behind as harmless orphans.
 */
export async function storeFetched(
  db: Db,
  archive: Archive,
  documentId: string,
  content: FetchedContent,
  cfg: FetchConfig["chunk"],
): Promise<StoreResult> {
  const md = normalizeMarkdown(content.markdown);
  const hash = contentHash(md);
  const known = await versionWithHash(db, documentId, hash);
  if (known) return settleKnown(db, documentId, known, content);

  const [doc] = await db
    .select({ currentVersionId: documents.currentVersionId })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc) throw new Error(`document ${documentId} not found`);
  const [current] = doc.currentVersionId
    ? await db.select({ id: documentVersions.id, mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, doc.currentVersionId))
    : [];

  const rawKey = archiveKey(documentId, content.fetchedAt, hash, `raw.${content.rawExt}`);
  const mdKey = archiveKey(documentId, content.fetchedAt, hash, "md");
  await archive.put(rawKey, content.raw, content.contentType ?? "application/octet-stream");
  await archive.put(mdKey, md, "text/markdown; charset=utf-8");
  let diffKey: string | null = null;
  if (current) {
    const previous = await archive.get(current.mdKey);
    if (!previous) throw new Error(`archived markdown ${current.mdKey} is missing`);
    diffKey = archiveKey(documentId, content.fetchedAt, hash, "diff");
    await archive.put(diffKey, createTwoFilesPatch(current.mdKey, mdKey, new TextDecoder().decode(previous), md), "text/x-diff; charset=utf-8");
  }

  const drafts = chunkMarkdown(md, cfg);
  const observed = observedFrom(content.publishedAt, content.fetchedAt);
  try {
    return await db.transaction(async (tx) => {
      const versionId = newId();
      await tx.insert(documentVersions).values({
        id: versionId,
        documentId,
        fetchedAt: content.fetchedAt,
        contentHash: hash,
        rawHash: createHash("sha256").update(content.raw).digest("hex"),
        rawKey,
        mdKey,
        diffKey,
        contentType: content.contentType,
        finalUrl: content.finalUrl,
        language: content.language,
        publishedAt: content.publishedAt,
        observedAt: observed.observedAt,
        observedAtBasis: observed.basis,
        docType: content.docType,
        converter: content.converter,
        simulated: content.simulated ?? false,
        charCount: md.length,
        runId: content.runId ?? null,
      });

      const prev = current
        ? await tx
            .select({ id: chunks.id, textHash: chunks.textHash, carriedFromChunkId: chunks.carriedFromChunkId })
            .from(chunks)
            .where(eq(chunks.documentVersionId, current.id))
            .orderBy(chunks.ordinal)
        : [];
      const origins = matchCarried(prev, drafts);
      const originIds = [...new Set(origins.filter((o): o is string => o !== null))];
      const embeddings = new Map(
        (originIds.length > 0
          ? await tx
              .select({ id: chunks.id, embedding: chunks.embedding, embeddingModel: chunks.embeddingModel })
              .from(chunks)
              .where(inArray(chunks.id, originIds))
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
      for (let i = 0; i < shingles.length; i += SHINGLE_BATCH) {
        await tx.insert(textShingles).values(shingles.slice(i, i + SHINGLE_BATCH)).onConflictDoNothing();
      }

      await tx
        .update(documents)
        .set({ ...checkedFields(content.fetchedAt, content.etag, content.lastModified), currentVersionId: versionId })
        .where(eq(documents.id, documentId));
      const carried = origins.filter((o) => o !== null).length;
      return { outcome: "new_version" as const, versionId, chunks: { created: rows.length, carried } };
    });
  } catch (error) {
    if (!isUniqueViolation(error, VERSIONS_UNIQUE)) throw error;
    const winner = await versionWithHash(db, documentId, hash);
    if (!winner) throw error;
    return settleKnown(db, documentId, winner, content);
  }
}

/** A 304 (or other proof the page exists unchanged): checked now, not gone, validators updated when given. */
export async function markChecked(
  db: Db,
  documentId: string,
  input: { at: Date; etag?: string | null; lastModified?: string | null },
): Promise<void> {
  await db.update(documents).set(checkedFields(input.at, input.etag, input.lastModified)).where(eq(documents.id, documentId));
}

/**
 * A 404/410: `consecutive_gone + 1`; from `goneAfter` on the document is `gone` (its `valid_to` stays empty: the
 * consolidation ends its facts). `gone` tells whether the document is gone after this call.
 */
export async function markGone(db: Db, documentId: string, at: Date, goneAfter: number): Promise<{ gone: boolean; consecutive: number }> {
  const [row] = await db
    .update(documents)
    .set({
      lastCheckedAt: at,
      consecutiveGone: sql`${documents.consecutiveGone} + 1`,
      status: sql`case when ${documents.consecutiveGone} + 1 >= ${goneAfter} then 'gone'::document_status else ${documents.status} end`,
    })
    .where(eq(documents.id, documentId))
    .returning({ consecutive: documents.consecutiveGone, status: documents.status });
  if (!row) throw new Error(`document ${documentId} not found`);
  return { gone: row.status === "gone", consecutive: row.consecutive };
}
