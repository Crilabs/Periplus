import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { ensureDocument, storeFetched } from "@/lib/domain/documents/store";
import { newId } from "@/lib/domain/ids";
import { testDb, withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

let db: Db = testDb();
let archive = memoryArchive();
const adminSession = vi.fn();

vi.mock("@/lib/security/require-admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/require-admin")>()),
  adminSession: () => adminSession(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => db,
}));
vi.mock("@/lib/adapters/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters/s3")>()),
  getArchive: () => archive,
}));

const { GET } = await import("../documents/[id]/raw/[versionId]/route");

const cfg = { targetWords: 500, maxWords: 800, maxOverlapWords: 200 };
const RAW = "<html><body><script>alert(document.cookie)</script><p>Anchor in sand.</p></body></html>";

/** A document with one archived HTML version. */
async function archived(tx: Db): Promise<{ id: string; versionId: string }> {
  const domain = `${newId()}.test.invalid`;
  const [source] = await tx
    .insert(sources)
    .values({ domain, name: "Raw test", type: "forum", weight: 0.4, status: "paused", crawlRules: {}, origin: "manual" })
    .returning({ id: sources.id });
  const url = `https://${domain}/page`;
  const { id } = await ensureDocument(tx, { sourceId: source!.id, url, urlNormalized: url, docType: "forum" });
  const { versionId } = await storeFetched(
    tx,
    archive,
    id,
    {
      fetchedAt: new Date("2026-10-19T10:00:00Z"),
      raw: new TextEncoder().encode(RAW),
      rawExt: "html",
      contentType: "text/html; charset=utf-8",
      finalUrl: null,
      markdown: "Anchor in sand.",
      converter: "local",
      language: "en",
      publishedAt: null,
      docType: "forum",
      etag: null,
      lastModified: null,
    },
    cfg,
  );
  return { id, versionId };
}

const call = (id: string, versionId: string) =>
  GET(new NextRequest(`http://localhost/documents/${id}/raw/${versionId}`), { params: Promise.resolve({ id, versionId }) });

beforeEach(() => {
  vi.resetAllMocks();
  db = testDb();
  archive = memoryArchive();
  adminSession.mockResolvedValue({ sub: newId(), email: "admin@example.invalid" });
});

describe("GET /documents/[id]/raw/[versionId]", () => {
  it("the raw route serves archived html as a sandboxed attachment", () =>
    withRollback(async (tx) => {
      db = tx;
      const { id, versionId } = await archived(tx);
      const res = await call(id, versionId);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("content-disposition")).toMatch(/filename="[0-9a-f]{8}\.html"$/);
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toBe(RAW);
    }));

  it("a version of another document is 404", () =>
    withRollback(async (tx) => {
      db = tx;
      const a = await archived(tx);
      const b = await archived(tx);
      expect((await call(a.id, b.versionId)).status).toBe(404);
      expect((await call(a.id, "not-a-uuid")).status).toBe(404);
    }));

  it("a missing archive object is 404", () =>
    withRollback(async (tx) => {
      db = tx;
      const { id, versionId } = await archived(tx);
      archive = memoryArchive();
      expect((await call(id, versionId)).status).toBe(404);
    }));

  it("401 without a session, never the file", () =>
    withRollback(async (tx) => {
      db = tx;
      const { id, versionId } = await archived(tx);
      adminSession.mockResolvedValue(null);
      const res = await call(id, versionId);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("Anchor");
    }));
});
