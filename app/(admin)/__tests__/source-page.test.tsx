import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { documents, sources, type SourceStatus } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { testDb, withRollback } from "@/test/db";

let currentDb: Db = testDb();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: async () => ({ email: "admin@example.invalid" }) }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => currentDb,
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import Page from "../sources/[id]/page";

async function insertSource(tx: Db, status: SourceStatus, validTo: string | null = null): Promise<{ id: string; domain: string }> {
  const domain = `${newId()}.test.invalid`;
  const [row] = await tx
    .insert(sources)
    .values({ domain, name: domain, type: "forum", weight: 0.72, status, crawlRules: DEFAULT_CRAWL_RULES, origin: "manual", validTo })
    .returning({ id: sources.id });
  return { id: row!.id, domain };
}

async function render(id: string, searchParams: Record<string, string> = {}): Promise<string> {
  const tree = await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve(searchParams) } as PageProps<"/sources/[id]">);
  return renderToStaticMarkup(tree);
}

beforeEach(() => {
  currentDb = testDb();
});

describe("source page", () => {
  it("an approved source can be saved, crawled and take uploads; any stored weight submits", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const html = await render((await insertSource(tx, "approved")).id);
      expect(html).toContain(">Speichern<");
      expect(html).toContain(">Crawlen<");
      expect(html).toContain("Hochladen und archivieren");
      // A step of 0.05 would make the browser refuse the whole form for the stored 0.72.
      expect(html).toMatch(/<input type="number"[^>]*step="any"[^>]*name="weight" value="0.72"/);
      expect(html).not.toMatch(/<fieldset disabled/);
    }));

  it("an ended source is read-only", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const html = await render((await insertSource(tx, "approved", "2026-01-01")).id);
      expect(html).toContain("beendet am 2026-01-01");
      expect(html).not.toContain(">Speichern<");
      expect(html).not.toContain(">Crawlen<");
      expect(html).not.toContain(">Pausieren<");
      expect(html).not.toContain("Hochladen und archivieren");
      expect(html).toMatch(/<fieldset disabled=""/);
    }));

  it("a paused source takes no upload", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const html = await render((await insertSource(tx, "paused")).id);
      expect(html).toContain(">Fortsetzen<");
      expect(html).not.toContain("Hochladen und archivieren");
    }));

  it("names the source a pdf was archived for first, with a link to the document", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const first = await insertSource(tx, "approved");
      const second = await insertSource(tx, "approved");
      const url = `upload://${newId()}`;
      const [doc] = await tx
        .insert(documents)
        .values({ sourceId: first.id, url, urlNormalized: url, docType: "forum" })
        .returning({ id: documents.id });
      const html = await render(second.id, { archived: doc!.id });
      expect(html).toContain(`href="/documents/${doc!.id}"`);
      expect(html).toContain(`ist bereits bei Quelle ${first.domain} archiviert.`);
      // The uploading source itself or an unknown id shows nothing.
      expect(await render(first.id, { archived: doc!.id })).not.toContain("bereits bei Quelle");
      expect(await render(second.id, { archived: "x" })).not.toContain("bereits bei Quelle");
    }));
});
