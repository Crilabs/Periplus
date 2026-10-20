import { readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { documents, runs, sources, tiles, type SourceStatus } from "@/lib/db/schema";
import { tileIdFor } from "@/lib/domain/tiles";
import { newId } from "@/lib/domain/ids";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { getSource } from "@/lib/domain/sources/store";
import { insertPlace, insertTextFact } from "@/test/consolidation";
import { insertTestVersion } from "@/test/text";
import { testDb, withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

const db = testDb();
/** What getDb() returns; each test points it at its rollback transaction (no source is ever committed). */
let currentDb: Db = db;
const requireAdmin = vi.fn();
const redirect = vi.fn();
let archive = memoryArchive();

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => currentDb,
}));
/** The job queue cannot be reached (getBoss throws), e.g. right after an upload committed. */
let bossDown = false;
// Jobs are only collected: no worker runs.
vi.mock("@/lib/jobs/boss", () => ({
  getBoss: async () => {
    if (bossDown) throw new Error("queue down");
    return { insert: async (_queue: string, jobs: Array<{ id: string }>) => jobs.map((j) => j.id) };
  },
}));
vi.mock("@/lib/adapters/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters/s3")>()),
  getArchive: () => archive,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
  // Like the real one, it ends the action.
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { crawlAllApprovedAction, createSourceAction, pendingSourceTextRunAction } from "../sources/actions";
import { discoveryForTileAction } from "../tiles/[id]/actions";
import { crawlAction, endSourceAction, pauseSourceAction, saveSourceAction, testCrawlAction, uploadPdfAction } from "../sources/[id]/actions";

import nextConfig from "@/next.config";

const ADMIN = "admin@example.invalid";

const form = (fields: Record<string, string | Blob>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

async function insertSource(tx: Db, status: SourceStatus = "approved", validTo: string | null = null): Promise<string> {
  const domain = `${newId()}.test.invalid`;
  const [row] = await tx
    .insert(sources)
    .values({ domain, name: domain, type: "forum", weight: 0.4, status, crawlRules: DEFAULT_CRAWL_RULES, origin: "manual", validTo })
    .returning({ id: sources.id });
  return row!.id;
}

/** The settings form as the source page renders it. */
const settingsForm = (sourceId: string, overrides: Record<string, string> = {}) =>
  form({
    sourceId,
    name: "Neuer Name",
    type: "marina",
    weight: "0.7",
    changeRate: "high",
    startUrls: "",
    allow: "^/bays/",
    deny: "",
    maxDepth: "3",
    maxPages: "500",
    ratePerMinute: "20",
    render: "auto",
    converter: "auto",
    pdf: "on",
    boilerplateSelectors: "",
    ...overrides,
  });

beforeEach(() => {
  vi.resetAllMocks();
  bossDown = false;
  currentDb = db;
  archive = memoryArchive();
  requireAdmin.mockResolvedValue({ email: ADMIN });
});

describe("saveSourceAction", () => {
  it("saveSourceAction rejects weight 1.5", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      const before = await getSource(tx, sourceId);
      await saveSourceAction(settingsForm(sourceId, { weight: "1.5", deny: "(unclosed" }));
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?invalid=weight,deny`);
      expect(await getSource(tx, sourceId)).toEqual(before);
    }));

  it("an invalid boilerplate selector comes back as invalid and saves nothing", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      const before = await getSource(tx, sourceId);
      await saveSourceAction(settingsForm(sourceId, { boilerplateSelectors: ".nav\ndiv >> p" }));
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?invalid=boilerplateSelectors`);
      expect(await getSource(tx, sourceId)).toEqual(before);
    }));

  it("a blank weight is invalid, not 0", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      await saveSourceAction(settingsForm(sourceId, { weight: "  " }));
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?invalid=weight`);
    }));

  it("saves valid settings", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      await saveSourceAction(settingsForm(sourceId));
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?saved=1`);
      expect(await getSource(tx, sourceId)).toMatchObject({
        name: "Neuer Name",
        type: "marina",
        weight: expect.closeTo(0.7, 5),
        changeRate: "high",
        crawlRules: { allow: ["^/bays/"] },
      });
    }));

  it("an ended source is not saved", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx, "approved", "2026-01-01");
      const before = await getSource(tx, sourceId);
      await saveSourceAction(settingsForm(sourceId));
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?error=source_ended`);
      expect(await getSource(tx, sourceId)).toEqual(before);
    }));

  it("a malformed source id is a 404, not a server error", async () => {
    await expect(saveSourceAction(settingsForm("not-a-uuid"))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(crawlAction(form({ sourceId: "1; drop" }))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(uploadPdfAction(form({}))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("rejects without admin session", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      requireAdmin.mockRejectedValue(new Error("unauthorized"));
      await expect(saveSourceAction(settingsForm(sourceId))).rejects.toThrow("unauthorized");
      expect((await getSource(tx, sourceId))!.name).not.toBe("Neuer Name");
    }));
});

describe("endSourceAction (ruling M6-H-R1)", () => {
  it("ends an approved source, then starts one consolidation run for its objects and says so", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      const { objectId } = await insertPlace(tx, { name: "Quellenbucht" });
      await insertTextFact(tx, objectId, sourceId, { attribute: "holding", value: "good", observedAt: "2026-07-01" });
      await endSourceAction(form({ sourceId }));
      expect(requireAdmin).toHaveBeenCalled();
      expect((await getSource(tx, sourceId))!.validTo).not.toBeNull();
      const [run] = await tx.select({ id: runs.id, params: runs.params }).from(runs).where(sql`${runs.params}->'geoObjectIds' ? ${objectId}`);
      expect(run).toMatchObject({ params: { geoObjectIds: [objectId] } });
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?ended=1&run=${run!.id}`);
    }));

  it("a source without facts ends without a run; a proposed or ended one is refused; a bad id is a 404", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const paused = await insertSource(tx, "paused");
      await endSourceAction(form({ sourceId: paused }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${paused}?ended=0`);
      const proposed = await insertSource(tx, "proposed");
      await endSourceAction(form({ sourceId: proposed }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${proposed}?error=not_endable`);
      expect((await getSource(tx, proposed))!.validTo).toBeNull();
      await endSourceAction(form({ sourceId: paused }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${paused}?error=not_endable`);
      await expect(endSourceAction(form({ sourceId: "not-a-uuid" }))).rejects.toThrow("NEXT_NOT_FOUND");
    }));

  it("rejects without admin session", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      requireAdmin.mockRejectedValue(new Error("not an admin"));
      await expect(endSourceAction(form({ sourceId }))).rejects.toThrow("not an admin");
      expect((await getSource(tx, sourceId))!.validTo).toBeNull();
    }));
});

describe("status and crawl actions", () => {
  it("pausing a proposed source redirects with an error and changes nothing", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx, "proposed");
      await pauseSourceAction(form({ sourceId }));
      expect(redirect).toHaveBeenCalledWith(`/sources/${sourceId}?error=not_approved`);
      expect((await getSource(tx, sourceId))!.status).toBe("proposed");
    }));

  it("a crawl of a source that is being fetched shows the German refusal instead of failing", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      await crawlAction(form({ sourceId }));
      expect(redirect).toHaveBeenLastCalledWith(expect.stringMatching(/^\/runs\/[0-9a-f-]{36}$/));
      await testCrawlAction(form({ sourceId }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${sourceId}?error=source_run_active`);
    }));

  it("\"Alle freigegebenen crawlen\" names the sources it skipped", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const busy = await insertSource(tx);
      await insertSource(tx);
      await crawlAction(form({ sourceId: busy }));
      await crawlAllApprovedAction();
      const target = String(redirect.mock.lastCall![0]);
      const url = new URL(target, "http://localhost");
      expect(url.pathname).toBe("/sources");
      expect(url.searchParams.get("skipped")!.split(",")).toContain(busy);
      const [run] = await tx.select().from(runs).where(eq(runs.id, url.searchParams.get("run")!));
      expect((run!.params as { sourceIds: string[] }).sourceIds).not.toContain(busy);
    }));
});

describe("createSourceAction", () => {
  it("creates an approved manual source and refuses its domain a second time", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const domain = `m${newId()}.com`;
      await createSourceAction(form({ domain: `https://www.${domain}/`, name: "Handbuch", type: "pilot_guide" }));
      const [row] = await tx.select().from(sources).where(eq(sources.domain, domain));
      expect(row).toMatchObject({ status: "approved", origin: "manual", name: "Handbuch" });
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${row!.id}`);

      await createSourceAction(form({ domain, name: "Nochmal", type: "forum" }));
      expect(redirect).toHaveBeenLastCalledWith("/sources?error=domain_known");
      await createSourceAction(form({ domain: "kein domain", name: "X", type: "forum" }));
      expect(redirect).toHaveBeenLastCalledWith("/sources?error=invalid_domain");
      await createSourceAction(form({ domain: "https://fr.navily.com/", name: "Navily", type: "forum" }));
      expect(redirect).toHaveBeenLastCalledWith("/sources?error=forbidden_domain");
    }));
});

describe("uploadPdfAction", () => {
  it("the body limits leave room for the multipart overhead of a pdf just under 100 MB", () => {
    // The action refuses files over 100 MB itself; the request around such a file is a few KB larger.
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe("101mb");
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe("101mb");
  });

  it("the edge allows such a body (101 MiB, as Next reads 101mb) only on a source page, 1 MB elsewhere (SEC-1, W2-M-1)", () => {
    const caddy = readFileSync("docker/Caddyfile", "utf8");
    expect(caddy).toMatch(/@sourcePage path_regexp \^\/sources\/\[0-9a-fA-F-\]\{36\}\/\?\$\s*request_body @sourcePage \{\s*max_size 101MiB\s*\}/);
    expect(caddy).toMatch(/@otherPaths not path_regexp \^\/sources\/\[0-9a-fA-F-\]\{36\}\/\?\$\s*request_body @otherPaths \{\s*max_size 1MB/);
  });

  const pdf = (text: string) => new Blob([`%PDF-1.7\n${text}\n%%EOF\n`], { type: "application/pdf" });

  it("stores the pdf and starts its upload run", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx, "proposed");
      await uploadPdfAction(form({ sourceId, file: new File([pdf(newId())], "guide.pdf", { type: "application/pdf" }) }));
      const target = String(redirect.mock.lastCall![0]);
      expect(target).toMatch(/^\/runs\/[0-9a-f-]{36}$/);
      const [doc] = await tx.select().from(documents).where(eq(documents.sourceId, sourceId));
      expect(doc!.url).toMatch(/^upload:\/\/[0-9a-f]{64}$/);
      const [run] = await tx.select().from(runs).where(eq(runs.id, target.slice("/runs/".length)));
      expect(run!.params).toEqual({ documentIds: [doc!.id] });
      expect(archive.keys()).toEqual([`uploads/${doc!.url.slice("upload://".length)}.pdf`]);
    }));

  it("the file stays archived when its run cannot start, and the page says so instead of an error page (UI-7)", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      bossDown = true;
      await uploadPdfAction(form({ sourceId, file: new File([pdf(newId())], "guide.pdf", { type: "application/pdf" }) }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${sourceId}?error=upload_run_not_started`);
      expect(await tx.select().from(documents).where(eq(documents.sourceId, sourceId))).toHaveLength(1);
    }));

  it("a file that is not a pdf comes back with an error", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      await uploadPdfAction(form({ sourceId, file: new File(["<html></html>"], "page.pdf", { type: "application/pdf" }) }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${sourceId}?error=not_pdf`);
      expect(archive.keys()).toEqual([]);
    }));

  it("no file and a file over 100 MB come back with an error and store nothing", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx);
      await uploadPdfAction(form({ sourceId }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${sourceId}?error=no_file`);
      await uploadPdfAction(form({ sourceId, file: new File([], "empty.pdf", { type: "application/pdf" }) }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${sourceId}?error=no_file`);
      const big = new Uint8Array(100 * 1024 * 1024 + 1);
      big.set(new TextEncoder().encode("%PDF-1.7\n"));
      await uploadPdfAction(form({ sourceId, file: new File([big], "big.pdf", { type: "application/pdf" }) }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${sourceId}?error=too_large`);
      expect(archive.keys()).toEqual([]);
      expect(await tx.select().from(documents).where(eq(documents.sourceId, sourceId))).toEqual([]);
    }));

  it("a paused source takes an upload and starts its run (ruling M3-E-R2)", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const sourceId = await insertSource(tx, "paused");
      await uploadPdfAction(form({ sourceId, file: new File([pdf(newId())], "guide.pdf", { type: "application/pdf" }) }));
      expect(String(redirect.mock.lastCall![0])).toMatch(/^\/runs\/[0-9a-f-]{36}$/);
      expect(await tx.select().from(documents).where(eq(documents.sourceId, sourceId))).toHaveLength(1);
    }));

  it("a rejected or ended source takes no upload", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      for (const sourceId of [
        await insertSource(tx, "paused", "2026-01-01"),
        await insertSource(tx, "rejected"),
        await insertSource(tx, "approved", "2026-01-01"),
      ]) {
        await uploadPdfAction(form({ sourceId, file: new File([pdf(newId())], "guide.pdf", { type: "application/pdf" }) }));
        expect(redirect).toHaveBeenLastCalledWith(`/sources/${sourceId}?error=upload_not_allowed`);
      }
      expect(archive.keys()).toEqual([]);
    }));

  it("a pdf archived for another source starts no run and names that source", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const first = await insertSource(tx);
      const second = await insertSource(tx);
      const text = newId();
      await uploadPdfAction(form({ sourceId: first, file: new File([pdf(text)], "guide.pdf", { type: "application/pdf" }) }));
      const [doc] = await tx.select().from(documents).where(eq(documents.sourceId, first));
      // only this test's runs: other test files commit runs while this one runs (never count DB-wide)
      const ownRuns = () => tx.select({ id: runs.id }).from(runs).where(inArray(runs.scopeId, [first, second]));
      const runsBefore = await ownRuns();

      await uploadPdfAction(form({ sourceId: second, file: new File([pdf(text)], "copy.pdf", { type: "application/pdf" }) }));
      expect(redirect).toHaveBeenLastCalledWith(`/sources/${second}?archived=${doc!.id}`);
      expect(await ownRuns()).toEqual(runsBefore);
      expect(await tx.select().from(documents).where(eq(documents.sourceId, second))).toEqual([]);
    }));
});

describe("discovery from the tile page", () => {
  it("an unknown tile is rejected; a tile without a subdivision comes back with the German refusal", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      await expect(discoveryForTileAction({ tileId: "q025:0:719" })).rejects.toThrow();
      // Open sea outside the pilot box, at a spot no other test uses; no subdivision.
      const tileId = tileIdFor(26.61, 31.83);
      await tx.insert(tiles).values({ id: tileId, bbox: sql`ST_MakeEnvelope(26.5, 31.75, 26.75, 32.0, 4326)` });
      await discoveryForTileAction(form({ tileId }));
      expect(redirect).toHaveBeenCalledWith(`/tiles/${encodeURIComponent(tileId)}?error=tile_without_subdivision`);
    }));
});

describe("„Neue Texte auswerten“ on a source page (UI-10)", () => {
  it("evaluates only this source's pending versions, in a run scoped to the source", () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const mine = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      await insertTestVersion(tx, ["Rund um Kalonisi."]);
      await pendingSourceTextRunAction(form({ sourceId: mine.sourceId }));
      const target = String(redirect.mock.lastCall![0]);
      expect(target).toMatch(/^\/runs\/[0-9a-f-]{36}$/);
      const [run] = await tx.select().from(runs).where(eq(runs.id, target.slice("/runs/".length)));
      expect(run).toMatchObject({ scopeType: "source", scopeId: mine.sourceId });
      expect(run!.params).toMatchObject({ pending: true, sourceIds: [mine.sourceId], documentVersionIds: [mine.versionId] });
    }));
});
