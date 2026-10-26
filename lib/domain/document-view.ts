import { diffLines } from "diff";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import {
  documents,
  documentVersions,
  sources,
  type DocType,
  type DocumentStatus,
  type ObservedAtBasis,
} from "@/lib/db/schema";

export type DocumentVersionRow = {
  id: string;
  fetchedAt: Date;
  /** First 8 hex characters of the content hash (as in the archive keys). */
  hash8: string;
  converter: string;
  language: string | null;
  publishedAt: string | null;
  observedAt: string;
  basis: ObservedAtBasis;
  simulated: boolean;
  contentType: string | null;
};

export type DocumentDetail = {
  document: {
    id: string;
    url: string;
    status: DocumentStatus;
    firstSeenAt: Date;
    lastCheckedAt: Date | null;
    consecutiveGone: number;
    currentVersionId: string | null;
  };
  source: { id: string; domain: string; name: string; type: DocType; weight: number };
  /** Newest first. */
  versions: DocumentVersionRow[];
};

/** A document with its source and its versions (newest first); null when unknown. */
export async function documentDetail(db: Db, id: string): Promise<DocumentDetail | null> {
  const [row] = await db
    .select({
      id: documents.id,
      url: documents.url,
      status: documents.status,
      firstSeenAt: documents.firstSeenAt,
      lastCheckedAt: documents.lastCheckedAt,
      consecutiveGone: documents.consecutiveGone,
      currentVersionId: documents.currentVersionId,
      source: { id: sources.id, domain: sources.domain, name: sources.name, type: sources.type, weight: sources.weight },
    })
    .from(documents)
    .innerJoin(sources, eq(sources.id, documents.sourceId))
    .where(eq(documents.id, id));
  if (!row) return null;
  const versions = await db
    .select({
      id: documentVersions.id,
      fetchedAt: documentVersions.fetchedAt,
      contentHash: documentVersions.contentHash,
      converter: documentVersions.converter,
      language: documentVersions.language,
      publishedAt: documentVersions.publishedAt,
      observedAt: documentVersions.observedAt,
      basis: documentVersions.observedAtBasis,
      simulated: documentVersions.simulated,
      contentType: documentVersions.contentType,
    })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, id))
    .orderBy(desc(documentVersions.fetchedAt), desc(documentVersions.id));
  const { source, ...document } = row;
  return {
    document,
    source,
    versions: versions.map(({ contentHash, ...v }) => ({ ...v, hash8: contentHash.slice(0, 8) })),
  };
}

type VersionKeys = { id: string; mdKey: string; rawKey: string; contentHash: string; contentType: string | null };

/** The versions `versionIds` of the document `documentId` (a version of another document is left out). */
async function versionsOf(db: Db, documentId: string, versionIds: string[]): Promise<Map<string, VersionKeys>> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = versionIds.filter((v) => uuid.test(v));
  if (ids.length === 0 || !uuid.test(documentId)) return new Map();
  const rows = await db
    .select({
      id: documentVersions.id,
      mdKey: documentVersions.mdKey,
      rawKey: documentVersions.rawKey,
      contentHash: documentVersions.contentHash,
      contentType: documentVersions.contentType,
    })
    .from(documentVersions)
    .where(and(eq(documentVersions.documentId, documentId), inArray(documentVersions.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

/** The version `versionId` if it belongs to the document `documentId`, else null. */
export async function documentVersion(db: Db, documentId: string, versionId: string): Promise<VersionKeys | null> {
  return (await versionsOf(db, documentId, [versionId])).get(versionId) ?? null;
}

async function markdownOf(archive: Archive, version: VersionKeys): Promise<string | null> {
  const bytes = await archive.get(version.mdKey);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

/**
 * The archived (normalised) Markdown of a version, read from the archive (no chunks: N6); null when the version does
 * not belong to the document or its Markdown is missing from the archive.
 */
export async function versionContent(db: Db, archive: Archive, documentId: string, versionId: string): Promise<{ markdown: string } | null> {
  const version = await documentVersion(db, documentId, versionId);
  if (!version) return null;
  const markdown = await markdownOf(archive, version);
  return markdown === null ? null : { markdown };
}

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** Unchanged runs longer than this are cut to `DIFF_CONTEXT` lines at each end. */
const DIFF_COLLAPSE_ABOVE = 6;
const DIFF_CONTEXT = 3;
/** Text of the line standing for the cut part of an unchanged run. */
export const DIFF_ELLIPSIS = "…";

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Line diff (`diffLines`) between two versions of the document, one entry per line. Unchanged runs of more than 6
 * lines keep 3 lines at each end with one `…` line between them. Null when a version does not belong to the
 * document or its Markdown is missing.
 */
export async function versionDiff(
  db: Db,
  archive: Archive,
  documentId: string,
  fromId: string,
  toId: string,
): Promise<DiffLine[] | null> {
  const versions = await versionsOf(db, documentId, [fromId, toId]);
  const from = versions.get(fromId);
  const to = versions.get(toId);
  if (!from || !to) return null;
  const [before, after] = await Promise.all([markdownOf(archive, from), markdownOf(archive, to)]);
  if (before === null || after === null) return null;
  const out: DiffLine[] = [];
  for (const part of diffLines(before, after)) {
    const lines = splitLines(part.value);
    if (part.added || part.removed) {
      const kind = part.added ? "added" : "removed";
      for (const text of lines) out.push({ kind, text });
    } else if (lines.length > DIFF_COLLAPSE_ABOVE) {
      for (const text of lines.slice(0, DIFF_CONTEXT)) out.push({ kind: "same", text });
      out.push({ kind: "same", text: DIFF_ELLIPSIS });
      for (const text of lines.slice(-DIFF_CONTEXT)) out.push({ kind: "same", text });
    } else {
      for (const text of lines) out.push({ kind: "same", text });
    }
  }
  return out;
}

/** A media type `type/subtype` with optional parameters, safe to send back as a header value. */
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\\\r\n]*"))*$/i;

/**
 * The archived raw file of a version for download: its bytes, the content type of the fetch (else
 * `application/octet-stream`) and the file name `<hash8>.<ext>` (`ext` from the archive key). Null when the
 * version does not belong to the document or the object is missing.
 */
export async function versionRawFile(
  db: Db,
  archive: Archive,
  documentId: string,
  versionId: string,
): Promise<{ bytes: Uint8Array; contentType: string; filename: string } | null> {
  const version = await documentVersion(db, documentId, versionId);
  if (!version) return null;
  const bytes = await archive.get(version.rawKey);
  if (!bytes) return null;
  const ext = /\.raw\.([a-z0-9]{1,10})$/i.exec(version.rawKey)?.[1]?.toLowerCase() ?? "bin";
  const contentType = version.contentType && MEDIA_TYPE.test(version.contentType) ? version.contentType : "application/octet-stream";
  return { bytes, contentType, filename: `${version.contentHash.slice(0, 8)}.${ext}` };
}
