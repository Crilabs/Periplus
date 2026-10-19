import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConverters } from "@/lib/adapters/fetch";
import { createGuardedAgent, createGuardedTransport } from "@/lib/adapters/fetch/guarded";
import { RetryableHttpError, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { chunks, crawlFrontier, documents, documentVersions, outlinks, runs, sources } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun, getRun } from "@/lib/domain/runs";
import { registrableDomain } from "@/lib/domain/sources/urls";
import type { JobData } from "@/lib/jobs/worker";
import type { PgBoss } from "pg-boss";
import { crawlRenderPage } from "@/lib/jobs/handlers/fetch";
import { FETCH_RUN_STAGES, startExclusiveFetchRun, startFetchRun, startTestCrawl, startUploadFetchRun } from "@/lib/pipeline/fetch/run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { FETCH_SOURCE_STAGE, prepareSourceCrawl } from "@/lib/pipeline/fetch/source";
import { FETCH_URL_STAGE, fetchUrl, followLinks, planFetchUrls, type FetchUrlDeps } from "@/lib/pipeline/fetch/url";
import { getSource } from "@/lib/domain/sources/store";
import { testDb, withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { startSiteServer, type SiteServer } from "@/test/site-server";

// The site listens on 127.0.0.1; its pages are addressed as http://<uuid>.invalid:<port>, resolved to the site by a
// guarded agent that allows the loopback address. Every test has its own host, so robots, rate buckets and sources
// never meet another test's.
let site: SiteServer;
const agent = createGuardedAgent({ resolveAll: async () => [{ address: "127.0.0.1", family: 4 }], isAllowedAddress: () => true });
const siteTransport = createGuardedTransport(agent);
beforeAll(async () => {
  site = await startSiteServer();
});
afterAll(async () => {
  await site.close();
  await agent.close();
});

const noNetwork: Transport = async (req) => {
  throw new Error(`unexpected request ${req.url}`);
};
const cfg = () => getConfig().fetch;

function paragraph(topic: string, n = 20): string {
  return Array.from({ length: n }, (_, i) => `The ${topic} bay has good holding in sand at four to six metres, note ${i}.`).join(" ");
}

function html(title: string, body: string, links: string[] = []): string {
  const anchors = links.map((href, i) => `<a href="${href}">link ${i}</a>`).join(" ");
  return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${body}<p>${anchors}</p></article></body></html>`;
}

const page = (body: string, etag?: string) => ({
  body,
  headers: { "content-type": "text/html; charset=utf-8", ...(etag ? { etag } : {}) },
});

type Site = {
  origin: string;
  host: string;
  path: (p: string) => string;
  set: (p: string, res: Parameters<SiteServer["set"]>[1]) => void;
  /** Sets (or with `null` removes) the robots.txt of `host`, by default the site's own host. */
  robots: (body: string | null, host?: string) => void;
  /** Origin of a subdomain of the site's host (same registrable domain). */
  sub: (label: string) => string;
};

/**
 * A fresh host on the shared site server: paths are prefixed with `/<id>` so hosts never share pages; robots.txt
 * is set per host, so no test sees another test's robots.txt.
 */
function newSite(): Site {
  const id = newId();
  const port = new URL(site.origin).port;
  const host = `${id}.invalid`;
  return {
    origin: `http://${host}:${port}`,
    host,
    path: (p) => `/${id}${p}`,
    set: (p, res) => site.set(`/${id}${p}`, res),
    robots: (body, h = host) => site.set("/robots.txt", body === null ? null : { body }, h),
    sub: (label) => `http://${label}.${host}:${port}`,
  };
}

async function insertSource(tx: Db, s: Site, rules: Record<string, unknown>, status: "approved" | "paused" | "rejected" = "approved") {
  const [row] = await tx
    .insert(sources)
    .values({
      domain: registrableDomain(s.origin),
      name: "Fetch test",
      type: "pilot_guide",
      weight: 0.9,
      status,
      crawlRules: { render: "never", ...rules },
      origin: "manual",
    })
    .returning({ id: sources.id });
  return row!.id;
}

function deps(archive = memoryArchive(), over: Partial<FetchUrlDeps> = {}): Omit<FetchUrlDeps, "enqueue"> {
  return {
    transport: siteTransport,
    archive,
    converters: createConverters({ transport: noNetwork, cfg: cfg() }),
    pdf: { pdftotext: async () => "" },
    isAllowed: async () => true,
    ...over,
  };
}

function newRun(tx: Db, sourceId: string) {
  return createRun(tx, { kind: "stage", scope: { type: "source", id: sourceId }, stages: FETCH_RUN_STAGES, triggeredBy: "test" });
}

type Outcome = Awaited<ReturnType<typeof fetchUrl>> & { url: string };

/** One crawl run of the source with the stage functions called directly: the loop runs every job `enqueue` collects. */
async function crawl(tx: Db, sourceId: string, d: Omit<FetchUrlDeps, "enqueue">, params: Record<string, unknown> = {}) {
  const { id: runId } = await createRun(tx, {
    kind: "stage",
    scope: { type: "source", id: sourceId },
    stages: FETCH_RUN_STAGES,
    params: { sourceIds: [sourceId], ...params },
    triggeredBy: "test",
  });
  await beginStage(tx, runId, FETCH_SOURCE_STAGE, 1);
  const prepared = await prepareSourceCrawl(tx, sourceId, d, { db: tx, runId, stage: FETCH_SOURCE_STAGE });
  const run = { id: runId, params: { sourceIds: [sourceId], ...params } };
  const queue: JobData[] = await planFetchUrls(tx, run);
  await beginStage(tx, runId, FETCH_URL_STAGE, queue.length);
  const results: Outcome[] = [];
  const keys = new Set(queue.map((j) => j.key));
  while (queue.length > 0) {
    const job = queue.shift()!;
    const enqueue = async (_tx: Db, jobs: JobData[]) => {
      const fresh = jobs.filter((j) => !keys.has(j.key));
      for (const j of fresh) keys.add(j.key);
      queue.push(...fresh);
      return fresh.length;
    };
    const r = await fetchUrl(tx, job as never, { ...d, enqueue }, { db: tx, runId, stage: FETCH_URL_STAGE });
    results.push({ ...r, url: String(job.url) });
  }
  return { runId, prepared, planned: keys.size, results };
}

async function documentsOf(tx: Db, sourceId: string) {
  return tx.select().from(documents).where(eq(documents.sourceId, sourceId)).orderBy(asc(documents.urlNormalized));
}

async function frontierOf(tx: Db, sourceId: string) {
  return tx.select().from(crawlFrontier).where(eq(crawlFrontier.sourceId, sourceId)).orderBy(asc(crawlFrontier.urlNormalized));
}

async function versionsOf(tx: Db, documentId: string) {
  return tx.select().from(documentVersions).where(eq(documentVersions.documentId, documentId)).orderBy(asc(documentVersions.fetchedAt));
}

function outcomeOf(results: Outcome[], url: string) {
  return results.find((r) => r.url === url)?.outcome;
}

describe("crawl stages", () => {
  it("run 1 archives every allowed page once", async () => {
    const s = newSite();
    s.robots("User-agent: *\nAllow: /\n");
    s.set("/a", page(html("A", `<p>${paragraph("north")}</p>`, [s.path("/b"), `${s.path("/c")}?utm_source=x#f`, s.path("/tag/x"), "https://other.example/x"]), '"a1"'));
    s.set("/b", page(html("B", `<p>${paragraph("east")}</p>`, [s.path("/a")]), '"b1"'));
    s.set("/c", page(html("C", `<p>${paragraph("south")}</p>`)));
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`], deny: ["/tag/"] });
      const { runId, prepared, results } = await crawl(tx, sourceId, deps());
      expect(prepared).toMatchObject({ status: "ready", startUrls: 1 });
      expect(results.map((r) => r.outcome)).toEqual(["new_version", "new_version", "new_version"]);
      expect(results[0]!.newUrls).toBe(2);

      const docs = await documentsOf(tx, sourceId);
      expect(docs.map((d) => d.urlNormalized)).toEqual([`${s.origin}${s.path("/a")}`, `${s.origin}${s.path("/b")}`, `${s.origin}${s.path("/c")}`]);
      const frontier = await frontierOf(tx, sourceId);
      expect(frontier.map((f) => f.urlNormalized)).not.toContain(`${s.origin}${s.path("/tag/x")}`);
      expect(frontier.every((f) => f.status === "fetched" && f.lastRunId === runId)).toBe(true);
      expect(frontier.map((f) => f.depth)).toEqual([0, 1, 1]);
      for (const doc of docs) {
        const versions = await versionsOf(tx, doc.id);
        expect(versions, doc.url).toHaveLength(1);
        expect(versions[0]!.runId).toBe(runId);
        expect(versions[0]!.docType).toBe("pilot_guide");
        expect(versions[0]!.converter).toBe("local");
        expect((await tx.select().from(chunks).where(eq(chunks.documentVersionId, versions[0]!.id))).length).toBeGreaterThan(0);
      }
      expect(docs[0]!.etag).toBe('"a1"');
      const links = await tx.select().from(outlinks).where(and(eq(outlinks.fromSourceId, sourceId), eq(outlinks.runId, runId)));
      expect(links).toEqual([{ fromSourceId: sourceId, toDomain: "other.example", count: 1, runId }]);
    });
  });

  it("run 2: same page 304, changed page new version with carried chunks, 404 once keeps the page active; run 3: the second 404 makes the page gone", async () => {
    const s = newSite();
    const bBody = (changed: boolean) =>
      `<h2>North</h2><p>${paragraph("north", 30)}</p><h2>East</h2><p>${paragraph(changed ? "rebuilt east" : "east", 30)}</p>`;
    s.set("/a", page(html("A", `<p>${paragraph("west")}</p>`, [s.path("/b"), s.path("/c")]), '"a1"'));
    s.set("/b", page(html("B", bBody(false)), '"b1"'));
    s.set("/c", page(html("C", `<p>${paragraph("south")}</p>`), '"c1"'));
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`] });
      const d = deps();
      await crawl(tx, sourceId, d);

      s.set("/b", page(html("B", bBody(true)), '"b2"'));
      s.set("/c", null);
      const run2 = await crawl(tx, sourceId, d);
      const url = (p: string) => `${s.origin}${s.path(p)}`;
      expect(outcomeOf(run2.results, url("/a"))).toBe("not_modified");
      expect(outcomeOf(run2.results, url("/b"))).toBe("new_version");
      expect(outcomeOf(run2.results, url("/c"))).toBe("missing");
      const [a, b, c] = await documentsOf(tx, sourceId);
      expect(a!.lastCheckedAt).not.toBeNull();
      const [, bNew] = await versionsOf(tx, b!.id);
      expect(bNew!.diffKey).not.toBeNull();
      const bChunks = await tx.select().from(chunks).where(eq(chunks.documentVersionId, bNew!.id));
      expect(bChunks.some((ch) => ch.carriedFromChunkId !== null)).toBe(true);
      expect(c).toMatchObject({ status: "active", consecutiveGone: 1 });

      const run3 = await crawl(tx, sourceId, d);
      expect(outcomeOf(run3.results, url("/c"))).toBe("gone");
      const [, , cGone] = await documentsOf(tx, sourceId);
      expect(cGone).toMatchObject({ status: "gone", consecutiveGone: 2 });
    });
  });

  it("robots disallow-all pauses the source and plans no urls", async () => {
    const s = newSite();
    s.robots("User-agent: *\nDisallow: /\n");
    s.set("/a", page(html("A", "<p>x</p>")));
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`] });
      const { prepared, planned, results } = await crawl(tx, sourceId, deps());
      expect(prepared).toMatchObject({ status: "paused", startUrls: 0 });
      expect(prepared.robots).toMatchObject({ disallowAll: true });
      expect(planned).toBe(0);
      expect(results).toEqual([]);
      const [source] = await tx.select().from(sources).where(eq(sources.id, sourceId));
      expect(source).toMatchObject({ status: "paused", statusReason: "robots.txt verbietet das Crawlen" });
    });
  });

  it("the frontier stops at maxPages", async () => {
    const s = newSite();
    const links = ["/p1", "/p2", "/p3", "/p4", "/p5"].map((p) => s.path(p));
    s.set("/a", page(html("A", `<p>${paragraph("west")}</p>`, links)));
    for (const p of ["/p1", "/p2", "/p3", "/p4", "/p5"]) s.set(p, page(html(p, `<p>${paragraph(p)}</p>`)));
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`], maxPages: 2 });
      const { results } = await crawl(tx, sourceId, deps());
      expect(await frontierOf(tx, sourceId)).toHaveLength(2);
      expect(results).toHaveLength(2);
      expect(results[0]!.newUrls).toBe(1);
    });
  });

  it("a test crawl caps the run at its maxPages", async () => {
    const s = newSite();
    const links = ["/p1", "/p2", "/p3"].map((p) => s.path(p));
    s.set("/a", page(html("A", `<p>${paragraph("west")}</p>`, links)));
    for (const p of ["/p1", "/p2", "/p3"]) s.set(p, page(html(p, `<p>${paragraph(p)}</p>`)));
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`] });
      const { results } = await crawl(tx, sourceId, deps(), { maxPages: 2 });
      expect(results).toHaveLength(2);
    });
  });

  it("maxDepth 0 follows no links", async () => {
    const s = newSite();
    s.set("/a", page(html("A", `<p>${paragraph("west")}</p>`, [s.path("/b")])));
    s.set("/b", page(html("B", `<p>${paragraph("east")}</p>`)));
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`], maxDepth: 0 });
      const { results } = await crawl(tx, sourceId, deps());
      expect(results).toEqual([expect.objectContaining({ outcome: "new_version", newUrls: 0 })]);
      expect(await frontierOf(tx, sourceId)).toHaveLength(1);
    });
  });

  it("a 403 marks the frontier row failed without throwing", async () => {
    const s = newSite();
    s.set("/a", { status: 403, body: "forbidden" });
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`] });
      const { results } = await crawl(tx, sourceId, deps());
      expect(results).toEqual([expect.objectContaining({ outcome: "failed", newUrls: 0 })]);
      const [row] = await frontierOf(tx, sourceId);
      expect(row).toMatchObject({ status: "failed", reason: "HTTP 403" });
      expect(await documentsOf(tx, sourceId)).toEqual([]);
    });
  });

  it("a 503 throws a retryable error", async () => {
    const s = newSite();
    s.set("/a", { status: 503, body: "busy" });
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`] });
      await expect(crawl(tx, sourceId, deps())).rejects.toBeInstanceOf(RetryableHttpError);
    });
  });

  it("effective rate honours crawl-delay", async () => {
    const s = newSite();
    s.robots("User-agent: *\nCrawl-delay: 30\n");
    s.set("/a", page(html("A", `<p>${paragraph("west")}</p>`)));
    const seen: HttpRequest[] = [];
    const recording: Transport = async (req) => {
      seen.push(req);
      return siteTransport(req);
    };
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`] });
      await crawl(tx, sourceId, deps(memoryArchive(), { transport: recording }));
    });
    const pageRequest = seen.find((r) => r.url.endsWith("/a"));
    expect(pageRequest).toMatchObject({ ratePerMinute: 2, rateKey: `domain:${new URL(s.origin).hostname}`, redirect: "manual" });
  });

  it("a redirect to another registrable domain is skipped before it is requested", async () => {
    const s = newSite();
    s.set("/a", { status: 301, body: "", headers: { location: "https://elsewhere.example/a" } });
    const seen: string[] = [];
    const recording: Transport = async (req) => {
      seen.push(req.url);
      return siteTransport(req);
    };
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`] });
      const { results } = await crawl(tx, sourceId, deps(memoryArchive(), { transport: recording }));
      expect(results).toEqual([expect.objectContaining({ outcome: "skipped" })]);
      expect((await frontierOf(tx, sourceId))[0]).toMatchObject({ status: "skipped", reason: "redirect_offsite" });
    });
    expect(seen.some((u) => u.includes("elsewhere.example"))).toBe(false);
  });

  it("every redirect hop passes the address check", async () => {
    const s = newSite();
    s.set("/a", { status: 302, body: "", headers: { location: s.path("/secret") } });
    s.set("/secret", page(html("S", "<p>intern</p>")));
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`] });
      const isAllowed = async (url: string) => !url.includes("/secret");
      const { results } = await crawl(tx, sourceId, deps(memoryArchive(), { isAllowed }));
      expect(results).toEqual([expect.objectContaining({ outcome: "skipped" })]);
      // A blocked address may be a passing DNS answer: the row stays queued for the next run (ruling M3-C-R5).
      expect((await frontierOf(tx, sourceId))[0]).toMatchObject({ status: "queued", reason: "blocked_address" });
    });
  });

  it("an uploaded pdf is read from the archive", async () => {
    const archive = memoryArchive();
    const pdf = new Uint8Array(readFileSync("test/fixtures/pdf/two-pages.pdf"));
    const sha = createHash("sha256").update(pdf).digest("hex");
    await archive.put(`uploads/${sha}.pdf`, pdf, "application/pdf");
    const layout = readFileSync("test/fixtures/pdf/layout-sample.txt", "utf8");
    await withRollback(async (tx) => {
      const s = newSite();
      const sourceId = await insertSource(tx, s, {}, "paused");
      const [doc] = await tx
        .insert(documents)
        .values({ sourceId, url: `upload://${sha}`, urlNormalized: `upload://${sha}`, docType: "pilot_guide" })
        .returning({ id: documents.id });
      const { id: runId } = await createRun(tx, {
        kind: "stage",
        scope: { type: "source", id: sourceId },
        stages: [FETCH_URL_STAGE],
        params: { documentIds: [doc!.id] },
        triggeredBy: "test",
      });
      const planned = await planFetchUrls(tx, { id: runId, params: { documentIds: [doc!.id] } });
      expect(planned).toEqual([expect.objectContaining({ sourceId, url: `upload://${sha}`, depth: 0, documentId: doc!.id })]);
      await beginStage(tx, runId, FETCH_URL_STAGE, 1);
      const r = await fetchUrl(
        tx,
        planned[0] as never,
        { ...deps(archive, { transport: noNetwork, pdf: { pdftotext: async () => layout } }), enqueue: async () => 0 },
        { db: tx, runId, stage: FETCH_URL_STAGE },
      );
      expect(r).toEqual({ outcome: "new_version", newUrls: 0 });
      const [version] = await versionsOf(tx, doc!.id);
      expect(version).toMatchObject({ converter: "pdftotext", contentType: "application/pdf", runId });
      expect(version!.rawKey).toMatch(/\.raw\.pdf$/);
      expect((await getRun(tx, runId))!.stages[0]!.total).toBe(1);
    });
  });

  it("a source paused mid-crawl is skipped without a request and its row stays queued for a later run", async () => {
    const s = newSite();
    const seen: string[] = [];
    const recording: Transport = async (req) => {
      seen.push(req.url);
      return siteTransport(req);
    };
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, {}, "paused");
      const url = `${s.origin}${s.path("/a")}`;
      await tx.insert(crawlFrontier).values({ sourceId, url, urlNormalized: url });
      const { id: runId } = await createRun(tx, { kind: "stage", scope: { type: "source", id: sourceId }, stages: [FETCH_URL_STAGE], triggeredBy: "test" });
      const r = await fetchUrl(tx, { sourceId, url, depth: 0 }, { ...deps(memoryArchive(), { transport: recording }), enqueue: async () => 0 }, { db: tx, runId });
      expect(r).toEqual({ outcome: "skipped", newUrls: 0 });
      expect((await frontierOf(tx, sourceId))[0]).toMatchObject({ status: "queued", reason: "source_paused" });
      await tx.update(sources).set({ status: "approved" }).where(eq(sources.id, sourceId));
      const planned = await planFetchUrls(tx, { id: runId, params: { sourceIds: [sourceId] } });
      expect(planned.map((j) => j.url)).toEqual([url]);
    });
    expect(seen).toEqual([]);
  });

  it("a page answering 304 still adds its links: a test crawl's frontier grows in the next full run", async () => {
    const s = newSite();
    const url = (p: string) => `${s.origin}${s.path(p)}`;
    s.set("/a", page(html("A", `<p>${paragraph("west")}</p>`, [s.path("/p1"), s.path("/p2"), "https://other.example/x"]), '"a1"'));
    for (const p of ["/p1", "/p2"]) s.set(p, page(html(p, `<p>${paragraph(p)}</p>`)));
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [url("/a")] });
      const d = deps();
      const test = await crawl(tx, sourceId, d, { maxPages: 1 });
      expect(test.results.map((r) => r.url)).toEqual([url("/a")]);
      expect(await frontierOf(tx, sourceId)).toHaveLength(1);

      const full = await crawl(tx, sourceId, d);
      expect(full.results[0]).toMatchObject({ url: url("/a"), outcome: "not_modified", newUrls: 2 });
      expect(outcomeOf(full.results, url("/p1"))).toBe("new_version");
      expect(outcomeOf(full.results, url("/p2"))).toBe("new_version");
      expect((await frontierOf(tx, sourceId)).map((f) => [f.urlNormalized, f.status])).toEqual([
        [url("/a"), "fetched"],
        [url("/p1"), "fetched"],
        [url("/p2"), "fetched"],
      ]);
      // The unchanged page's outlinks count in this run too.
      const links = await tx.select().from(outlinks).where(and(eq(outlinks.fromSourceId, sourceId), eq(outlinks.runId, full.runId)));
      expect(links).toEqual([{ fromSourceId: sourceId, toDomain: "other.example", count: 1, runId: full.runId }]);
    });
  });

  it("a page robots.txt disallows stays queued and is fetched once robots.txt allows it", async () => {
    const s = newSite();
    const url = (p: string) => `${s.origin}${s.path(p)}`;
    s.robots(`User-agent: *\nDisallow: ${s.path("/private")}\n`);
    s.set("/a", page(html("A", `<p>${paragraph("west")}</p>`, [s.path("/private")])));
    s.set("/private", page(html("P", `<p>${paragraph("private")}</p>`)));
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [url("/a")] });
      const d = deps();
      const run1 = await crawl(tx, sourceId, d);
      expect(outcomeOf(run1.results, url("/private"))).toBe("disallowed");
      expect((await frontierOf(tx, sourceId))[1]).toMatchObject({ urlNormalized: url("/private"), status: "queued", reason: "robots" });

      s.robots(null);
      const run2 = await crawl(tx, sourceId, d);
      expect(outcomeOf(run2.results, url("/private"))).toBe("new_version");
    });
  });

  it("a retried job counts the page's outlinks and a 404 once per run", async () => {
    const s = newSite();
    const url = (p: string) => `${s.origin}${s.path(p)}`;
    s.set("/a", page(html("A", `<p>${paragraph("west")}</p>`, [s.path("/c"), "https://other.example/x", "https://third.example/y"])));
    s.set("/c", page(html("C", `<p>${paragraph("south")}</p>`)));
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [url("/a")] });
      const d = deps();
      const retry = (runId: string, p: string, depth: number) =>
        fetchUrl(tx, { sourceId, url: url(p), depth }, { ...d, enqueue: async () => 0 }, { db: tx, runId, stage: FETCH_URL_STAGE });

      const run1 = await crawl(tx, sourceId, d);
      await retry(run1.runId, "/a", 0);
      const links = await tx.select().from(outlinks).where(and(eq(outlinks.fromSourceId, sourceId), eq(outlinks.runId, run1.runId)));
      expect(links.map((l) => [l.toDomain, l.count])).toEqual([
        ["other.example", 1],
        ["third.example", 1],
      ]);

      s.set("/c", null);
      const run2 = await crawl(tx, sourceId, d);
      expect(outcomeOf(run2.results, url("/c"))).toBe("missing");
      expect(await retry(run2.runId, "/c", 1)).toEqual({ outcome: "missing", newUrls: 0 });
      const [, c] = await documentsOf(tx, sourceId);
      expect(c).toMatchObject({ status: "active", consecutiveGone: 1 });
    });
  });

  it("an explicit robots ban on one of two start hosts skips only that host", async () => {
    const s = newSite();
    const banned = `${s.sub("closed")}${s.path("/a")}`;
    const open = `${s.sub("open")}${s.path("/a")}`;
    s.robots("User-agent: *\nDisallow: /\n", `closed.${s.host}`);
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [banned, open] });
      const prepared = await prepareSourceCrawl(tx, sourceId, deps(), { db: tx, runId: (await newRun(tx, sourceId)).id, stage: FETCH_SOURCE_STAGE });
      expect(prepared).toMatchObject({ status: "ready", startUrls: 1 });
      expect((await frontierOf(tx, sourceId)).map((f) => f.urlNormalized)).toEqual([open]);
      expect((await getSource(tx, sourceId))!.status).toBe("approved");
    });
  });

  it("a robots ban does not overwrite a status the admin set while robots.txt was read", async () => {
    const s = newSite();
    s.robots("User-agent: *\nDisallow: /\n");
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`] });
      const adminRejectsMeanwhile: Transport = async (req) => {
        await tx.update(sources).set({ status: "rejected", statusReason: "Admin" }).where(eq(sources.id, sourceId));
        return siteTransport(req);
      };
      const { id: runId } = await newRun(tx, sourceId);
      const prepared = await prepareSourceCrawl(tx, sourceId, deps(memoryArchive(), { transport: adminRejectsMeanwhile }), {
        db: tx,
        runId,
        stage: FETCH_SOURCE_STAGE,
      });
      expect(prepared.status).toBe("not_approved");
      expect(await getSource(tx, sourceId)).toMatchObject({ status: "rejected", statusReason: "Admin" });
    });
  });

  it("a redirect hop to a blocked address is refused before its host's robots.txt is requested", async () => {
    const s = newSite();
    const target = `${s.sub("intern")}${s.path("/x")}`;
    s.set("/a", { status: 302, body: "", headers: { location: target } });
    const seen: string[] = [];
    const recording: Transport = async (req) => {
      seen.push(req.url);
      return siteTransport(req);
    };
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, s, { startUrls: [`${s.origin}${s.path("/a")}`] });
      const isAllowed = async (u: string) => new URL(u).hostname !== `intern.${s.host}`;
      const { results } = await crawl(tx, sourceId, deps(memoryArchive(), { transport: recording, isAllowed }));
      expect(results).toEqual([expect.objectContaining({ outcome: "skipped" })]);
    });
    expect(seen.some((u) => u.includes(`intern.${s.host}`))).toBe(false);
  });
});

describe("crawl run starters", () => {
  function recordingBoss() {
    const inserted: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const boss = {
      insert: async (queue: string, jobs: Array<{ id: string; data: Record<string, unknown> }>) => {
        inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
        return jobs.map((j) => j.id);
      },
    } as unknown as PgBoss;
    return { boss, inserted };
  }

  it("a fetch run starts with fetch.source per source; a test crawl caps at 10 pages", async () => {
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, newSite(), {});
      const { boss, inserted } = recordingBoss();
      const { id } = await startTestCrawl(tx, boss, sourceId, "admin");
      const run = (await getRun(tx, id))!;
      expect(run.scope).toEqual({ type: "source", id: sourceId });
      expect(run.stages.map((st) => st.stage)).toEqual(["fetch.source", "fetch.url", "embed.chunks"]);
      expect(inserted).toEqual([{ queue: "fetch.source", data: expect.objectContaining({ key: sourceId, sourceId, runId: id }) }]);
      const [row] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(row!.params).toEqual({ sourceIds: [sourceId], maxPages: 10 });
    });
  });

  it("\"approved\" resolves to the approved sources at start", async () => {
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, newSite(), {});
      const { boss } = recordingBoss();
      const { id } = await startFetchRun(tx, boss, { sourceIds: "approved", triggeredBy: "admin" });
      expect((await getRun(tx, id))!.scope).toEqual({ type: "source", id: "approved" });
      const [row] = await tx.select().from(runs).where(eq(runs.id, id));
      expect((row!.params as { sourceIds: string[] }).sourceIds).toContain(sourceId);
    });
  });

  it("refuses sources that are not approved and documents that are no upload, before a run exists", async () => {
    await withRollback(async (tx) => {
      const paused = await insertSource(tx, newSite(), {}, "paused");
      const { boss, inserted } = recordingBoss();
      await expect(startFetchRun(tx, boss, { sourceIds: [paused], triggeredBy: "admin" })).rejects.toBeInstanceOf(RunScopeNotReady);
      await expect(startTestCrawl(tx, boss, newId(), "admin")).rejects.toMatchObject({ reason: "source_not_approved" });
      await expect(startFetchRun(tx, boss, { sourceIds: [], triggeredBy: "admin" })).rejects.toMatchObject({ reason: "no_approved_sources" });
      const url = `https://${newId()}.invalid/x`;
      const [doc] = await tx.insert(documents).values({ sourceId: paused, url, urlNormalized: url, docType: "forum" }).returning({ id: documents.id });
      await expect(startUploadFetchRun(tx, boss, doc!.id, "admin")).rejects.toMatchObject({ reason: "document_not_upload" });
      expect(inserted).toEqual([]);
    });
  });

  it("refuses a source that a queued or running run is fetching already, until that run ends", async () => {
    await withRollback(async (tx) => {
      const busy = await insertSource(tx, newSite(), {});
      const free = await insertSource(tx, newSite(), {});
      const { boss } = recordingBoss();
      const first = await startFetchRun(tx, boss, { sourceIds: [busy], triggeredBy: "admin" });
      const refused = startFetchRun(tx, boss, { sourceIds: [free, busy], triggeredBy: "admin" });
      await expect(refused).rejects.toBeInstanceOf(RunScopeNotReady);
      await expect(refused).rejects.toMatchObject({ reason: "source_run_active" });
      await expect(startTestCrawl(tx, boss, busy, "admin")).rejects.toMatchObject({ reason: "source_run_active" });
      // Another source is not affected; and once the first run has ended, the source may be fetched again.
      await expect(startTestCrawl(tx, boss, free, "admin")).resolves.toMatchObject({ id: expect.any(String) });
      await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, first.id));
      await expect(startTestCrawl(tx, boss, busy, "admin")).resolves.toMatchObject({ id: expect.any(String) });
    });
  });

  it("\"Alle freigegebenen crawlen\" leaves out busy sources and names them; all busy is refused", async () => {
    await withRollback(async (tx) => {
      const busy = await insertSource(tx, newSite(), {});
      const free = await insertSource(tx, newSite(), {});
      const { boss } = recordingBoss();
      await startFetchRun(tx, boss, { sourceIds: [busy], triggeredBy: "admin" });
      const { id, skipped } = await startFetchRun(tx, boss, { sourceIds: [free, busy], triggeredBy: "admin", skipBusy: true });
      expect(skipped).toEqual([busy]);
      const [row] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(row!.params).toEqual({ sourceIds: [free], skippedSourceIds: [busy] });
      await expect(startFetchRun(tx, boss, { sourceIds: [free, busy], triggeredBy: "admin", skipBusy: true })).rejects.toMatchObject({
        reason: "source_run_active",
      });
    });
  });

  it("two concurrent starts for one source create one run", async () => {
    // Committed rows: two transactions must race. A paused *.test.invalid source never meets other tests' queries;
    // the exclusive start checks only for other runs (approval is checked before it).
    const db = testDb();
    const [row] = await db
      .insert(sources)
      .values({ domain: `${newId()}.test.invalid`, name: "Race", type: "forum", weight: 0.4, status: "paused", crawlRules: {}, origin: "manual" })
      .returning({ id: sources.id });
    const sourceId = row!.id;
    const { boss } = recordingBoss();
    const start = (on: Db) =>
      startExclusiveFetchRun(on, boss, [sourceId], { skipBusy: false }, (ids) => ({
        kind: "stage",
        scope: { type: "source", id: sourceId },
        params: { sourceIds: ids },
        stages: FETCH_RUN_STAGES,
        triggeredBy: "race-test",
      }));
    const created: string[] = [];
    try {
      // The first start's transaction stays open (its run not yet committed) while the second start runs.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let started!: () => void;
      const isStarted = new Promise<void>((resolve) => (started = resolve));
      const first = db.transaction(async (tx) => {
        created.push((await start(tx)).id);
        started();
        await held;
      });
      await isStarted;
      const second = start(db).then((r) => {
        created.push(r.id);
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await first;
      await expect(second).rejects.toMatchObject({ reason: "source_run_active" });
      expect(created).toHaveLength(1);
    } finally {
      // The run never gets a worker: end it so it does not keep the (paused) source busy.
      if (created.length > 0) await db.update(runs).set({ status: "failed", failureReason: "test" }).where(inArray(runs.id, created));
    }
  }, 15_000);

  it("the refusal has a German text for the admin", async () => {
    const { RUN_SCOPE_REASON_LABELS } = await import("@/app/(admin)/_components/labels");
    expect(RUN_SCOPE_REASON_LABELS.source_run_active).toBe("Für die Quelle läuft bereits ein Abruf");
  });

  it("an upload run has only fetch.url with the document", async () => {
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx, newSite(), {}, "paused");
      const url = `upload://${"a".repeat(64)}`;
      const [doc] = await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "pilot_guide" }).returning({ id: documents.id });
      const { boss, inserted } = recordingBoss();
      const { id } = await startUploadFetchRun(tx, boss, doc!.id, "admin");
      expect((await getRun(tx, id))!.stages.map((st) => st.stage)).toEqual(["fetch.url", "embed.chunks"]);
      expect(inserted).toEqual([{ queue: "fetch.url", data: expect.objectContaining({ url, documentId: doc!.id, sourceId }) }]);
    });
  });

  it("PERIPLUS_RENDERER=off builds the converters without a renderer", () => {
    expect(crawlRenderPage({ PERIPLUS_RENDERER: "off" })).toBeUndefined();
    expect(typeof crawlRenderPage({ PERIPLUS_RENDERER: "playwright" })).toBe("function");
  });
});

describe("link following under concurrency", () => {
  // Commits rows (two connections must see them): a paused source on its own `<uuid>.test.invalid` domain (M3-P11).
  it("locks the source row before it writes outlinks, so concurrent jobs of a source cannot deadlock", async () => {
    const db = testDb();
    const domain = `${newId()}.test.invalid`;
    const [row] = await db
      .insert(sources)
      .values({ domain, name: "Lock order", type: "forum", weight: 0.4, status: "paused", crawlRules: { render: "never" }, origin: "manual" })
      .returning({ id: sources.id });
    const sourceId = row!.id;
    const { id: runId } = await newRun(db, sourceId);
    const pageUrl = `https://${domain}/a`;
    await db.insert(crawlFrontier).values({ sourceId, url: pageUrl, urlNormalized: pageUrl, lastRunId: runId });
    // followLinks compares links with the source's registrable domain (`test.invalid` here); its row is only locked.
    const source = { ...(await getSource(db, sourceId))!, status: "approved" as const, domain: registrableDomain(pageUrl) };
    const upsert = (tx: Db) =>
      tx
        .insert(outlinks)
        .values({ fromSourceId: sourceId, toDomain: "d1.example", count: 1, runId })
        .onConflictDoUpdate({ target: [outlinks.fromSourceId, outlinks.toDomain, outlinks.runId], set: { count: sql`${outlinks.count} + 1` } });
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = db.transaction(async (tx) => {
        // Another job of the source inside followLinks.
        await tx.select({ id: sources.id }).from(sources).where(eq(sources.id, sourceId)).for("no key update");
        locked();
        await held;
      });
      await isLocked;
      const following = followLinks(
        db,
        source,
        { urlNormalized: pageUrl, depth: 0, links: [`https://${domain}/b`, "https://d1.example/x"] },
        10,
        { enqueue: async () => 0 },
        runId,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      // A job holding no source lock writes the same outlinks row: it must not wait on the blocked job.
      const competing = await db
        .transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '1s'`);
          await upsert(tx);
          return "written";
        })
        .catch((error: unknown) => error);
      release();
      await holder;
      await following;
      expect(competing).toBe("written");
      const [counted] = await db.select().from(outlinks).where(and(eq(outlinks.fromSourceId, sourceId), eq(outlinks.runId, runId)));
      expect(counted!.count).toBe(2);
    } finally {
      await db.delete(outlinks).where(eq(outlinks.fromSourceId, sourceId));
      await db.delete(crawlFrontier).where(eq(crawlFrontier.sourceId, sourceId));
    }
  }, 15_000);
});
