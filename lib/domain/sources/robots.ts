import robotsParser from "robots-parser";
import { httpCall, type CallContext, type Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";

/** Product token Periplus matches `User-agent` groups with (the User-Agent header is `Periplus/0.1 (…)`). */
export const ROBOTS_AGENT = "Periplus";

/** RFC 9309: crawlers must parse at least 500 KiB; content past that limit is ignored. */
const MAX_ROBOTS_BYTES = 500 * 1024;

export type RobotsPolicy = {
  origin: string;
  /** `allow_all`: no robots.txt (4xx other than 429), everything may be crawled. */
  status: "parsed" | "allow_all";
  text: string | null;
  crawlDelaySec: number | null;
  sitemaps: string[];
  /** Whether `url` may be fetched; a URL of another origin is never allowed by this policy. */
  isAllowed(url: string): boolean;
};

export type RobotsSummary = {
  status: "parsed" | "allow_all";
  disallowAll: boolean;
  blockedStartUrls: string[];
  crawlDelaySec: number | null;
  sitemaps: number;
};

/** Cuts `text` to at most 500 KiB of UTF-8, dropping a character split at the limit. */
function truncate(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= MAX_ROBOTS_BYTES) return text;
  return new TextDecoder().decode(bytes.subarray(0, MAX_ROBOTS_BYTES)).replace(/�$/, "");
}

/** Policy of `origin` from its robots.txt text (RFC 9309 groups, longest match); `null` allows everything. */
export function parseRobots(origin: string, text: string | null): RobotsPolicy {
  const base = new URL(origin).origin;
  const sameOrigin = (url: string) => {
    try {
      return new URL(url).origin === base;
    } catch {
      return false;
    }
  };
  if (text === null) {
    return { origin: base, status: "allow_all", text: null, crawlDelaySec: null, sitemaps: [], isAllowed: sameOrigin };
  }
  const kept = truncate(text);
  const robots = robotsParser(`${base}/robots.txt`, kept);
  return {
    origin: base,
    status: "parsed",
    text: kept,
    crawlDelaySec: robots.getCrawlDelay(ROBOTS_AGENT) ?? null,
    sitemaps: robots.getSitemaps(),
    isAllowed: (url) => sameOrigin(url) && robots.isAllowed(url, ROBOTS_AGENT) === true,
  };
}

/**
 * GETs `<origin>/robots.txt` (service `robots`, redirects followed). 4xx other than 429 means no robots.txt:
 * everything allowed. 429, 5xx and network failures throw `RetryableHttpError`: nothing may be crawled
 * until robots.txt can be read (RFC 9309), so the job is retried.
 */
export async function fetchRobots(transport: Transport, origin: string, ctx: CallContext): Promise<RobotsPolicy> {
  const base = new URL(origin).origin;
  const res = await httpCall(
    transport,
    {
      service: "robots",
      operation: "robots.txt",
      url: `${base}/robots.txt`,
      timeoutMs: getConfig().fetch.timeoutMs,
      okStatuses: Array.from({ length: 100 }, (_, i) => 400 + i).filter((s) => s !== 429),
      meta: { origin: base },
    },
    ctx,
  );
  return parseRobots(base, res.status >= 400 ? null : new TextDecoder().decode(res.body));
}

type ArchivedRobots = { status: RobotsPolicy["status"]; text: string | null };

/**
 * Robots policy of `origin` for run `runId`: read once per host and run from `robots/<host>/<runId>.json`
 * in the archive, fetched and stored there on first use. Two concurrent first uses both fetch; harmless.
 */
export async function robotsForRun(
  db: Db,
  archive: Archive,
  transport: Transport,
  origin: string,
  runId: string,
  ctx: CallContext,
): Promise<RobotsPolicy> {
  const base = new URL(origin);
  const key = `robots/${base.host}/${runId}.json`;
  const stored = await archive.get(key);
  if (stored) {
    const archived = JSON.parse(new TextDecoder().decode(stored)) as ArchivedRobots;
    return parseRobots(base.origin, archived.status === "allow_all" ? null : archived.text);
  }
  const policy = await fetchRobots(transport, base.origin, { ...ctx, db });
  const record: ArchivedRobots = { status: policy.status, text: policy.text };
  await archive.put(key, JSON.stringify(record), "application/json");
  return policy;
}

/** What robots.txt means for a source with these start URLs, for proposals and the admin. */
export function robotsSummary(policy: RobotsPolicy, startUrls: string[]): RobotsSummary {
  return {
    status: policy.status,
    disallowAll: !policy.isAllowed(`${policy.origin}/`),
    blockedStartUrls: startUrls.filter((url) => !policy.isAllowed(url)),
    crawlDelaySec: policy.crawlDelaySec,
    sitemaps: policy.sitemaps.length,
  };
}

/** An explicit crawl ban: the site root is disallowed, or every start URL is (spec 05: pauses the source). */
export function explicitBan(policy: RobotsPolicy, startUrls: string[]): boolean {
  if (!policy.isAllowed(`${policy.origin}/`)) return true;
  return startUrls.length > 0 && startUrls.every((url) => !policy.isAllowed(url));
}

/** Requests per minute honouring a crawl-delay: `max(1, min(rulesRate, floor(60 / crawlDelaySec)))`. */
export function effectiveRate(rulesRate: number, crawlDelaySec: number | null): number {
  if (crawlDelaySec === null || crawlDelaySec <= 0) return Math.max(1, rulesRate);
  return Math.max(1, Math.min(rulesRate, Math.floor(60 / crawlDelaySec)));
}
