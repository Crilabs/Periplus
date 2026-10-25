import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { chunks, documents, documentVersions, sources } from "@/lib/db/schema";
import {
  archiveKey,
  ensureDocument,
  markChecked,
  markGone,
  storeFetched,
  type FetchedContent,
} from "@/lib/domain/documents/store";
import { newId } from "@/lib/domain/ids";
import { testDb, withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

const db = testDb();

const sentence = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `The ${topic} anchorage offers sand and weed at five metres, line ${i}.`).join(" ");

/** Three sections of ~300 words each: every section becomes one chunk. */
function page(changed = false): string {
  return [
    "# Harbour guide",
    "## North bay",
    sentence("north", 25),
    "## East bay",
    changed ? sentence("changed east", 25) : sentence("east", 25),
    "## South bay",
    sentence("south", 25),
  ].join("\n\n");
}

async function insertSource(tx: Db, status: "paused" | "approved" = "paused"): Promise<{ id: string; domain: string }> {
  const domain = `${newId()}.test.invalid`;
  const [row] = await tx
    .insert(sources)
    .values({ domain, name: "Store test", type: "pilot_guide", weight: 0.9, status, crawlRules: {}, origin: "manual" })
    .returning({ id: sources.id });
  return { id: row!.id, domain };
}

async function newDocument(tx: Db) {
  const source = await insertSource(tx);
  const url = `https://${source.domain}/guide`;
  const doc = await ensureDocument(tx, { sourceId: source.id, url, urlNormalized: url, docType: "pilot_guide" });
  return { source, url, documentId: doc.id };
}

function content(markdown: string, fetchedAt: Date, over: Partial<FetchedContent> = {}): FetchedContent {
  return {
    fetchedAt,
    raw: new TextEncoder().encode(`<html>${markdown}</html>`),
    rawExt: "html",
    contentType: "text/html",
    finalUrl: null,
    markdown,
    converter: "local",
    language: "en",
    publishedAt: null,
    docType: "pilot_guide",
    etag: null,
    lastModified: null,
    ...over,
  };
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 19, 10, minute));

async function versionsOf(tx: Db, documentId: string) {
  return tx.select().from(documentVersions).where(eq(documentVersions.documentId, documentId)).orderBy(documentVersions.fetchedAt);
}

async function chunksOf(tx: Db, versionId: string) {
  return tx.select().from(chunks).where(eq(chunks.documentVersionId, versionId)).orderBy(chunks.ordinal);
}

async function documentRow(tx: Db, id: string) {
  const [row] = await tx.select().from(documents).where(eq(documents.id, id));
  return row!;
}

describe("archiveKey", () => {
  it("builds archive/<document>/<fetched ISO>_<hash8>.<suffix>", () => {
    expect(archiveKey("d1", new Date("2026-10-19T10:00:00Z"), "abcdef0123456789", "raw.html")).toBe(
      "archive/d1/2026-10-19T10:00:00.000Z_abcdef01.raw.html",
    );
  });
});

describe("ensureDocument", () => {
  it("creates a document once per normalized url", async () => {
    await withRollback(async (tx) => {
      const source = await insertSource(tx);
      const url = `https://${source.domain}/a`;
      const first = await ensureDocument(tx, { sourceId: source.id, url, urlNormalized: url, docType: "forum" });
      const second = await ensureDocument(tx, { sourceId: source.id, url, urlNormalized: url, docType: "forum" });
      expect(first.created).toBe(true);
      expect(second).toEqual({ id: first.id, created: false });
    });
  });
});

describe("storeFetched", () => {
  it("the first fetch writes raw and md and a version, no chunks, shingles or embeddings", async () => {
    const archive = memoryArchive();
    await withRollback(async (tx) => {
      const { documentId } = await newDocument(tx);
      const result = await storeFetched(tx, archive, documentId, content(page(), at(0), { etag: '"v1"' }));
      expect(result.outcome).toBe("new_version");

      const [version] = await versionsOf(tx, documentId);
      expect(version!.id).toBe(result.versionId);
      expect(version!.diffKey).toBeNull();
      expect(version!.rawKey).toMatch(new RegExp(`^archive/${documentId}/2026-10-19T10:00:00.000Z_[0-9a-f]{8}\\.raw\\.html$`));
      expect(version!.mdKey).toMatch(/\.md$/);
      expect(version!.observedAtBasis).toBe("fetched");
      expect(version!.observedAt).toBe("2026-10-19");
      expect(archive.keys()).toEqual([version!.mdKey, version!.rawKey].sort());
      expect(new TextDecoder().decode((await archive.get(version!.mdKey))!)).toMatch(/^# Harbour guide\n/);

      expect(await chunksOf(tx, version!.id)).toEqual([]);

      const doc = await documentRow(tx, documentId);
      expect(doc.currentVersionId).toBe(version!.id);
      expect(doc.etag).toBe('"v1"');
      expect(doc.lastCheckedAt).toEqual(at(0));
    });
  });

  it("the same markdown again only updates last_checked_at", async () => {
    const archive = memoryArchive();
    await withRollback(async (tx) => {
      const { documentId } = await newDocument(tx);
      const first = await storeFetched(tx, archive, documentId, content(page(), at(0)));
      const keys = archive.keys();
      // Trailing blanks and extra blank lines normalize away.
      const again = await storeFetched(tx, archive, documentId, content(`${page()}  \n\n\n`, at(5), { etag: '"v2"' }));
      expect(again).toEqual({ outcome: "unchanged", versionId: first.versionId });
      expect(await versionsOf(tx, documentId)).toHaveLength(1);
      expect(archive.keys()).toEqual(keys);
      const doc = await documentRow(tx, documentId);
      expect(doc.lastCheckedAt).toEqual(at(5));
      expect(doc.etag).toBe('"v2"');
    });
  });

  it("a changed paragraph writes a diff against the previous version", async () => {
    const archive = memoryArchive();
    await withRollback(async (tx) => {
      const { documentId } = await newDocument(tx);
      await storeFetched(tx, archive, documentId, content(page(), at(0)));
      const second = await storeFetched(tx, archive, documentId, content(page(true), at(10)));
      expect(second.outcome).toBe("new_version");

      const [, version] = await versionsOf(tx, documentId);
      expect(version!.diffKey).toMatch(/\.diff$/);
      const diff = new TextDecoder().decode((await archive.get(version!.diffKey!))!);
      expect(diff).toContain("-The east anchorage");
      expect(diff).toContain("+The changed east anchorage");
      expect(await chunksOf(tx, second.versionId)).toEqual([]);
    });
  });

  it("a store whose current version is replaced meanwhile diffs against the new current version", async () => {
    const base = memoryArchive();
    let interleave: (() => Promise<unknown>) | null = null;
    // The first diff write of the slow store lets another store of different content finish in between.
    const archive = {
      ...base,
      async put(key: string, body: Uint8Array | string, contentType: string) {
        await base.put(key, body, contentType);
        if (key.endsWith(".diff") && interleave) {
          const run = interleave;
          interleave = null;
          await run();
        }
      },
    };
    await withRollback(async (tx) => {
      const { documentId } = await newDocument(tx);
      await storeFetched(tx, archive, documentId, content(page(), at(0)));
      let middle: Awaited<ReturnType<typeof storeFetched>> | undefined;
      interleave = async () => (middle = await storeFetched(tx, archive, documentId, content(page(true), at(5))));
      const last = await storeFetched(tx, archive, documentId, content(`${page(true)}\n\nA closing note.`, at(10)));

      const versions = await versionsOf(tx, documentId);
      expect(versions.map((v) => v.id)).toEqual([versions[0]!.id, middle!.versionId, last.versionId]);
      const diff = new TextDecoder().decode((await archive.get(versions[2]!.diffKey!))!);
      expect(diff).toContain(versions[1]!.mdKey);
      expect(diff).not.toContain("-The east anchorage");
      expect((await documentRow(tx, documentId)).currentVersionId).toBe(last.versionId);
    });
  });

  it("A → B → A reports reverted and points back to version A", async () => {
    const archive = memoryArchive();
    await withRollback(async (tx) => {
      const { documentId } = await newDocument(tx);
      const a = await storeFetched(tx, archive, documentId, content(page(), at(0)));
      await storeFetched(tx, archive, documentId, content(page(true), at(10)));
      const back = await storeFetched(tx, archive, documentId, content(page(), at(20)));
      expect(back).toEqual({ outcome: "reverted", versionId: a.versionId });
      expect(await versionsOf(tx, documentId)).toHaveLength(2);
      const doc = await documentRow(tx, documentId);
      expect(doc.currentVersionId).toBe(a.versionId);
      expect(doc.lastCheckedAt).toEqual(at(20));
    });
  });

  it("two concurrent stores of the same content create one version", async () => {
    // Committed rows: two transactions must race. A paused *.test.invalid source never meets other tests' queries.
    const archive = memoryArchive();
    const { documentId } = await newDocument(db);
    const results = await Promise.all([
      storeFetched(db, archive, documentId, content(page(), at(0))),
      storeFetched(db, archive, documentId, content(page(), at(1))),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["new_version", "unchanged"]);
    expect(results[0]!.versionId).toBe(results[1]!.versionId);
    expect(await versionsOf(db, documentId)).toHaveLength(1);
    expect((await documentRow(db, documentId)).currentVersionId).toBe(results[0]!.versionId);
  });

  it("stores language, published date, final url and run-independent fields", async () => {
    const archive = memoryArchive();
    await withRollback(async (tx) => {
      const { documentId } = await newDocument(tx);
      const r = await storeFetched(
        tx,
        archive,
        documentId,
        content(page(), at(0), { publishedAt: "2025-05-01", finalUrl: "https://x.test.invalid/b", rawExt: "pdf", contentType: "application/pdf", converter: "pdftotext" }),
      );
      const [version] = await tx.select().from(documentVersions).where(eq(documentVersions.id, r.versionId));
      expect(version).toMatchObject({
        language: "en",
        publishedAt: "2025-05-01",
        observedAt: "2025-05-01",
        observedAtBasis: "published",
        finalUrl: "https://x.test.invalid/b",
        contentType: "application/pdf",
        converter: "pdftotext",
        simulated: false,
        runId: null,
      });
      expect(version!.rawKey).toMatch(/\.raw\.pdf$/);
    });
  });
});

describe("markGone and markChecked", () => {
  it("two 404 make a document gone, a later 200 makes it active again", async () => {
    const archive = memoryArchive();
    await withRollback(async (tx) => {
      const { documentId } = await newDocument(tx);
      await storeFetched(tx, archive, documentId, content(page(), at(0)));
      expect(await markGone(tx, documentId, at(1), 2)).toEqual({ gone: false, consecutive: 1 });
      expect((await documentRow(tx, documentId)).status).toBe("active");
      expect(await markGone(tx, documentId, at(2), 2)).toEqual({ gone: true, consecutive: 2 });
      const gone = await documentRow(tx, documentId);
      expect(gone.status).toBe("gone");
      expect(gone.validTo).toBeNull();
      expect(gone.lastCheckedAt).toEqual(at(2));

      const back = await storeFetched(tx, archive, documentId, content(page(), at(3)));
      expect(back.outcome).toBe("unchanged");
      const active = await documentRow(tx, documentId);
      expect(active).toMatchObject({ status: "active", consecutiveGone: 0 });

      await markGone(tx, documentId, at(4), 2);
      await markChecked(tx, documentId, { at: at(5), etag: '"e"' });
      expect(await documentRow(tx, documentId)).toMatchObject({ status: "active", consecutiveGone: 0, etag: '"e"', lastCheckedAt: at(5) });
    });
  });
});
