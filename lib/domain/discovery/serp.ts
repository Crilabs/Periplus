import { createHash } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { searchOrganic } from "@/lib/adapters/dataforseo";
import type { CallContext, Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { serpQueries, serpResults } from "@/lib/db/schema";
import { normalizeUrl, registrableDomain } from "@/lib/domain/sources/urls";
import type { DiscoveryQuery } from "./queries";

const DAY_MS = 86_400_000;

/** S3 key of a raw SERP answer: `serp/<YYYY-MM-DD>/<sha256(keyword|language|location)>.json` (UTC day). */
export function serpRawKey(q: Pick<DiscoveryQuery, "keyword" | "languageCode" | "locationCode">, at: Date): string {
  const hash = createHash("sha256").update(`${q.keyword}|${q.languageCode}|${q.locationCode}`).digest("hex");
  return `serp/${at.toISOString().slice(0, 10)}/${hash}.json`;
}

/**
 * Runs one discovery query. The same `(keyword, language, location)` searched within `reuseDays` is reused
 * (no call, no row). Otherwise searches (a tile query with `ctx.tileId` = its tile, a place or place website query
 * with the place's tile `q.tileId`, so costs show per tile),
 * archives the raw answer under `serpRawKey` and writes one `serp_queries` row with its organic `serp_results`
 * (results whose URL is not http(s) are skipped).
 */
export async function runQuery(
  db: Db,
  q: DiscoveryQuery,
  deps: { transport: Transport; archive: Archive; now?: Date },
  ctx: CallContext,
): Promise<{ queryId: string; reused: boolean; results: number }> {
  const { discovery, fetch } = getConfig();
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - discovery.serp.reuseDays * DAY_MS);

  const [prior] = await db
    .select({ id: serpQueries.id })
    .from(serpQueries)
    .where(
      and(
        eq(serpQueries.keyword, q.keyword),
        eq(serpQueries.languageCode, q.languageCode),
        eq(serpQueries.locationCode, q.locationCode),
        gt(serpQueries.fetchedAt, since),
      ),
    )
    .orderBy(desc(serpQueries.fetchedAt))
    .limit(1);
  if (prior) {
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(serpResults)
      .where(eq(serpResults.serpQueryId, prior.id));
    return { queryId: prior.id, reused: true, results: count!.n };
  }

  const tileId = q.level === "tile" ? q.scopeId : q.level === "place" || q.level === "place_website" || q.level === "research" ? q.tileId : undefined;
  const callCtx = tileId ? { ...ctx, tileId } : ctx;
  const { raw, items } = await searchOrganic(deps.transport, q, callCtx, discovery.serp);
  const rawKey = serpRawKey(q, now);
  await deps.archive.put(rawKey, raw, "application/json");

  const [row] = await db
    .insert(serpQueries)
    .values({
      keyword: q.keyword,
      languageCode: q.languageCode,
      locationCode: q.locationCode,
      depth: discovery.serp.depth,
      level: q.level,
      scopeId: q.scopeId,
      rawKey,
      runId: ctx.runId ?? null,
      fetchedAt: now,
    })
    .returning({ id: serpQueries.id });

  const results = items.flatMap((item) => {
    const urlNormalized = normalizeUrl(item.url, fetch.trackingParams);
    if (!urlNormalized) return [];
    return [
      {
        serpQueryId: row!.id,
        rank: item.rank,
        url: item.url,
        urlNormalized,
        domain: registrableDomain(urlNormalized),
        title: item.title,
        snippet: item.snippet,
      },
    ];
  });
  if (results.length > 0) await db.insert(serpResults).values(results);
  return { queryId: row!.id, reused: false, results: results.length };
}
