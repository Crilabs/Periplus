import { RetryableHttpError, type CallContext, type Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { runQuery } from "@/lib/domain/discovery/serp";
import type { DiscoveryQuery } from "@/lib/domain/search/queries";
import { createLogger } from "@/lib/logger";

export type SearchDeps = { transport: Transport; archive: Archive };

/** `queryIds`: the `serp_queries` of every query that was searched or reused, in query order. */
export type SearchSummary = { queries: number; searched: number; reused: number; failed: number; queryIds: string[] };

/**
 * Runs the queries one after another (`runQuery`: reuse within 30 days, else search and store). A query that still
 * fails transiently after the adapter's own attempts (`RetryableHttpError`, e.g. DataForSEO 40101) is logged and
 * skipped: it has no stored result, so the next run searches it again. When no query succeeded at all, the last
 * error is thrown, so the job is retried (an outage, not a single bad keyword). Other errors (budget, a wrong
 * request) end the job at once.
 */
export async function runQueries(db: Db, queries: DiscoveryQuery[], deps: SearchDeps, ctx: CallContext): Promise<SearchSummary> {
  let searched = 0;
  let reused = 0;
  let failed = 0;
  let lastError: unknown;
  const queryIds: string[] = [];
  for (const q of queries) {
    try {
      const result = await runQuery(db, q, deps, ctx);
      queryIds.push(result.queryId);
      if (result.reused) reused += 1;
      else searched += 1;
    } catch (error) {
      if (!(error instanceof RetryableHttpError)) throw error;
      failed += 1;
      lastError = error;
      createLogger("discovery").warn({ keyword: q.keyword, languageCode: q.languageCode, err: error }, "search skipped after transient errors");
    }
  }
  if (failed > 0 && searched + reused === 0) throw lastError;
  return { queries: queries.length, searched, reused, failed, queryIds };
}
