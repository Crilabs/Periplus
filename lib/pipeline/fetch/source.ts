import { sql } from "drizzle-orm";
import type { CallContext, Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { crawlFrontier } from "@/lib/db/schema";
import { urlAllowed } from "@/lib/domain/sources/crawl-rules";
import { explicitBan, robotsForRun, robotsSummary, type RobotsSummary } from "@/lib/domain/sources/robots";
import { getSource, setSourceStatus } from "@/lib/domain/sources/store";
import { normalizeUrl } from "@/lib/domain/sources/urls";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

export const FETCH_SOURCE_STAGE = "fetch.source";

/** Status reason of a source paused because its robots.txt bans crawling (shown to the admin). */
export const ROBOTS_BAN_REASON = "robots.txt verbietet das Crawlen";

export type PreparedCrawl = { status: "ready" | "paused" | "not_approved"; startUrls: number; robots: RobotsSummary | null };

/**
 * Job `fetch.source`: prepares one approved source for the run. robots.txt is read anew for every host of the start
 * URLs (once per run, `robotsForRun`). A host with an explicit ban contributes no start URL; when every host bans,
 * the source is paused with `ROBOTS_BAN_REASON` (only if it is still approved). Otherwise every start URL that
 * robots.txt and the crawl rules allow is queued in the frontier at depth 0 (a known row is queued again). A source without start URLs starts at `https://<domain>/`. `robots` summarises the first host.
 */
export async function prepareSourceCrawl(
  db: Db,
  sourceId: string,
  deps: { transport: Transport; archive: Archive },
  ctx: CallContext & { runId: string },
): Promise<PreparedCrawl> {
  const source = await getSource(db, sourceId);
  if (!source || source.status !== "approved") return { status: "not_approved", startUrls: 0, robots: null };
  const rules = source.crawlRules;
  const startUrls = rules.startUrls.length > 0 ? rules.startUrls : [`https://${source.domain}/`];
  const callCtx = { ...ctx, db, sourceId };

  const origins = [...new Set(startUrls.map((u) => new URL(u).origin))];
  const policies = new Map<string, Awaited<ReturnType<typeof robotsForRun>>>();
  for (const origin of origins) policies.set(origin, await robotsForRun(db, deps.archive, deps.transport, origin, ctx.runId, callCtx));
  const first = policies.get(origins[0]!)!;
  const summary = robotsSummary(first, startUrls.filter((u) => new URL(u).origin === first.origin));

  const banned = new Set(origins.filter((origin) => explicitBan(policies.get(origin)!)));
  if (banned.size === origins.length) {
    // Only a source still approved: an admin's decision made meanwhile stands.
    await setSourceStatus(db, sourceId, "paused", ROBOTS_BAN_REASON, { from: "approved" });
    return { status: "paused", startUrls: 0, robots: summary };
  }

  const { trackingParams } = getConfig().fetch;
  const rows = startUrls.flatMap((url) => {
    const normalized = normalizeUrl(url, trackingParams);
    const origin = new URL(url).origin;
    const policy = policies.get(origin)!;
    if (!normalized || banned.has(origin) || !policy.isAllowed(normalized) || !urlAllowed(normalized, rules, source.domain).ok) return [];
    return [{ sourceId, url: normalized, urlNormalized: normalized, depth: 0, status: "queued" as const }];
  });
  const unique = [...new Map(rows.map((r) => [r.urlNormalized, r])).values()];
  if (unique.length > 0) {
    await db
      .insert(crawlFrontier)
      .values(unique)
      .onConflictDoUpdate({
        target: [crawlFrontier.sourceId, crawlFrontier.urlNormalized],
        set: { depth: 0, status: "queued", reason: null, updatedAt: sql`now()` },
      });
  }
  return { status: "ready", startUrls: unique.length, robots: summary };
}
