import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { documentDetail, versionContent, versionDiff } from "@/lib/domain/document-view";
import { ensureDocument, storeFetched, type FetchedContent } from "@/lib/domain/documents/store";
import { newId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

const sentence = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `The ${topic} anchorage offers sand and weed at five metres, line ${i}.`).join(" ");

async function newDocument(tx: Db) {
  const domain = `${newId()}.test.invalid`;
  const [source] = await tx
    .insert(sources)
    .values({ domain, name: "Viewer test", type: "pilot_guide", weight: 0.9, status: "paused", crawlRules: {}, origin: "manual" })
    .returning({ id: sources.id });
  const url = `https://${domain}/guide`;
  const doc = await ensureDocument(tx, { sourceId: source!.id, url, urlNormalized: url, docType: "pilot_guide" });
  return { sourceId: source!.id, domain, url, documentId: doc.id };
}

function content(markdown: string, fetchedAt: Date): FetchedContent {
  return {
    fetchedAt,
    raw: new TextEncoder().encode(`<html><body>${markdown}</body></html>`),
    rawExt: "html",
    contentType: "text/html; charset=utf-8",
    finalUrl: null,
    markdown,
    converter: "local",
    language: "en",
    publishedAt: "2026-05-01",
    docType: "pilot_guide",
    etag: null,
    lastModified: null,
  };
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 19, 10, minute));

function guide(east: string): string {
  return ["# Harbour guide", "## North bay", sentence("north", 25), "## East bay", sentence(east, 25), "## South bay", sentence("south", 25)].join(
    "\n\n",
  );
}

/** Twenty paragraphs `Line 1` … `Line 20`, line 10 replaced by `changed`. */
const lines = (changed?: string) =>
  Array.from({ length: 20 }, (_, i) => (i === 9 && changed ? changed : `Line ${i + 1}`)).join("\n\n");

describe("documentDetail", () => {
  it("lists the versions newest first", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const { documentId, sourceId, domain, url } = await newDocument(tx);
      const first = await storeFetched(tx, archive, documentId, content(guide("east"), at(0)));
      const second = await storeFetched(tx, archive, documentId, content(guide("changed east"), at(10)));

      const detail = (await documentDetail(tx, documentId))!;
      expect(detail.document).toMatchObject({ id: documentId, url, status: "active", currentVersionId: second.versionId });
      expect(detail.source).toEqual({ id: sourceId, domain, name: "Viewer test", type: "pilot_guide", weight: expect.closeTo(0.9, 5) });
      expect(detail.versions.map((v) => v.id)).toEqual([second.versionId, first.versionId]);
      expect(detail.versions[0]).toMatchObject({
        fetchedAt: at(10),
        converter: "local",
        language: "en",
        publishedAt: "2026-05-01",
        basis: "published",
        simulated: false,
      });
      expect(detail.versions[0]!.hash8).toMatch(/^[0-9a-f]{8}$/);
      expect(await documentDetail(tx, newId())).toBeNull();
    }));
});

describe("versionContent", () => {
  it("reads the markdown of a version from the archive, without chunks; a version of another document is null", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const { documentId } = await newDocument(tx);
      const other = await newDocument(tx);
      const v = await storeFetched(tx, archive, documentId, content(guide("east"), at(0)));
      const foreign = await storeFetched(tx, archive, other.documentId, content(guide("west"), at(0)));

      expect(await versionContent(tx, archive, documentId, v.versionId)).toEqual({ markdown: expect.stringContaining("## East bay") });
      expect(await versionContent(tx, archive, documentId, foreign.versionId)).toBeNull();
      expect(await versionContent(tx, archive, documentId, newId())).toBeNull();
    }));
});

describe("versionDiff", () => {
  it("versionDiff marks the changed line and collapses long unchanged runs", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const { documentId } = await newDocument(tx);
      const other = await newDocument(tx);
      const from = await storeFetched(tx, archive, documentId, content(lines(), at(0)));
      const to = await storeFetched(tx, archive, documentId, content(lines("Line ten, changed"), at(10)));
      const foreign = await storeFetched(tx, archive, other.documentId, content(lines(), at(0)));

      const diff = (await versionDiff(tx, archive, documentId, from.versionId, to.versionId))!;
      expect(diff.filter((d) => d.kind === "removed")).toEqual([{ kind: "removed", text: "Line 10" }]);
      expect(diff.filter((d) => d.kind === "added")).toEqual([{ kind: "added", text: "Line ten, changed" }]);
      // The 17+ unchanged lines before the change: the first 3, "…", the last 3.
      expect(diff.slice(0, 4)).toEqual([
        { kind: "same", text: "Line 1" },
        { kind: "same", text: "" },
        { kind: "same", text: "Line 2" },
        { kind: "same", text: "…" },
      ]);
      expect(diff.filter((d) => d.text === "…")).toHaveLength(2);
      expect(diff.length).toBeLessThan(20);

      expect(await versionDiff(tx, archive, documentId, from.versionId, foreign.versionId)).toBeNull();
    }));
});
