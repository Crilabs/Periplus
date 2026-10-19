import robotsParser from "robots-parser";
import { httpCall, RetryableHttpError, type CallContext, type Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { createLogger } from "@/lib/logger";

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
  /** Whether the group that applies to Periplus has an `Allow` rule with a path. */
  hasAllowRule: boolean;
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

/** Percent-encodings of unreserved characters (RFC 3986) decoded: `/%7Ejoe` and `/~joe` are the same path (RFC 9309). */
function decodeUnreserved(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex: string) => {
    const c = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : escape.toUpperCase();
  });
}

const RULE_LINE = /^(\s*(?:allow|disallow)\s*:\s*)([^#]*)(.*)$/i;

/** The robots.txt text with every `Allow`/`Disallow` path in the form `decodeUnreserved` gives URLs. */
function normalizeRulePaths(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(RULE_LINE, (_, head: string, path: string, rest: string) => `${head}${decodeUnreserved(path)}${rest}`))
    .join("\n");
}

/**
 * Whether the group that applies to `agent` (RFC 9309: the groups naming the agent's product token,
 * case-insensitive, merged; else the `*` groups) has an `Allow` rule with a non-empty path.
 */
function groupHasAllow(text: string, agent: string): boolean {
  const own = agent.toLowerCase();
  const rules: Record<"own" | "any", boolean> = { own: false, any: false };
  const seen = { own: false, any: false };
  let agents: string[] = [];
  let inRules = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
      if (value.toLowerCase() === own) seen.own = true;
      if (value === "*") seen.any = true;
      continue;
    }
    if (key !== "allow" && key !== "disallow") continue;
    inRules = true;
    if (key !== "allow" || value === "") continue;
    if (agents.includes(own)) rules.own = true;
    if (agents.includes("*")) rules.any = true;
  }
  return seen.own ? rules.own : rules.any;
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
    return { origin: base, status: "allow_all", text: null, crawlDelaySec: null, sitemaps: [], hasAllowRule: false, isAllowed: sameOrigin };
  }
  const kept = truncate(text);
  const robots = robotsParser(`${base}/robots.txt`, normalizeRulePaths(kept));
  return {
    origin: base,
    status: "parsed",
    text: kept,
    crawlDelaySec: robots.getCrawlDelay(ROBOTS_AGENT) ?? null,
    sitemaps: robots.getSitemaps(),
    hasAllowRule: groupHasAllow(kept, ROBOTS_AGENT),
    isAllowed: (url) => {
      if (!sameOrigin(url)) return false;
      const u = new URL(url);
      return robots.isAllowed(`${u.origin}${decodeUnreserved(u.pathname)}${u.search}`, ROBOTS_AGENT) === true;
    },
  };
}

/**
 * GETs `<origin>/robots.txt` (service `robots`, redirects followed, at most 500 KiB read). A 2xx answer is parsed;
 * 4xx other than 429 means no robots.txt: everything allowed. Every other answer (429, 5xx, a redirect that did not
 * end, 1xx) and network failures throw `RetryableHttpError`: nothing may be crawled until robots.txt can be read
 * (RFC 9309), so the job is retried (a proposal shows it as `unavailable`).
 */
export async function fetchRobots(transport: Transport, origin: string, ctx: CallContext): Promise<RobotsPolicy> {
  const base = new URL(origin).origin;
  const url = `${base}/robots.txt`;
  const res = await httpCall(
    transport,
    {
      service: "robots",
      operation: "robots.txt",
      url,
      timeoutMs: getConfig().fetch.timeoutMs,
      maxBodyBytes: MAX_ROBOTS_BYTES,
      okStatuses: Array.from({ length: 400 }, (_, i) => 100 + i).filter((s) => s !== 429),
      meta: { origin: base },
    },
    ctx,
  );
  if (res.status >= 200 && res.status <= 299) {
    const text = new TextDecoder().decode(res.body);
    // A character the byte limit cut in two decodes as U+FFFD: dropped.
    return parseRobots(base, res.truncated ? text.replace(/\uFFFD$/, "") : text);
  }
  if (res.status >= 400) return parseRobots(base, null);
  throw new RetryableHttpError(`robots.txt of ${base} answered HTTP ${res.status}`, res.status);
}

type ArchivedRobots = { status: RobotsPolicy["status"]; text: string | null };

/** The archived robots record, or null when it is not one (corrupt or foreign object). */
function readArchived(bytes: Uint8Array): ArchivedRobots | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ArchivedRobots> | null;
    if (value?.status === "allow_all") return { status: "allow_all", text: null };
    if (value?.status === "parsed" && typeof value.text === "string") return { status: "parsed", text: value.text };
    return null;
  } catch {
    return null;
  }
}

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
  const archived = stored ? readArchived(stored) : null;
  if (archived) return parseRobots(base.origin, archived.status === "allow_all" ? null : archived.text);
  if (stored) createLogger("robots").warn({ key }, "archived robots.txt unreadable, fetching again");
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

/**
 * An explicit crawl ban (spec 05: pauses the source): the site root is disallowed for Periplus and its group has no
 * `Allow` rule. A site that disallows `/` but allows `/public` is crawled within the allowed paths.
 */
export function explicitBan(policy: RobotsPolicy): boolean {
  return !policy.isAllowed(`${policy.origin}/`) && !policy.hasAllowRule;
}

/** Requests per minute honouring a crawl-delay: `max(1, min(rulesRate, floor(60 / crawlDelaySec)))`. */
export function effectiveRate(rulesRate: number, crawlDelaySec: number | null): number {
  if (crawlDelaySec === null || crawlDelaySec <= 0) return Math.max(1, rulesRate);
  return Math.max(1, Math.min(rulesRate, Math.floor(60 / crawlDelaySec)));
}
