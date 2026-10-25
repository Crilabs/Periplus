import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, serpQueries, serpResults, sources } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { exportArchive, importArchive } from "@/lib/pipeline/archive-copy";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertTestSource } from "@/test/text";

/*
 * The archive copy through a directory: rows are seeded in a rolled-back transaction and exported from it (memory
 * archive as the source S3); the import runs in a second rolled-back transaction on a second memory archive, so the
 * target holds none of the rows.
 */

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

type Seed = { sourceId: string; documentId: string; versionIds: string[]; queryId: string; resultId: string; keys: string[] };

async function seed(tx: Db, s3: ReturnType<typeof memoryArchive>): Promise<Seed> {
  const sourceId = await insertTestSource(tx);
  const url = `https://${newId()}.test.invalid/page`;
  const [doc] = await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "trip_report" }).returning({ id: documents.id });
  const versionIds: string[] = [];
  const keys: string[] = [];
  for (const n of [1, 2]) {
    const rawKey = `archive/${doc!.id}/${n}.raw.html`;
    const mdKey = `archive/${doc!.id}/${n}.md`;
    await s3.put(rawKey, `<p>raw ${n} Ägina</p>`, "text/html");
    await s3.put(mdKey, `# md ${n}`, "text/markdown; charset=utf-8");
    keys.push(rawKey, mdKey);
    const [v] = await tx
      .insert(documentVersions)
      .values({
        documentId: doc!.id,
        fetchedAt: new Date(`2026-10-0${n}T10:00:00Z`),
        contentHash: newId(),
        rawHash: "r",
        rawKey,
        mdKey,
        contentType: "text/html",
        observedAt: "2026-10-01",
        observedAtBasis: "fetched",
        docType: "trip_report",
        converter: "local",
        charCount: 8,
      })
      .returning({ id: documentVersions.id });
    versionIds.push(v!.id);
  }
  await tx.update(documents).set({ currentVersionId: versionIds[1]! }).where(eq(documents.id, doc!.id));
  const serpKey = `serp/2026-10-01/${newId()}.json`;
  await s3.put(serpKey, "{}", "application/json");
  keys.push(serpKey);
  const [q] = await tx
    .insert(serpQueries)
    .values({ keyword: "ankerplatz", languageCode: "de", locationCode: 2300, depth: 10, level: "area", scopeId: "x", rawKey: serpKey, fetchedAt: new Date("2026-10-01T10:00:00Z") })
    .returning({ id: serpQueries.id });
  const [r] = await tx
    .insert(serpResults)
    .values({ serpQueryId: q!.id, rank: 1, url, urlNormalized: url, domain: "test.invalid", title: "t", snippet: "s" })
    .returning({ id: serpResults.id });
  return { sourceId, documentId: doc!.id, versionIds, queryId: q!.id, resultId: r!.id, keys };
}

async function exportSeeded(): Promise<{ dir: string; seeded: Seed }> {
  const dir = await mkdtemp(path.join(tmpdir(), "archive-copy-"));
  dirs.push(dir);
  const s3 = memoryArchive();
  const seeded = await withRollback(async (tx) => {
    const s = await seed(tx, s3);
    await exportArchive({ db: tx, archive: s3, dir });
    return s;
  });
  return { dir, seeded };
}

async function presentIds(tx: Db, s: Seed) {
  return {
    sources: (await tx.select({ id: sources.id }).from(sources).where(eq(sources.id, s.sourceId))).length,
    documents: await tx.select({ id: documents.id, cv: documents.currentVersionId }).from(documents).where(eq(documents.id, s.documentId)),
    versions: (await tx.select({ id: documentVersions.id }).from(documentVersions).where(inArray(documentVersions.id, s.versionIds))).length,
    queries: (await tx.select({ id: serpQueries.id }).from(serpQueries).where(eq(serpQueries.id, s.queryId))).length,
    results: (await tx.select({ id: serpResults.id }).from(serpResults).where(eq(serpResults.id, s.resultId))).length,
  };
}

describe("archive copy", () => {
  it("export then import copies rows with their ids, the current version and the objects; a second import inserts nothing", async () => {
    const { dir, seeded } = await exportSeeded();
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as { objects: Record<string, { sha256: string }> };
    expect(Object.keys(manifest.objects).sort()).toEqual([...seeded.keys].sort());
    expect(await readFile(path.join(dir, "objects", seeded.keys[1]!), "utf8")).toBe("# md 1");

    const target = memoryArchive();
    await withRollback(async (tx) => {
      const first = await importArchive({ db: tx, archive: target, dir });
      expect(first.objectErrors).toEqual([]);
      expect(first.tables.sources.inserted).toBeGreaterThanOrEqual(1);
      expect(first.tables.document_versions.inserted).toBeGreaterThanOrEqual(2);
      expect(first.tables.document_versions.after - first.tables.document_versions.before).toBe(first.tables.document_versions.inserted);
      const present = await presentIds(tx, seeded);
      expect(present).toMatchObject({ sources: 1, versions: 2, queries: 1, results: 1 });
      expect(present.documents).toEqual([{ id: seeded.documentId, cv: seeded.versionIds[1] }]);
      expect(target.keys()).toEqual([...seeded.keys].sort());
      expect(new TextDecoder().decode((await target.get(seeded.keys[1]!))!)).toBe("# md 1");
      expect(target.contentType(seeded.keys[0]!)).toBe("text/html");

      const second = await importArchive({ db: tx, archive: target, dir });
      for (const t of Object.values(second.tables)) expect(t.inserted).toBe(0);
      expect(second.objectsUploaded).toBe(0);
      expect(second.currentVersionsLinked).toBe(0);
      expect(second.tables.documents.after).toBe(first.tables.documents.after);
    });
  });

  it("a corrupted object counts as an error and its version is not inserted; the rest is", async () => {
    const { dir, seeded } = await exportSeeded();
    await writeFile(path.join(dir, "objects", seeded.keys[3]!), "# md X");
    const target = memoryArchive();
    await withRollback(async (tx) => {
      const report = await importArchive({ db: tx, archive: target, dir });
      expect(report.objectErrors).toEqual([{ key: seeded.keys[3], reason: expect.stringContaining("mismatch") }]);
      expect(report.tables.document_versions.skippedObjectError).toBe(1);
      const present = await presentIds(tx, seeded);
      expect(present.versions).toBe(1);
      expect(present.documents[0]!.cv).toBeNull();
      expect(target.keys()).not.toContain(seeded.keys[3]);
    });
  });

  it("a dry run counts but writes neither rows nor objects", async () => {
    const { dir, seeded } = await exportSeeded();
    const target = memoryArchive();
    await withRollback(async (tx) => {
      const report = await importArchive({ db: tx, archive: target, dir, dryRun: true });
      expect(report.dryRun).toBe(true);
      expect(report.tables.document_versions.inserted).toBeGreaterThanOrEqual(2);
      expect(report.objectsUploaded).toBeGreaterThanOrEqual(seeded.keys.length);
      for (const t of Object.values(report.tables)) expect(t.after).toBe(t.before);
      expect(await presentIds(tx, seeded)).toMatchObject({ sources: 0, versions: 0, queries: 0, results: 0, documents: [] });
      expect(target.keys()).toEqual([]);
    });
  });

  it("skips a row whose NOT NULL parent is outside the archive and the target, and counts it", async () => {
    const { dir } = await exportSeeded();
    const orphan = JSON.parse((await readFile(path.join(dir, "documents.jsonl"), "utf8")).split("\n")[0]!) as Record<string, unknown>;
    await appendFile(path.join(dir, "documents.jsonl"), JSON.stringify({ ...orphan, id: newId(), sourceId: newId(), urlNormalized: "https://orphan.invalid/" }) + "\n");
    const mf = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as { counts: Record<string, number> };
    mf.counts.documents++;
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify(mf));
    await withRollback(async (tx) => {
      const report = await importArchive({ db: tx, archive: memoryArchive(), dir });
      expect(report.tables.documents.skippedNoParent).toBe(1);
    });
  });
});

describe("archive copy: reruns and conflicts", () => {
  it("a rerun links the current version of documents inserted by an earlier run, never overwriting a link", async () => {
    const { dir, seeded } = await exportSeeded();
    const target = memoryArchive();
    await withRollback(async (tx) => {
      await importArchive({ db: tx, archive: target, dir });
      // simulate an aborted run: the link is missing although document and versions are there
      await tx.update(documents).set({ currentVersionId: null }).where(eq(documents.id, seeded.documentId));
      const rerun = await importArchive({ db: tx, archive: target, dir });
      expect(rerun.currentVersionsLinked).toBe(1);
      expect((await presentIds(tx, seeded)).documents[0]!.cv).toBe(seeded.versionIds[1]);
      // a link that is set stays, even when it differs
      await tx.update(documents).set({ currentVersionId: seeded.versionIds[0]! }).where(eq(documents.id, seeded.documentId));
      const again = await importArchive({ db: tx, archive: target, dir });
      expect(again.currentVersionsLinked).toBe(0);
      expect((await presentIds(tx, seeded)).documents[0]!.cv).toBe(seeded.versionIds[0]);
    });
  });

  it("a row swallowed by another unique key counts as conflict and its children are skipped, not failed", async () => {
    const { dir, seeded } = await exportSeeded();
    await withRollback(async (tx) => {
      const [src] = (await tx.select().from(sources).where(eq(sources.id, seeded.sourceId)));
      expect(src).toBeUndefined();
      // another source with the archive source's domain already lives in the target
      const lines = (await readFile(path.join(dir, "sources.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; domain: string });
      const mine = lines.find((l) => l.id === seeded.sourceId)!;
      await tx.insert(sources).values({ domain: mine.domain, name: "other", type: "trip_report", weight: 0.5, crawlRules: { startUrls: [] }, origin: "manual" });
      const report = await importArchive({ db: tx, archive: memoryArchive(), dir });
      expect(report.tables.sources.skippedConflict).toBe(1);
      expect(report.tables.documents.skippedNoParent).toBeGreaterThanOrEqual(1);
      expect((await presentIds(tx, seeded)).documents).toEqual([]);
    });
  });

  it("an existing target object with different content is an error and its version is not inserted", async () => {
    const { dir, seeded } = await exportSeeded();
    const target = memoryArchive();
    await target.put(seeded.keys[1]!, "foreign bytes", "text/plain");
    await withRollback(async (tx) => {
      const report = await importArchive({ db: tx, archive: target, dir });
      expect(report.objectErrors).toEqual([{ key: seeded.keys[1], reason: expect.stringContaining("different content") }]);
      expect((await presentIds(tx, seeded)).versions).toBe(1);
      expect(new TextDecoder().decode((await target.get(seeded.keys[1]!))!)).toBe("foreign bytes");
    });
  });

  it("fails when a table file has fewer rows than the manifest", async () => {
    const { dir } = await exportSeeded();
    await writeFile(path.join(dir, "serp_results.jsonl"), "");
    await withRollback(async (tx) => {
      await expect(importArchive({ db: tx, archive: memoryArchive(), dir })).rejects.toThrow(/manifest says/);
    });
  });
});
