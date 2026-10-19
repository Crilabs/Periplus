import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { Db } from "@/lib/db/client";
import { crawlFrontier, documents, documentVersions, sources, type DocType, type SourceStatus } from "@/lib/db/schema";
import { recordExternalCall } from "@/lib/domain/costs";
import { newId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import { documentOfOtherSource, listSources, sourceDetail } from "@/lib/domain/sources-view";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import {
  createManualSource,
  getSource,
  NotAPdf,
  pauseSource,
  resumeSource,
  SourceDomainKnown,
  SourceEnded,
  SourceNotUploadable,
  updateSourceSettings,
  uploadPdf,
} from "@/lib/domain/sources/store";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

async function insertSource(
  tx: Db,
  over: { domain?: string; status?: SourceStatus; type?: DocType; validTo?: string } = {},
): Promise<{ id: string; domain: string }> {
  const domain = over.domain ?? `${newId()}.test.invalid`;
  const [row] = await tx
    .insert(sources)
    .values({
      domain,
      name: `Name ${domain}`,
      type: over.type ?? "forum",
      weight: 0.4,
      status: over.status ?? "approved",
      crawlRules: DEFAULT_CRAWL_RULES,
      origin: "manual",
      validTo: over.validTo ?? null,
    })
    .returning({ id: sources.id });
  return { id: row!.id, domain };
}

let versionSeq = 0;
async function insertDocument(tx: Db, sourceId: string, versions: number, runId: string | null = null): Promise<string> {
  const url = `https://${newId()}.test.invalid/page`;
  const [doc] = await tx
    .insert(documents)
    .values({ sourceId, url, urlNormalized: url, docType: "forum", lastCheckedAt: new Date("2026-10-19T10:00:00Z") })
    .returning({ id: documents.id });
  for (let i = 0; i < versions; i++) {
    const [v] = await tx
      .insert(documentVersions)
      .values({
        documentId: doc!.id,
        fetchedAt: new Date(Date.UTC(2026, 9, 1 + i)),
        contentHash: `hash-${versionSeq++}-${newId()}`,
        rawHash: "r",
        rawKey: `archive/${doc!.id}/${i}.raw.html`,
        mdKey: `archive/${doc!.id}/${i}.md`,
        observedAt: "2026-10-01",
        observedAtBasis: "fetched",
        docType: "forum",
        converter: "local",
        language: "en",
        charCount: 10,
        runId,
      })
      .returning({ id: documentVersions.id });
    await tx.update(documents).set({ currentVersionId: v!.id }).where(eq(documents.id, doc!.id));
  }
  return doc!.id;
}

const pdfBytes = (text: string) => new TextEncoder().encode(`%PDF-1.7\n${text}\n%%EOF\n`);

describe("listSources", () => {
  it("listSources filters by status and type and counts documents and versions", () =>
    withRollback(async (tx) => {
      const tag = newId();
      const a = await insertSource(tx, { domain: `a-${tag}.test.invalid`, status: "approved", type: "forum" });
      const b = await insertSource(tx, { domain: `b-${tag}.test.invalid`, status: "paused", type: "forum" });
      await insertSource(tx, { domain: `c-${tag}.test.invalid`, status: "approved", type: "marina" });
      await insertDocument(tx, a.id, 2);
      await insertDocument(tx, a.id, 1);
      await insertDocument(tx, b.id, 1);
      const { id: runId } = await createRun(tx, {
        kind: "stage",
        scope: { type: "source", id: "approved" },
        stages: [],
        params: { sourceIds: [a.id] },
        triggeredBy: "test",
      });

      const all = await listSources(tx, { q: tag, page: 1 });
      expect(all.total).toBe(3);
      // Ordered by status (enum order: proposed, approved, rejected, paused), then domain.
      expect(all.rows.map((r) => r.domain)).toEqual([a.domain, `c-${tag}.test.invalid`, b.domain]);

      const filtered = await listSources(tx, { q: tag, status: "approved", type: "forum", page: 1 });
      expect(filtered.total).toBe(1);
      expect(filtered.rows).toEqual([
        expect.objectContaining({
          id: a.id,
          domain: a.domain,
          status: "approved",
          type: "forum",
          weight: expect.closeTo(0.4, 5),
          documents: 2,
          versions: 3,
          lastRun: { id: runId, status: "queued", finishedAt: null },
          costEur30d: 0,
        }),
      ]);
      expect((await listSources(tx, { q: tag, page: 2 })).rows).toEqual([]);
    }));

  it("listSources leaves out ended sources", () =>
    withRollback(async (tx) => {
      const tag = newId();
      const current = await insertSource(tx, { domain: `a-${tag}.test.invalid` });
      await insertSource(tx, { domain: `e-${tag}.test.invalid`, validTo: "2026-01-01" });
      const list = await listSources(tx, { q: tag, page: 1 });
      expect(list.total).toBe(1);
      expect(list.rows.map((r) => r.id)).toEqual([current.id]);
    }));

  it("costs per source come from external_calls.source_id", () =>
    withRollback(async (tx) => {
      const source = await insertSource(tx);
      const other = await insertSource(tx);
      const stage = `sources-view-${newId()}`;
      await recordExternalCall(tx, { service: "jina", operation: "read", units: 1, unit: "request", costEur: 0.25, sourceId: source.id, stage });
      await recordExternalCall(tx, { service: "jina", operation: "read", units: 1, unit: "request", costEur: 0.5, sourceId: source.id, stage });
      await recordExternalCall(tx, { service: "voyage", operation: "embed", units: 10, unit: "tokens", costEur: 0.125, sourceId: source.id, stage });
      // Older than 30 days: in the total, not in the 30-day column.
      await recordExternalCall(tx, {
        service: "voyage",
        operation: "embed",
        units: 10,
        unit: "tokens",
        costEur: 1,
        sourceId: source.id,
        stage,
        at: new Date(Date.now() - 40 * 86_400_000),
      });
      await recordExternalCall(tx, { service: "jina", operation: "read", units: 1, unit: "request", costEur: 9, sourceId: other.id, stage });
      await recordExternalCall(tx, { service: "jina", operation: "read", units: 1, unit: "request", costEur: 9, stage });

      const [row] = (await listSources(tx, { q: source.domain, page: 1 })).rows;
      expect(row!.costEur30d).toBeCloseTo(0.875, 6);
      const detail = await sourceDetail(tx, source.id, { docPage: 1 });
      expect(detail!.costs.totalEur).toBeCloseTo(1.875, 6);
      expect(detail!.costs.byService).toEqual([
        { service: "jina", calls: 2, costEur: 0.75 },
        { service: "voyage", calls: 2, costEur: 1.125 },
      ]);
    }));
});

describe("sourceDetail", () => {
  it("has rules, frontier counts, documents and the runs of the source", () =>
    withRollback(async (tx) => {
      const source = await insertSource(tx);
      const docId = await insertDocument(tx, source.id, 2);
      await tx.insert(crawlFrontier).values([
        { sourceId: source.id, url: "https://x.test.invalid/1", urlNormalized: "https://x.test.invalid/1", status: "queued" },
        { sourceId: source.id, url: "https://x.test.invalid/2", urlNormalized: "https://x.test.invalid/2", status: "fetched" },
        { sourceId: source.id, url: "https://x.test.invalid/3", urlNormalized: "https://x.test.invalid/3", status: "fetched" },
      ]);
      const own = await createRun(tx, { kind: "stage", scope: { type: "source", id: source.id }, stages: [], triggeredBy: "test" });
      const viaParams = await createRun(tx, {
        kind: "stage",
        scope: { type: "source", id: "selection" },
        stages: [],
        params: { sourceIds: [newId(), source.id] },
        triggeredBy: "test",
      });
      await createRun(tx, { kind: "stage", scope: { type: "source", id: newId() }, stages: [], triggeredBy: "test" });

      const detail = (await sourceDetail(tx, source.id, { docPage: 1 }))!;
      expect(detail.source).toMatchObject({ id: source.id, domain: source.domain, crawlRules: DEFAULT_CRAWL_RULES, origin: "manual" });
      expect(detail.frontier).toEqual({ queued: 1, fetched: 2, skipped: 0, failed: 0 });
      expect(detail.documentTotal).toBe(1);
      expect(detail.documents).toEqual([
        expect.objectContaining({ id: docId, status: "active", versions: 2, language: "en", lastCheckedAt: new Date("2026-10-19T10:00:00Z") }),
      ]);
      expect(detail.runs.map((r) => r.id)).toEqual([viaParams.id, own.id]);
      expect(await sourceDetail(tx, newId(), { docPage: 1 })).toBeNull();
    }));
});

describe("source settings", () => {
  it("saving rules with an invalid regex changes nothing", () =>
    withRollback(async (tx) => {
      const source = await insertSource(tx);
      const before = await getSource(tx, source.id);
      await expect(
        updateSourceSettings(tx, source.id, {
          name: "Neu",
          type: "marina",
          weight: 0.8,
          changeRate: "high",
          crawlRules: { ...DEFAULT_CRAWL_RULES, allow: ["(unclosed"] },
        }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(await getSource(tx, source.id)).toEqual(before);

      await updateSourceSettings(tx, source.id, {
        name: "  Neu  ",
        type: "marina",
        weight: 0.8,
        changeRate: "high",
        crawlRules: { ...DEFAULT_CRAWL_RULES, allow: ["^/bays/"] },
      });
      expect(await getSource(tx, source.id)).toMatchObject({
        name: "Neu",
        type: "marina",
        weight: expect.closeTo(0.8, 5),
        changeRate: "high",
        crawlRules: { allow: ["^/bays/"] },
      });
    }));

  it("an ended source is read-only: settings, pause and resume change nothing", () =>
    withRollback(async (tx) => {
      const ended = await insertSource(tx, { status: "approved", validTo: "2026-01-01" });
      const endedPaused = await insertSource(tx, { status: "paused", validTo: "2026-01-01" });
      const before = await getSource(tx, ended.id);
      await expect(
        updateSourceSettings(tx, ended.id, {
          name: "Neu",
          type: "marina",
          weight: 0.8,
          changeRate: "high",
          crawlRules: DEFAULT_CRAWL_RULES,
        }),
      ).rejects.toBeInstanceOf(SourceEnded);
      expect(await pauseSource(tx, ended.id)).toBe(false);
      expect(await resumeSource(tx, endedPaused.id)).toBe(false);
      expect(await getSource(tx, ended.id)).toEqual(before);
      expect((await getSource(tx, endedPaused.id))!.status).toBe("paused");
    }));

  it("a proposed source cannot be paused from the source page", () =>
    withRollback(async (tx) => {
      const proposed = await insertSource(tx, { status: "proposed" });
      expect(await pauseSource(tx, proposed.id)).toBe(false);
      expect(await resumeSource(tx, proposed.id)).toBe(false);
      expect((await getSource(tx, proposed.id))!.status).toBe("proposed");

      const approved = await insertSource(tx, { status: "approved" });
      expect(await pauseSource(tx, approved.id)).toBe(true);
      expect((await getSource(tx, approved.id))!.status).toBe("paused");
      expect(await pauseSource(tx, approved.id)).toBe(false);
      expect(await resumeSource(tx, approved.id)).toBe(true);
      expect(await getSource(tx, approved.id)).toMatchObject({ status: "approved", statusReason: null });
    }));

  it("createManualSource refuses a known domain", () =>
    withRollback(async (tx) => {
      const tag = newId();
      // A public suffix the Public Suffix List knows (`.invalid` is not on it): `www.` and the path drop off.
      const { id } = await createManualSource(tx, { domain: `https://www.p${tag}.com/guide`, name: "Handbuch", type: "pilot_guide" });
      expect(await getSource(tx, id)).toMatchObject({
        domain: `p${tag}.com`,
        name: "Handbuch",
        type: "pilot_guide",
        weight: expect.closeTo(0.9, 5),
        status: "approved",
        origin: "manual",
        crawlRules: DEFAULT_CRAWL_RULES,
      });
      // Another host of the same registrable domain, also an ended source's domain.
      await expect(createManualSource(tx, { domain: `Blog.P${tag}.com`, name: "X", type: "forum" })).rejects.toBeInstanceOf(
        SourceDomainKnown,
      );
      const ended = await insertSource(tx, { domain: `e${tag}.com`, validTo: "2026-01-01" });
      await expect(createManualSource(tx, { domain: ended.domain, name: "X", type: "forum" })).rejects.toBeInstanceOf(SourceDomainKnown);
    }));
});

describe("uploadPdf", () => {
  it("the same pdf uploaded twice is one document", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const source = await insertSource(tx, { type: "pilot_guide", status: "proposed" });
      const bytes = pdfBytes(newId());
      const sha = createHash("sha256").update(bytes).digest("hex");

      const first = await uploadPdf(tx, archive, { sourceId: source.id, bytes });
      expect(first).toMatchObject({ sourceId: source.id, created: true });
      expect(archive.keys()).toEqual([`uploads/${sha}.pdf`]);
      const [doc] = await tx.select().from(documents).where(eq(documents.id, first.documentId));
      expect(doc).toMatchObject({ sourceId: source.id, url: `upload://${sha}`, urlNormalized: `upload://${sha}`, docType: "pilot_guide" });

      const second = await uploadPdf(tx, archive, { sourceId: source.id, bytes });
      expect(second).toEqual({ documentId: first.documentId, sourceId: source.id, created: false });
    }));

  it("the same pdf on a second source returns the document and source it was archived for first", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const first = await insertSource(tx);
      const second = await insertSource(tx);
      const bytes = pdfBytes(newId());
      const upload = await uploadPdf(tx, archive, { sourceId: first.id, bytes });

      const again = await uploadPdf(tx, archive, { sourceId: second.id, bytes });
      expect(again).toEqual({ documentId: upload.documentId, sourceId: first.id, created: false });
      expect(await documentOfOtherSource(tx, upload.documentId, second.id)).toEqual({
        documentId: upload.documentId,
        sourceDomain: first.domain,
      });
      expect(await documentOfOtherSource(tx, upload.documentId, first.id)).toBeNull();
      expect(await documentOfOtherSource(tx, newId(), second.id)).toBeNull();
    }));

  it("only a current approved, proposed or paused source takes uploads; nothing is stored otherwise", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const refused = [
        await insertSource(tx, { status: "rejected" }),
        await insertSource(tx, { status: "paused", validTo: "2026-01-01" }),
        await insertSource(tx, { status: "approved", validTo: "2026-01-01" }),
      ];
      for (const source of refused) {
        await expect(uploadPdf(tx, archive, { sourceId: source.id, bytes: pdfBytes(newId()) })).rejects.toBeInstanceOf(
          SourceNotUploadable,
        );
      }
      expect(archive.keys()).toEqual([]);
      for (const status of ["approved", "proposed", "paused"] as const) {
        const source = await insertSource(tx, { status });
        await expect(uploadPdf(tx, archive, { sourceId: source.id, bytes: pdfBytes(newId()) })).resolves.toMatchObject({
          created: true,
        });
      }
    }));

  it("a file that is not a pdf is rejected", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const source = await insertSource(tx);
      await expect(
        uploadPdf(tx, archive, { sourceId: source.id, bytes: new TextEncoder().encode("<html>no pdf</html>") }),
      ).rejects.toBeInstanceOf(NotAPdf);
      expect(archive.keys()).toEqual([]);
      expect(await tx.select().from(documents).where(eq(documents.sourceId, source.id))).toEqual([]);
    }));
});
