import { inArray, sql } from "drizzle-orm";
import { BlockedUrlError } from "@/lib/adapters/fetch/ssrf";
import { HttpError, RetryableHttpError, type CallContext, type Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig, type AppConfig, type DiscoveryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { sources, type DocType, type SourceOrigin } from "@/lib/db/schema";
import { createReviewTask } from "@/lib/domain/review";
import { DEFAULT_CRAWL_RULES, type CrawlRules } from "@/lib/domain/sources/crawl-rules";
import { robotsForRun, robotsSummary, type RobotsSummary } from "@/lib/domain/sources/robots";
import { safeDecode } from "@/lib/domain/sources/urls";
import { createLogger } from "@/lib/logger";

type ProposalsConfig = DiscoveryConfig["proposals"];

export type SerpHit = { url: string; keyword: string; languageCode: string; rank: number; title: string; snippet: string };

export type DomainCandidate = { domain: string; hits: SerpHit[]; linkingSources: number };

/** robots.txt summary in a proposal; `unavailable` when it could not be read (the crawl reads it again anyway). */
export type ProposalRobots = RobotsSummary | { status: "unavailable" };

/** Deny patterns of every suggested source: tag and feed pages, comment links, logins. */
const SUGGESTED_DENY = ["/tag/", "/comment", "\\?replytocom=", "/wp-login", "/feed/?$"];
const MAX_SUGGESTED_SEGMENTS = 5;

// Created on first use so importing this module reads no env (the build collects pages without one).
let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("discovery.proposals"));

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Distinct values by descending frequency, ties alphabetical. */
function byFrequency(values: string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || cmp(a.value, b.value));
}

function httpUrls(urls: string[]): URL[] {
  return urls.flatMap((u) => {
    try {
      const url = new URL(u);
      return url.protocol === "http:" || url.protocol === "https:" ? [url] : [];
    } catch {
      return [];
    }
  });
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The first type hint (in config order) whose pattern matches `host + pathname` (case-insensitive, path decoded)
 * of at least half of the URLs; `defaultType` without URLs or without such a hint.
 */
export function suggestType(urls: string[], cfg: ProposalsConfig): DocType {
  const targets = httpUrls(urls).map((u) => u.hostname + safeDecode(u.pathname));
  if (targets.length === 0) return cfg.defaultType;
  for (const hint of cfg.typeHints) {
    const re = new RegExp(hint.pattern, "i");
    if (targets.filter((t) => re.test(t)).length * 2 >= targets.length) return hint.type;
  }
  return cfg.defaultType;
}

/**
 * Crawl rules from the URL patterns of the hits (no model): the most frequent host; the first path segments of the
 * hits on that host (the 5 most frequent, sorted) as start URLs `https://<host>/<segment>/` and one `allow`
 * pattern `^/(seg1|seg2)/`. A hit directly under `/` opens the whole site (`https://<host>/`, no `allow`).
 * Fixed deny list, everything else the default rules.
 */
export function suggestCrawlRules(urls: string[]): CrawlRules {
  const parsed = httpUrls(urls);
  const base = { ...DEFAULT_CRAWL_RULES, deny: [...SUGGESTED_DENY] };
  if (parsed.length === 0) return base;
  const host = byFrequency(parsed.map((u) => u.host))[0]!.value;
  const onHost = parsed.filter((u) => u.host === host);
  const parts = onHost.map((u) => u.pathname.split("/"));
  // "/a" and "/" have no directory segment: the hit sits directly under the root.
  if (parts.some((p) => p.length < 3 || p[1] === "")) return { ...base, startUrls: [`https://${host}/`], allow: [] };
  const segments = byFrequency(parts.map((p) => p[1]!))
    .slice(0, MAX_SUGGESTED_SEGMENTS)
    .map(({ value }) => ({ raw: value, decoded: safeDecode(value) }))
    .sort((a, b) => cmp(a.decoded, b.decoded));
  return {
    ...base,
    startUrls: segments.map((s) => `https://${host}/${s.raw}/`),
    allow: [`^/(${segments.map((s) => escapeRegex(s.decoded)).join("|")})/`],
  };
}

const ignored = (domain: string, ignoreDomains: string[]) =>
  ignoreDomains.some((i) => domain === i || domain.endsWith(`.${i}`));

/**
 * Domains to propose: at least `minSerpHits` SERP hits (a URL found again by a later search of the same query
 * counts once), or linked from at least `minLinkingSources` distinct approved sources in each one's newest
 * crawl run. Without `ignoreDomains` (equal or subdomain) and without every domain that has a `sources` row
 * (any status, ended ones too). Ordered by domain; hits by rank, then URL.
 */
export async function domainCandidates(db: Db, cfg: ProposalsConfig): Promise<DomainCandidate[]> {
  const serp = await db.execute<{ domain: string }>(sql`
    with hits as (
      select distinct r.domain, q.keyword, q.language_code, q.location_code, r.url_normalized
      from serp_results r join serp_queries q on q.id = r.serp_query_id
    )
    select domain from hits group by domain having count(*) >= ${cfg.minSerpHits}
  `);
  const linked = await db.execute<{ domain: string; n: number }>(sql`
    with newest as (
      select distinct on (o.from_source_id) o.from_source_id, o.run_id
      from outlinks o
      join sources s on s.id = o.from_source_id and s.status = 'approved' and s.valid_to is null
      join runs r on r.id = o.run_id
      order by o.from_source_id, r.created_at desc, r.id desc
    )
    select o.to_domain as domain, count(distinct o.from_source_id)::int as n
    from outlinks o join newest w on w.from_source_id = o.from_source_id and w.run_id = o.run_id
    where o.count > 0
    group by o.to_domain
    having count(distinct o.from_source_id) >= ${cfg.minLinkingSources}
  `);

  const linkingSources = new Map(linked.rows.map((r) => [r.domain, r.n]));
  let domains = [...new Set([...serp.rows.map((r) => r.domain), ...linkingSources.keys()])].filter(
    (d) => !ignored(d, cfg.ignoreDomains),
  );
  if (domains.length === 0) return [];
  const known = await db.select({ domain: sources.domain }).from(sources).where(inArray(sources.domain, domains));
  const knownSet = new Set(known.map((k) => k.domain));
  domains = domains.filter((d) => !knownSet.has(d)).sort(cmp);
  if (domains.length === 0) return [];

  const hits = await db.execute<SerpHit & { domain: string }>(sql`
    select distinct on (q.keyword, q.language_code, q.location_code, r.url_normalized)
      r.domain, r.url, q.keyword, q.language_code as "languageCode", r.rank, r.title, r.snippet
    from serp_results r join serp_queries q on q.id = r.serp_query_id
    where r.domain in (${sql.join(
      domains.map((d) => sql`${d}`),
      sql`, `,
    )})
    order by q.keyword, q.language_code, q.location_code, r.url_normalized, q.fetched_at desc, r.rank
  `);
  const byDomain = new Map<string, SerpHit[]>();
  for (const { domain, ...hit } of hits.rows) {
    const list = byDomain.get(domain) ?? [];
    list.push(hit);
    byDomain.set(domain, list);
  }
  return domains.map((domain) => ({
    domain,
    hits: (byDomain.get(domain) ?? []).sort((a, b) => a.rank - b.rank || cmp(a.url, b.url)),
    linkingSources: linkingSources.get(domain) ?? 0,
  }));
}

/**
 * robots.txt summary of `origin` for the run; a robots.txt that cannot be read (also one the address guard of the
 * crawl transport refuses) is `unavailable`, not an error.
 */
async function proposalRobots(
  db: Db,
  deps: { transport: Transport; archive: Archive },
  origin: string,
  startUrls: string[],
  ctx: CallContext & { runId: string },
): Promise<ProposalRobots> {
  try {
    const policy = await robotsForRun(db, deps.archive, deps.transport, origin, ctx.runId, ctx);
    return robotsSummary(policy, startUrls);
  } catch (error) {
    if (!(error instanceof RetryableHttpError || error instanceof HttpError || error instanceof BlockedUrlError)) throw error;
    getLog().warn({ origin, err: error }, "robots.txt unavailable for a source proposal");
    return { status: "unavailable" };
  }
}

/**
 * Proposes every candidate of `domainCandidates`: a `proposed` source (name = domain, suggested type, weight and
 * change rate from `sourceTypes`, crawl rules from the hit URLs, languages = the hits' query languages by
 * frequency, origin `serp` with enough hits, else `linkgraph`) and an open `source_approval` task with the hits
 * (best `maxHitsInContext` by rank, `hitCount` = all of them), linking sources, languages, robots.txt summary of the most frequent host and
 * the suggestion; priority = hits + 2 × linking sources. A linkgraph-only domain is judged by `https://<domain>/`.
 * A domain that got a valid source meanwhile (domain index conflict) is skipped.
 */
export async function proposeSources(
  db: Db,
  deps: { transport: Transport; archive: Archive },
  ctx: CallContext & { runId: string },
  cfg: AppConfig = getConfig(),
): Promise<{ proposed: number; skipped: number }> {
  const p = cfg.discovery.proposals;
  let proposed = 0;
  let skipped = 0;
  for (const candidate of await domainCandidates(db, p)) {
    const urls = candidate.hits.length > 0 ? candidate.hits.map((h) => h.url) : [`https://${candidate.domain}/`];
    const type = suggestType(urls, p);
    const crawlRules = suggestCrawlRules(urls);
    const { weight, changeRate } = cfg.sourceTypes[type];
    const languages = byFrequency(candidate.hits.map((h) => h.languageCode)).map((l) => l.value);
    const origin: SourceOrigin = candidate.hits.length >= p.minSerpHits ? "serp" : "linkgraph";
    const robotsOrigin = new URL(crawlRules.startUrls[0] ?? `https://${candidate.domain}/`).origin;
    const robots = await proposalRobots(db, deps, robotsOrigin, crawlRules.startUrls, ctx);

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(sources)
        .values({
          domain: candidate.domain,
          name: candidate.domain,
          type,
          weight,
          changeRate,
          languages,
          crawlRules,
          status: "proposed",
          origin,
        })
        .onConflictDoNothing({ target: sources.domain, where: sql`${sources.validTo} is null` })
        .returning({ id: sources.id });
      if (!row) return false;
      await createReviewTask(tx, {
        kind: "source_approval",
        subjectType: "source",
        subjectId: row.id,
        context: {
          hits: candidate.hits.slice(0, p.maxHitsInContext),
          hitCount: candidate.hits.length,
          linkingSources: candidate.linkingSources,
          languages,
          robots,
          suggestion: { type, weight, changeRate, crawlRules },
        },
        priority: candidate.hits.length + 2 * candidate.linkingSources,
      });
      return true;
    });
    if (created) proposed += 1;
    else skipped += 1;
  }
  return { proposed, skipped };
}
