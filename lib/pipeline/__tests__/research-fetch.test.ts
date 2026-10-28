import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConverters } from "@/lib/adapters/fetch";
import { createGuardedAgent, createGuardedTransport } from "@/lib/adapters/fetch/guarded";
import { makeResponse, type Transport } from "@/lib/adapters/http";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { documents, documentVersions, places, researchFetches, sources } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { ensureResearchSource } from "@/lib/domain/research/sources";
import { registrableDomain } from "@/lib/domain/sources/urls";
import { fetchResearchPage, planResearchFetch } from "@/lib/pipeline/research/fetch";
import { searchCandidate } from "@/lib/pipeline/research/search";
import type { FetchUrlDeps } from "@/lib/pipeline/fetch/page";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { startSiteServer, type SiteServer } from "@/test/site-server";
import { insertNamedObject, insertTestCountry, insertTestRun, insertTestSubdivision, insertTestTile, insertTestVersion } from "@/test/text";

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

function newSite() {
  const id = newId();
  const host = `${id}.invalid`;
  const origin = `http://${host}:${new URL(site.origin).port}`;
  return {
    host,
    url: (p: string) => `${origin}/${id}${p}`,
    set: (p: string, res: Parameters<SiteServer["set"]>[1]) => site.set(`/${id}${p}`, res),
    robots: (body: string) => site.set("/robots.txt", { body }, host),
  };
}

function deps(archive = memoryArchive()): FetchUrlDeps {
  return {
    transport: siteTransport,
    archive,
    converters: createConverters({ transport: noNetwork, cfg: getConfig().fetch }),
    pdf: { pdftotext: async () => "" },
    isAllowed: async () => true,
    enqueue: async () => 0,
  };
}

const HTML_PAGE = {
  body: `<!doctype html><html><head><title>Vathi</title></head><body><article><h1>Vathi</h1>${"<p>Good holding in sand at four metres, well sheltered from the meltemi.</p>".repeat(20)}</article></body></html>`,
  headers: { "content-type": "text/html; charset=utf-8" },
};

const run = async (tx: Db) => ({ db: tx, runId: await insertTestRun(tx) });

describe("fetchResearchPage", () => {
  it("stores an HTML hit under a research source; a second call is unchanged", () =>
    withRollback(async (tx) => {
      const s = newSite();
      s.set("/vathi", HTML_PAGE);
      const archive = memoryArchive();
      const ctx = await run(tx);
      const url = s.url("/vathi");
      const first = await fetchResearchPage(tx, url, deps(archive), ctx);
      expect(first.outcome).toBe("stored");
      expect(first.versionId).toBeTruthy();
      const [doc] = await tx.select().from(documents).where(eq(documents.url, url));
      const [source] = await tx.select().from(sources).where(eq(sources.id, doc!.sourceId));
      expect(source).toMatchObject({ origin: "research", status: "approved", type: "other", domain: registrableDomain(url) });
      const versions = await tx.select().from(documentVersions).where(eq(documentVersions.documentId, doc!.id));
      expect(versions).toHaveLength(1);
      expect(new TextDecoder().decode((await archive.get(versions[0]!.mdKey))!)).toContain("Good holding in sand");

      const second = await fetchResearchPage(tx, url, deps(archive), ctx);
      expect(second.outcome).toBe("unchanged");
      expect(await tx.select().from(documentVersions).where(eq(documentVersions.documentId, doc!.id))).toHaveLength(1);
    }));

  it("fetches a page of a domain whose source is rejected, without a new source", () =>
    withRollback(async (tx) => {
      const s = newSite();
      s.set("/vathi", HTML_PAGE);
      const url = s.url("/vathi");
      const [rejected] = await tx
        .insert(sources)
        .values({ domain: registrableDomain(url), name: "Old", type: "forum", weight: 0.3, status: "rejected", crawlRules: { startUrls: [] }, origin: "manual" })
        .returning({ id: sources.id });
      const result = await fetchResearchPage(tx, url, deps(), await run(tx));
      expect(result.outcome).toBe("stored");
      const [doc] = await tx.select().from(documents).where(eq(documents.url, url));
      expect(doc!.sourceId).toBe(rejected!.id);
      expect(await tx.select().from(sources).where(eq(sources.domain, registrableDomain(url)))).toHaveLength(1);
    }));

  it("skips a PDF over fetch.maxRawBytes without an error", () =>
    withRollback(async (tx) => {
      const s = newSite();
      s.set("/guide.pdf", { body: new Uint8Array(getConfig().fetch.maxRawBytes + 1024), headers: { "content-type": "application/pdf" } });
      const url = s.url("/guide.pdf");
      const result = await fetchResearchPage(tx, url, deps(), await run(tx));
      expect(result).toEqual({ outcome: "skipped", versionId: null, reason: "too_large" });
      expect(await tx.select().from(documents).where(eq(documents.url, url))).toHaveLength(0);
    }));

  it("converts a PDF although the existing source has pdf: false", () =>
    withRollback(async (tx) => {
      const s = newSite();
      const pdf = new Uint8Array(readFileSync("test/fixtures/pdf/two-pages.pdf"));
      const layout = readFileSync("test/fixtures/pdf/layout-sample.txt", "utf8");
      s.set("/guide.pdf", { body: pdf, headers: { "content-type": "application/pdf" } });
      const url = s.url("/guide.pdf");
      await tx
        .insert(sources)
        .values({ domain: registrableDomain(url), name: "Old", type: "forum", weight: 0.3, status: "approved", crawlRules: { startUrls: [], pdf: false }, origin: "manual" });
      const result = await fetchResearchPage(tx, url, { ...deps(), pdf: { pdftotext: async () => layout } }, await run(tx));
      expect(result.outcome).toBe("stored");
    }));

  it("a 404 without a document fails and creates none; a 404 of a known document goes through markGone", () =>
    withRollback(async (tx) => {
      const s = newSite();
      const url = s.url("/missing");
      const ctx = await run(tx);
      expect(await fetchResearchPage(tx, url, deps(), ctx)).toEqual({ outcome: "failed", versionId: null, reason: "HTTP 404" });
      expect(await tx.select().from(documents).where(eq(documents.url, url))).toHaveLength(0);

      s.set("/vathi", HTML_PAGE);
      const known = s.url("/vathi");
      await fetchResearchPage(tx, known, deps(), ctx);
      s.set("/vathi", null);
      const first = await fetchResearchPage(tx, known, deps(), ctx);
      expect(first.outcome).toBe("failed");
      const second = await fetchResearchPage(tx, known, deps(), ctx);
      expect(second).toMatchObject({ outcome: "gone", reason: "HTTP 404" });
      const [doc] = await tx.select().from(documents).where(eq(documents.url, known));
      expect(doc).toMatchObject({ status: "gone", consecutiveGone: 2 });
      // already gone: no second transition
      expect(await fetchResearchPage(tx, known, deps(), ctx)).toEqual({ outcome: "failed", versionId: null, reason: "HTTP 404" });
    }));

  it("a robots.txt refusal is skipped with reason robots", () =>
    withRollback(async (tx) => {
      const s = newSite();
      s.robots("User-agent: *\nDisallow: /");
      s.set("/vathi", HTML_PAGE);
      const result = await fetchResearchPage(tx, s.url("/vathi"), deps(), await run(tx));
      expect(result).toEqual({ outcome: "skipped", versionId: null, reason: "robots" });
    }));

  it("skips a forbidden domain without a source, a document or a request", () =>
    withRollback(async (tx) => {
      const url = "https://www.navily.com/anchorage/vathi";
      const result = await fetchResearchPage(tx, url, { ...deps(), transport: noNetwork }, await run(tx));
      expect(result).toEqual({ outcome: "skipped", versionId: null, reason: "forbidden_domain" });
      expect(await tx.select().from(sources).where(eq(sources.domain, "navily.com"))).toHaveLength(0);
      expect(await tx.select().from(documents).where(eq(documents.url, url))).toHaveLength(0);
    }));

  it("records the outcome of every fetch in research_fetches, one row per attempt", () =>
    withRollback(async (tx) => {
      const s = newSite();
      s.set("/vathi", HTML_PAGE);
      const url = s.url("/vathi");
      const ctx = await run(tx);
      expect((await fetchResearchPage(tx, url, deps(), ctx)).outcome).toBe("stored");
      expect((await fetchResearchPage(tx, url, deps(), ctx)).outcome).toBe("unchanged");
      const forbidden = "https://www.navily.com/x";
      await fetchResearchPage(tx, forbidden, { ...deps(), transport: noNetwork }, ctx);
      const rows = await tx.select().from(researchFetches).where(eq(researchFetches.runId, ctx.runId)).orderBy(researchFetches.createdAt, researchFetches.id);
      expect(rows.map((r) => [r.urlNormalized === url ? "page" : "navily", r.outcome, r.reason])).toEqual([
        ["page", "stored", null],
        ["page", "unchanged", null],
        ["navily", "skipped", "forbidden_domain"],
      ]);
    }));
});

describe("ensureResearchSource", () => {
  it("creates one approved research source per domain; a repeated or concurrent call returns it", () =>
    withRollback(async (tx) => {
      const domain = `${newId()}.research-test.invalid`;
      const [a, b] = await Promise.all([ensureResearchSource(tx, domain), ensureResearchSource(tx, domain)]);
      expect(a.id).toBe(b.id);
      expect(a).toMatchObject({ status: "approved", origin: "research", type: "other", weight: 0.5 });
      expect(a.crawlRules).toMatchObject({ maxDepth: 0, maxPages: 1, ratePerMinute: 20, pdf: true });
      expect(await tx.select().from(sources).where(eq(sources.domain, domain))).toHaveLength(1);
    }));
});

describe("planResearchFetch", () => {
  const answer = (urls: string[]) =>
    new TextEncoder().encode(
      JSON.stringify({
        status_code: 20000,
        status_message: "Ok.",
        tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.002, result: [{ items: urls.map((url, i) => ({ type: "organic", rank_group: i + 1, rank_absolute: i + 1, url, title: `T${i}`, description: `S${i}` })) }] }],
      }),
    );

  async function seedTwo(tx: Db, urls: string[]) {
    const sub = await insertTestSubdivision(tx, "GR-XR1", [21.0, 35.0, 21.5, 35.5], { country: "GR" });
    await insertTestCountry(tx);
    await insertTestTile(tx, "q025:84:140", null, sub.id);
    const ids: string[] = [];
    for (const [i, name] of ["Vathi", "Kalo"].entries()) {
      const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name, language: "en" }], lon: 21.1 + i / 100, lat: 35.2, subdivisionId: sub.id });
      const [place] = await tx
        .insert(places)
        .values({ geoObjectId: objectId, kind: "anchorage", status: "candidate", position: geomFromGeoJson({ type: "Point", coordinates: [21.1 + i / 100, 35.2] }) })
        .returning({ id: places.id });
      ids.push(place!.id);
    }
    const runId = await insertTestRun(tx);
    const transport: Transport = async () => makeResponse(200, answer(urls));
    for (const id of ids) await searchCandidate(tx, id, { transport, archive: memoryArchive() }, { db: tx, runId });
    return { ids, runId };
  }

  it("two candidates with the same URL give one job", () =>
    withRollback(async (tx) => {
      const { ids, runId } = await seedTwo(tx, ["https://sailblog.example/vathi"]);
      const jobs = await planResearchFetch(tx, { id: runId, params: { placeIds: ids } });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ url: "https://sailblog.example/vathi" });
      expect(jobs[0]!.key).toMatch(/^[0-9a-f]{32}$/);
    }));

  it("a URL with a version younger than refetchDays gets no job; an older one does", () =>
    withRollback(async (tx) => {
      const { ids, runId } = await seedTwo(tx, ["https://fresh.example/a", "https://stale.example/b"]);
      const days = getConfig().research.refetchDays;
      for (const [url, ageDays] of [["https://fresh.example/a", 1], ["https://stale.example/b", days + 1]] as const) {
        const sourceId = await ensureResearchSource(tx, registrableDomain(url)).then((s) => s.id);
        const [doc] = await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "other" }).returning({ id: documents.id });
        await insertTestVersion(tx, ["text"], { sourceId, documentId: doc!.id, fetchedAt: new Date(Date.now() - ageDays * 86_400_000) });
      }
      const jobs = await planResearchFetch(tx, { id: runId, params: { placeIds: ids } });
      expect(jobs.map((j) => j.url)).toEqual(["https://stale.example/b"]);
    }));
});
