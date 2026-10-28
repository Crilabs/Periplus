import { searchOrganic } from "../../../lib/adapters/dataforseo";
import { HttpError, RetryableHttpError, getTransport } from "../../../lib/adapters/http";
import { getConfig } from "../../../lib/config";
import type { Db } from "../../../lib/db/client";
import { buildQueries, type Area, type Query } from "./areas";
import type { CostLedger } from "./costs";
import { isSkippedDomain, registrableDomainOf } from "./domains";
import { appendJsonl, readJsonl } from "./store";

/** One search result of either engine (spec 5A); `chosen` only for engine `c` (the model's own pick). */
export type Hit = { url: string; domain: string; engine: "d" | "c"; area: string; lang: string; keyword: string; rank: number; chosen?: boolean };

/** Spec 5A: 40 results per query. */
const DEPTH = 40;

export type SearchOpts = { limit?: number; area?: string };

/** Engine D: every query of `buildQueries` once through DataForSEO; finished keywords (`queries-d.jsonl`) are skipped. */
export async function runSearchD(db: Db, ledger: CostLedger, dir: string, areas: Area[], opts: SearchOpts = {}): Promise<void> {
  const cfg = getConfig();
  const serp = { ...cfg.discovery.serp, depth: DEPTH };
  const finished = new Set((await readJsonl<Query>(dir, "queries-d.jsonl")).map((q) => q.keyword));
  let budget = opts.limit ?? Number.POSITIVE_INFINITY;
  for (const q of buildQueries(areas)) {
    if (finished.has(q.keyword) || (opts.area && q.area !== opts.area)) continue;
    if (budget-- <= 0) break;
    const locationCode = cfg.research.locationCodes[q.lang];
    if (!locationCode) throw new Error(`no locationCode for ${q.lang}`);
    ledger.assertRoom(serp.costPerQueryEur);
    let items: Awaited<ReturnType<typeof searchOrganic>>["items"];
    try {
      ({ items } = await searchOrganic(getTransport(), { keyword: q.keyword, languageCode: q.lang, locationCode }, { db, stage: "lab.search" }, serp));
    } catch (error) {
      // Ruling (Task 10): a query DataForSEO keeps failing on (40101 after the adapter's retries) is recorded and skipped;
      // the run must not stop on one search.
      if (!(error instanceof HttpError || error instanceof RetryableHttpError)) throw error;
      await ledger.add({ stage: "search-d", service: "dataforseo", units: 1, costEur: serp.costPerQueryEur });
      await appendJsonl(dir, "queries-d.jsonl", [{ ...q, results: 0, kept: 0, error: error.message.slice(0, 160) }]);
      process.stdout.write(`d ${q.area.padEnd(26)} ${q.lang} FAILED ${error.message.slice(0, 100)}\n`);
      continue;
    }
    await ledger.add({ stage: "search-d", service: "dataforseo", units: 1, costEur: serp.costPerQueryEur });
    const hits: Hit[] = [];
    for (const it of items) {
      let domain: string;
      try {
        domain = registrableDomainOf(it.url);
      } catch {
        continue;
      }
      if (isSkippedDomain(domain, cfg.research.skipDomains)) continue;
      hits.push({ url: it.url, domain, engine: "d", area: q.area, lang: q.lang, keyword: q.keyword, rank: it.rank });
    }
    await appendJsonl(dir, "hits.jsonl", hits);
    await appendJsonl(dir, "queries-d.jsonl", [{ ...q, results: items.length, kept: hits.length }]);
    process.stdout.write(`d ${q.area.padEnd(26)} ${q.lang} ${String(items.length).padStart(3)} → ${String(hits.length).padStart(3)}  ${q.keyword}\n`);
  }
}
