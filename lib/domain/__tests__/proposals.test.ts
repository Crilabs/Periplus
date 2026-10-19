import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { BlockedAddressError } from "@/lib/adapters/fetch/guarded";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { outlinks, reviewTasks, runs, serpQueries, serpResults, sources, type SourceStatus } from "@/lib/db/schema";
import {
  domainCandidates,
  proposeSources,
  suggestCrawlRules,
  suggestType,
} from "@/lib/domain/discovery/proposals";
import { newId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { getSource, setSourceStatus } from "@/lib/domain/sources/store";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

// Every domain is `<uuid>.test.invalid` and every row lives in a rolled-back transaction; assertions only
// look at the test's own domains (other candidates in the shared test database are ignored).

const proposals = () => getConfig().discovery.proposals;
const testDomain = () => `${newId()}.test.invalid`;

/** robots.txt per origin; every other URL (and unknown origins) answers 404 = everything allowed. */
function robotsTransport(texts: Record<string, string | number> = {}): Transport & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport = (async (req: HttpRequest) => {
    requests.push(req);
    const entry = texts[new URL(req.url).origin];
    if (typeof entry === "number") return makeResponse(entry, new Uint8Array());
    if (entry !== undefined && req.url.endsWith("/robots.txt")) return makeResponse(200, new TextEncoder().encode(entry));
    return makeResponse(404, new Uint8Array());
  }) as Transport & { requests: HttpRequest[] };
  transport.requests = requests;
  return transport;
}

type Hit = { url: string; rank?: number; keyword?: string; languageCode?: string };

/** One SERP query per hit (distinct keywords), each with one result on `domain`. */
async function insertHits(tx: Db, domain: string, hits: Hit[]): Promise<void> {
  for (const [i, hit] of hits.entries()) {
    const [q] = await tx
      .insert(serpQueries)
      .values({
        keyword: hit.keyword ?? `kw ${i} ${domain}`,
        languageCode: hit.languageCode ?? "en",
        locationCode: 2826,
        depth: 20,
        level: "area",
        scopeId: "saronic",
        rawKey: `serp/2026-10-19/${newId()}.json`,
        fetchedAt: new Date(),
      })
      .returning({ id: serpQueries.id });
    await tx.insert(serpResults).values({
      serpQueryId: q!.id,
      rank: hit.rank ?? i + 1,
      url: hit.url,
      urlNormalized: hit.url,
      domain,
      title: `Title ${i}`,
      snippet: `Snippet ${i}`,
    });
  }
}

const pages = (domain: string, n: number, path = "/blog/p") =>
  Array.from({ length: n }, (_, i) => ({ url: `https://${domain}${path}${i}` }));

async function insertSource(tx: Db, domain: string, status: SourceStatus, validTo?: string): Promise<string> {
  const [row] = await tx
    .insert(sources)
    .values({
      domain,
      name: domain,
      type: "trip_report",
      weight: 0.6,
      status,
      crawlRules: DEFAULT_CRAWL_RULES,
      origin: "manual",
      ...(validTo ? { validFrom: "2020-01-01", validTo } : {}),
    })
    .returning({ id: sources.id });
  return row!.id;
}

async function testRun(tx: Db): Promise<string> {
  return (await createRun(tx, { kind: "stage", scope: { type: "system", id: "test" }, stages: [], triggeredBy: "test" })).id;
}

async function propose(tx: Db, transport: Transport = robotsTransport()) {
  const runId = await testRun(tx);
  const result = await proposeSources(tx, { transport, archive: memoryArchive() }, { db: tx, runId, stage: "discovery.propose" });
  return { runId, result };
}

async function sourceOf(tx: Db, domain: string) {
  const [row] = await tx.select().from(sources).where(eq(sources.domain, domain));
  return row;
}

async function tasksOf(tx: Db, sourceId: string) {
  return tx
    .select()
    .from(reviewTasks)
    .where(and(eq(reviewTasks.kind, "source_approval"), eq(reviewTasks.subjectId, sourceId)));
}

describe("proposeSources", () => {
  it("a domain with 3 hits becomes a proposed source with an open source_approval task", () =>
    withRollback(async (tx) => {
      const domain = testDomain();
      await insertHits(tx, domain, [
        { url: `https://www.${domain}/blog/a`, rank: 7, languageCode: "de" },
        { url: `https://www.${domain}/blog/b`, rank: 2, languageCode: "en" },
        { url: `https://www.${domain}/blog/c`, rank: 4, languageCode: "de" },
      ]);
      const transport = robotsTransport({ [`https://www.${domain}`]: "User-agent: *\nDisallow: /private/\nSitemap: https://x/s.xml\n" });
      const { result } = await propose(tx, transport);
      expect(result.proposed).toBeGreaterThanOrEqual(1);

      const source = await sourceOf(tx, domain);
      expect(source).toMatchObject({
        domain,
        name: domain,
        type: "trip_report",
        weight: 0.6,
        changeRate: "normal",
        status: "proposed",
        origin: "serp",
        languages: ["de", "en"],
      });
      expect(source!.crawlRules).toMatchObject({ startUrls: [`https://www.${domain}/blog/`], allow: ["^/(blog)/"] });
      expect(transport.requests.map((r) => r.url)).toContain(`https://www.${domain}/robots.txt`);

      const tasks = await tasksOf(tx, source!.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: "open", subjectType: "source", priority: 3 });
      const context = tasks[0]!.context as Record<string, unknown>;
      expect(context).toMatchObject({
        hitCount: 3,
        linkingSources: 0,
        languages: ["de", "en"],
        robots: { status: "parsed", disallowAll: false, blockedStartUrls: [], sitemaps: 1 },
        suggestion: { type: "trip_report", weight: 0.6, changeRate: "normal", crawlRules: source!.crawlRules },
      });
      expect((context.hits as Array<{ rank: number }>).map((h) => h.rank)).toEqual([2, 4, 7]);
      expect((context.hits as unknown[])[0]).toMatchObject({
        url: `https://www.${domain}/blog/b`,
        languageCode: "en",
        rank: 2,
        title: "Title 1",
        snippet: "Snippet 1",
      });
    }));

  it("2 hits are not enough", () =>
    withRollback(async (tx) => {
      const domain = testDomain();
      await insertHits(tx, domain, pages(domain, 2));
      await propose(tx);
      expect(await sourceOf(tx, domain)).toBeUndefined();
    }));

  it("the same query searched twice counts its hits once", () =>
    withRollback(async (tx) => {
      const domain = testDomain();
      await insertHits(tx, domain, [
        { url: `https://${domain}/a`, keyword: `same ${domain}` },
        { url: `https://${domain}/a`, keyword: `same ${domain}` },
        { url: `https://${domain}/b` },
      ]);
      const candidates = await domainCandidates(tx, proposals());
      expect(candidates.find((c) => c.domain === domain)).toBeUndefined();
    }));

  it("navily.com is never proposed, even with 10 hits", () =>
    withRollback(async (tx) => {
      await insertHits(tx, "navily.com", pages("navily.com", 10));
      await insertHits(tx, "fr.navily.com", pages("fr.navily.com", 10));
      const candidates = await domainCandidates(tx, proposals());
      expect(candidates.map((c) => c.domain)).not.toContain("navily.com");
      expect(candidates.map((c) => c.domain)).not.toContain("fr.navily.com");
    }));

  it("a rejected domain is not proposed again", () =>
    withRollback(async (tx) => {
      const rejected = testDomain();
      const ended = testDomain();
      await insertSource(tx, rejected, "rejected");
      await insertSource(tx, ended, "approved", "2026-01-01");
      await insertHits(tx, rejected, pages(rejected, 5));
      await insertHits(tx, ended, pages(ended, 5));
      const domains = (await domainCandidates(tx, proposals())).map((c) => c.domain);
      expect(domains).not.toContain(rejected);
      expect(domains).not.toContain(ended);
    }));

  it("a domain linked from 2 approved sources is proposed without serp hits", () =>
    withRollback(async (tx) => {
      const target = testDomain();
      const a = await insertSource(tx, testDomain(), "approved");
      const b = await insertSource(tx, testDomain(), "approved");
      const run = await testRun(tx);
      await tx.insert(outlinks).values([
        { fromSourceId: a, toDomain: target, count: 4, runId: run },
        { fromSourceId: b, toDomain: target, count: 1, runId: run },
      ]);
      const transport = robotsTransport();
      await propose(tx, transport);

      const source = await sourceOf(tx, target);
      expect(source).toMatchObject({ status: "proposed", origin: "linkgraph", type: "trip_report", languages: [] });
      expect(source!.crawlRules).toMatchObject({ startUrls: [`https://${target}/`], allow: [] });
      expect(transport.requests.map((r) => r.url)).toContain(`https://${target}/robots.txt`);
      const [task] = await tasksOf(tx, source!.id);
      expect(task).toMatchObject({ priority: 4 });
      expect(task!.context).toMatchObject({ hits: [], linkingSources: 2 });
    }));

  it("only the newest run of each linking source counts, and only approved sources", () =>
    withRollback(async (tx) => {
      const target = testDomain();
      const a = await insertSource(tx, testDomain(), "approved");
      const b = await insertSource(tx, testDomain(), "approved");
      const paused = await insertSource(tx, testDomain(), "paused");
      const older = await testRun(tx);
      await tx.update(runs).set({ createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(runs.id, older));
      const newer = await testRun(tx);
      await tx.insert(outlinks).values([
        { fromSourceId: a, toDomain: target, count: 1, runId: older },
        { fromSourceId: a, toDomain: testDomain(), count: 1, runId: newer },
        { fromSourceId: b, toDomain: target, count: 1, runId: newer },
        { fromSourceId: paused, toDomain: target, count: 1, runId: newer },
      ]);
      const domains = (await domainCandidates(tx, proposals())).map((c) => c.domain);
      expect(domains).not.toContain(target);
    }));

  it("a robots.txt that cannot be read does not stop the proposal", () =>
    withRollback(async (tx) => {
      const domain = testDomain();
      await insertHits(tx, domain, pages(domain, 3));
      await propose(tx, robotsTransport({ [`https://${domain}`]: 503 }));
      const source = await sourceOf(tx, domain);
      const [task] = await tasksOf(tx, source!.id);
      expect(task!.context).toMatchObject({ robots: { status: "unavailable" } });
    }));

  it("a robots.txt the address guard refuses is unavailable, not a failed proposal job", () =>
    withRollback(async (tx) => {
      const domain = testDomain();
      await insertHits(tx, domain, pages(domain, 3));
      const blocked: Transport = async (req) => {
        throw new BlockedAddressError(new URL(req.url).hostname, "169.254.169.254");
      };
      await propose(tx, blocked);
      const [task] = await tasksOf(tx, (await sourceOf(tx, domain))!.id);
      expect(task!.context).toMatchObject({ robots: { status: "unavailable" } });
    }));

  it("a domain proposed meanwhile is skipped", () =>
    withRollback(async (tx) => {
      const domain = testDomain();
      await insertHits(tx, domain, pages(domain, 3));
      const transport: Transport = async (req) => {
        // Another process proposes the domain while robots.txt is read.
        if (req.url === `https://${domain}/robots.txt`) await insertSource(tx, domain, "proposed");
        return makeResponse(404, new Uint8Array());
      };
      const { result } = await propose(tx, transport);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      const rows = await tx.select().from(sources).where(eq(sources.domain, domain));
      expect(rows).toHaveLength(1);
      expect(await tasksOf(tx, rows[0]!.id)).toHaveLength(0);
    }));
});

describe("suggestCrawlRules", () => {
  it("suggestCrawlRules derives start urls and allow from the hits", () => {
    expect(
      suggestCrawlRules(["https://x.com/greece/saronic/a", "https://x.com/greece/argolic/b", "https://x.com/blog/c"]),
    ).toMatchObject({ startUrls: ["https://x.com/blog/", "https://x.com/greece/"], allow: ["^/(blog|greece)/"] });
  });

  it("uses the most frequent host and keeps the default limits and deny list", () => {
    const rules = suggestCrawlRules(["https://www.x.com/a/1", "https://www.x.com/b/2", "https://x.com/c/3"]);
    expect(rules).toEqual({
      ...DEFAULT_CRAWL_RULES,
      startUrls: ["https://www.x.com/a/", "https://www.x.com/b/"],
      allow: ["^/(a|b)/"],
      deny: ["/tag/", "/comment", "\\?replytocom=", "/wp-login", "/feed/?$"],
    });
  });

  it("a hit directly under / opens the whole site", () => {
    expect(suggestCrawlRules(["https://x.com/blog/a", "https://x.com/about"])).toMatchObject({
      startUrls: ["https://x.com/"],
      allow: [],
    });
  });

  it("keeps at most 5 path segments, the most frequent ones, and escapes them", () => {
    const urls = ["a", "a", "b", "c", "d", "e", "f.x"].map((s, i) => `https://x.com/${s}/${i}`);
    urls.push("https://x.com/f.x/9");
    const rules = suggestCrawlRules(urls);
    expect(rules.allow).toEqual(["^/(a|b|c|d|f\\.x)/"]);
    expect(rules.startUrls).toHaveLength(5);
  });
});

describe("suggestType", () => {
  it("suggestType: forum urls make a forum, otherwise trip_report", () => {
    expect(
      suggestType(["https://x.com/forum/viewtopic.php?t=1", "https://x.com/forum/t2", "https://x.com/about"], proposals()),
    ).toBe("forum");
    expect(suggestType(["https://x.com/forum/1", "https://x.com/a", "https://x.com/b"], proposals())).toBe("trip_report");
    expect(suggestType([], proposals())).toBe("trip_report");
  });

  it("follows the order of the hints", () => {
    expect(suggestType(["https://marina-x.com/guide.pdf", "https://marina-x.com/b"], proposals())).toBe("marina");
    expect(suggestType(["https://x.gov.gr/a", "https://x.gov.gr/b"], proposals())).toBe("authority");
    expect(suggestType(["https://x.com/files/Saronic.PDF"], proposals())).toBe("pilot_guide");
    expect(suggestType(["https://x.de/2019/06/toern"], proposals())).toBe("trip_report");
  });
});

describe("source store", () => {
  it("reads a source with parsed crawl rules and sets its status", () =>
    withRollback(async (tx) => {
      const domain = testDomain();
      const id = await insertSource(tx, domain, "approved");
      await tx.update(sources).set({ crawlRules: { startUrls: [`https://${domain}/`] } }).where(eq(sources.id, id));
      expect(await getSource(tx, id)).toEqual({
        id,
        domain,
        name: domain,
        type: "trip_report",
        weight: 0.6,
        status: "approved",
        statusReason: null,
        crawlRules: { ...DEFAULT_CRAWL_RULES, startUrls: [`https://${domain}/`] },
        changeRate: "normal",
        languages: [],
        origin: "manual",
      });
      await setSourceStatus(tx, id, "paused", "robots");
      expect(await getSource(tx, id)).toMatchObject({ status: "paused", statusReason: "robots" });
      expect(await getSource(tx, newId())).toBeNull();
    }));
});
