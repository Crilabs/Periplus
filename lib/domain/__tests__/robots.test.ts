import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeResponse, RetryableHttpError, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { newId } from "@/lib/domain/ids";
import {
  effectiveRate,
  explicitBan,
  fetchRobots,
  parseRobots,
  ROBOTS_AGENT,
  robotsForRun,
  robotsSummary,
} from "@/lib/domain/sources/robots";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

const fixture = (name: string) => readFileSync(join("test/fixtures/robots", name), "utf8");
const origin = () => `https://${newId()}.test.invalid`;

/** Answers every request with `status` and `body`, remembering the requests. */
function stubTransport(status: number, body = ""): Transport & { seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  const transport = async (req: HttpRequest) => {
    seen.push(req);
    return makeResponse(status, new TextEncoder().encode(body));
  };
  return Object.assign(transport, { seen });
}

describe("parseRobots", () => {
  it("a Periplus group wins over *", () => {
    expect(ROBOTS_AGENT).toBe("Periplus");
    const o = origin();
    const policy = parseRobots(o, fixture("ua-group.txt"));
    expect(policy.status).toBe("parsed");
    expect(policy.isAllowed(`${o}/`)).toBe(true);
    expect(policy.isAllowed(`${o}/harbours/aegina`)).toBe(true);
    expect(policy.isAllowed(`${o}/drafts/x`)).toBe(false);
    expect(explicitBan(policy)).toBe(false);
  });

  it("the longest matching rule wins", () => {
    const o = origin();
    const policy = parseRobots(o, fixture("longest-match.txt"));
    expect(policy.isAllowed(`${o}/a/b/c`)).toBe(true);
    expect(policy.isAllowed(`${o}/a/x`)).toBe(false);
    expect(policy.isAllowed(`${o}/b`)).toBe(true);
  });

  it("Disallow: / for * is an explicit ban", () => {
    const o = origin();
    const policy = parseRobots(o, fixture("disallow-all.txt"));
    expect(explicitBan(policy)).toBe(true);
    const summary = robotsSummary(policy, [`${o}/guide`]);
    expect(summary).toEqual({
      status: "parsed",
      disallowAll: true,
      blockedStartUrls: [`${o}/guide`],
      crawlDelaySec: null,
      sitemaps: 0,
    });
  });

  it("blocked start urls are listed", () => {
    const o = origin();
    const policy = parseRobots(o, fixture("longest-match.txt"));
    const startUrls = [`${o}/a/x`, `${o}/a/b/c`, `${o}/other`];
    const summary = robotsSummary(policy, startUrls);
    expect(summary.blockedStartUrls).toEqual([`${o}/a/x`]);
    expect(summary.disallowAll).toBe(false);
    expect(explicitBan(policy)).toBe(false);
  });

  it("crawl-delay 10 is read and limits the rate", () => {
    const o = origin();
    const policy = parseRobots(o, fixture("crawl-delay.txt"));
    expect(policy.crawlDelaySec).toBe(10);
    expect(policy.sitemaps).toEqual([
      "https://example.test.invalid/sitemap.xml",
      "https://example.test.invalid/news-sitemap.xml",
    ]);
    expect(robotsSummary(policy, []).sitemaps).toBe(2);
    expect(effectiveRate(20, 10)).toBe(6);
    expect(effectiveRate(20, 120)).toBe(1);
    expect(effectiveRate(20, 1)).toBe(20);
    expect(effectiveRate(20, null)).toBe(20);
  });

  it("no text allows everything", () => {
    const o = origin();
    const policy = parseRobots(`${o}/`, null);
    expect(policy).toMatchObject({ origin: o, status: "allow_all", text: null, crawlDelaySec: null, sitemaps: [] });
    expect(policy.isAllowed(`${o}/anything`)).toBe(true);
    expect(robotsSummary(policy, [`${o}/x`])).toEqual({
      status: "allow_all",
      disallowAll: false,
      blockedStartUrls: [],
      crawlDelaySec: null,
      sitemaps: 0,
    });
  });

  it("ignores rules past 500 KiB (RFC 9309)", () => {
    const o = origin();
    const padding = `# ${"x".repeat(500 * 1024)}\n`;
    const policy = parseRobots(o, `User-agent: *\nDisallow: /early\n${padding}Disallow: /late\n`);
    expect(policy.isAllowed(`${o}/early`)).toBe(false);
    expect(policy.isAllowed(`${o}/late`)).toBe(true);
    expect(new TextEncoder().encode(policy.text!).byteLength).toBeLessThanOrEqual(500 * 1024);
  });

  it("disallowing the root with an Allow rule in the group is no explicit ban", () => {
    const o = origin();
    const policy = parseRobots(o, "User-agent: *\nDisallow: /\nAllow: /public\n");
    expect(policy.hasAllowRule).toBe(true);
    expect(policy.isAllowed(`${o}/`)).toBe(false);
    expect(policy.isAllowed(`${o}/public/x`)).toBe(true);
    expect(explicitBan(policy)).toBe(false);
  });

  it("an Allow rule of another group does not lift the ban of ours", () => {
    const o = origin();
    const policy = parseRobots(o, "User-agent: Googlebot\nAllow: /public\n\nUser-agent: periplus\nDisallow: /\n");
    expect(policy.hasAllowRule).toBe(false);
    expect(explicitBan(policy)).toBe(true);
    // An empty Allow is no rule.
    expect(explicitBan(parseRobots(o, "User-agent: *\nAllow:\nDisallow: /\n"))).toBe(true);
  });

  it("matches group names case-insensitively", () => {
    const o = origin();
    const policy = parseRobots(o, "User-agent: *\nDisallow:\n\nUser-agent: PERIPLUS\nDisallow: /x\n");
    expect(policy.isAllowed(`${o}/x`)).toBe(false);
    expect(policy.isAllowed(`${o}/y`)).toBe(true);
  });

  it("supports * wildcards and the $ end anchor", () => {
    const o = origin();
    const policy = parseRobots(o, "User-agent: *\nDisallow: /private*.html$\nDisallow: /end$\n");
    expect(policy.isAllowed(`${o}/private-a.html`)).toBe(false);
    expect(policy.isAllowed(`${o}/private/b/c.html`)).toBe(false);
    expect(policy.isAllowed(`${o}/private-a.htmlx`)).toBe(true);
    expect(policy.isAllowed(`${o}/end`)).toBe(false);
    expect(policy.isAllowed(`${o}/end/more`)).toBe(true);
  });

  it("treats %7E and ~ as the same character, in rules and urls", () => {
    const o = origin();
    const tilde = parseRobots(o, "User-agent: *\nDisallow: /~joe/\n");
    expect(tilde.isAllowed(`${o}/~joe/a`)).toBe(false);
    expect(tilde.isAllowed(`${o}/%7Ejoe/a`)).toBe(false);
    expect(tilde.isAllowed(`${o}/%7ejoe/a`)).toBe(false);
    const encoded = parseRobots(o, "User-agent: *\nDisallow: /%7Ejoe/\n");
    expect(encoded.isAllowed(`${o}/~joe/a`)).toBe(false);
    // Reserved characters stay encoded: /a%2Fb is not /a/b.
    const slash = parseRobots(o, "User-agent: *\nDisallow: /a/b\n");
    expect(slash.isAllowed(`${o}/a%2Fb`)).toBe(true);
  });

  it("an Allow and a Disallow of equal length: Allow wins", () => {
    const o = origin();
    const policy = parseRobots(o, "User-agent: *\nDisallow: /tie\nAllow: /tie\n");
    expect(policy.isAllowed(`${o}/tie`)).toBe(true);
  });

  it("a URL of another origin is not allowed", () => {
    const policy = parseRobots(origin(), fixture("longest-match.txt"));
    expect(policy.isAllowed(`${origin()}/b`)).toBe(false);
  });
});

describe("fetchRobots", () => {
  it("parses a 200 answer from <origin>/robots.txt", async () => {
    const o = origin();
    const transport = stubTransport(200, fixture("crawl-delay.txt"));
    const policy = await withRollback((db) => fetchRobots(transport, o, { db }));
    expect(transport.seen).toHaveLength(1);
    expect(transport.seen[0]).toMatchObject({ service: "robots", url: `${o}/robots.txt` });
    expect(policy.status).toBe("parsed");
    expect(policy.crawlDelaySec).toBe(10);
  });

  it("404 means allow all", async () => {
    const o = origin();
    const policy = await withRollback((db) => fetchRobots(stubTransport(404, "not found"), o, { db }));
    expect(policy.status).toBe("allow_all");
    expect(policy.text).toBeNull();
    expect(policy.isAllowed(`${o}/a`)).toBe(true);
  });

  it("503 is retryable", async () => {
    await expect(withRollback((db) => fetchRobots(stubTransport(503), origin(), { db }))).rejects.toBeInstanceOf(
      RetryableHttpError,
    );
  });

  it("a redirect or informational answer is unavailable, not empty rules", async () => {
    for (const status of [304, 302, 199]) {
      await expect(withRollback((db) => fetchRobots(stubTransport(status, "User-agent: *\nDisallow: /"), origin(), { db }))).rejects.toBeInstanceOf(
        RetryableHttpError,
      );
    }
  });

  it("reads at most 500 KiB of the body", async () => {
    const o = origin();
    const transport = stubTransport(200, "User-agent: *\nDisallow: /x\n");
    await withRollback((db) => fetchRobots(transport, o, { db }));
    expect(transport.seen[0]!.maxBodyBytes).toBe(500 * 1024);
  });

  it("429 is retryable, not allow all", async () => {
    await expect(withRollback((db) => fetchRobots(stubTransport(429), origin(), { db }))).rejects.toBeInstanceOf(
      RetryableHttpError,
    );
  });
});

describe("robotsForRun", () => {
  it("robots are read once per host and run", async () => {
    const o = origin();
    const archive = memoryArchive();
    const transport = stubTransport(200, fixture("longest-match.txt"));
    const runId = newId();
    const host = new URL(o).host;

    await withRollback(async (db) => {
      const first = await robotsForRun(db, archive, transport, o, runId, { db, runId });
      const second = await robotsForRun(db, archive, transport, o, runId, { db, runId });
      expect(transport.seen).toHaveLength(1);
      expect(archive.keys()).toEqual([`robots/${host}/${runId}.json`]);
      expect(second.status).toBe("parsed");
      expect(second.text).toBe(first.text);
      expect(second.isAllowed(`${o}/a/x`)).toBe(false);

      await robotsForRun(db, archive, transport, o, newId(), { db });
      expect(transport.seen).toHaveLength(2);
    });
  });

  it("a corrupt cached record is fetched again", async () => {
    const o = origin();
    const archive = memoryArchive();
    const transport = stubTransport(200, fixture("longest-match.txt"));
    const runId = newId();
    await archive.put(`robots/${new URL(o).host}/${runId}.json`, "{not json", "application/json");
    await withRollback(async (db) => {
      const policy = await robotsForRun(db, archive, transport, o, runId, { db, runId });
      expect(transport.seen).toHaveLength(1);
      expect(policy.isAllowed(`${o}/a/x`)).toBe(false);
    });
  });

  it("an allow-all answer is cached too", async () => {
    const o = origin();
    const archive = memoryArchive();
    const transport = stubTransport(410);
    const runId = newId();
    await withRollback(async (db) => {
      await robotsForRun(db, archive, transport, o, runId, { db, runId });
      const again = await robotsForRun(db, archive, transport, o, runId, { db, runId });
      expect(transport.seen).toHaveLength(1);
      expect(again.status).toBe("allow_all");
    });
  });
});
