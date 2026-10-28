import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../../../lib/config";
import type { Area } from "./areas";
import type { CostLedger } from "./costs";
import { isSkippedDomain, registrableDomainOf, resolveBlockedDomains } from "./domains";
import type { Hit, SearchOpts } from "./search-dataforseo";
import { appendJsonl, readJsonl } from "./store";

/*
 * Engine C (spec 5A): one agentic request per area with the server web search tool. The model only hands back URLs;
 * fetching, assessment and extraction run the same way as for engine D. Direct SDK use is the pilot's ruling
 * (spec 10.4): the repo's model client knows no server tools.
 */

export const SEARCH_MODEL = "claude-sonnet-5-5";
const MAX_SEARCHES = 12;
/** Assumption (spec 9): 0.01 $ per search, Sonnet 5.5 token prices, 0.92 €/$. Check against the price sheet before the run. */
const USD_PER_SEARCH = 0.01;
const USD_PER_MTOK = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const EUR_PER_USD = 0.92;

export type ParsedSearch = { queries: string[]; results: Array<{ url: string; title: string | null }>; chosen: string[] };

export function parseSearchMessage(message: Anthropic.Message): ParsedSearch {
  const queries: string[] = [];
  const results: ParsedSearch["results"] = [];
  let text = "";
  for (const block of message.content) {
    if (block.type === "server_tool_use" && block.name === "web_search") {
      const q = (block.input as { query?: unknown } | null)?.query;
      if (typeof q === "string") queries.push(q);
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r.type === "web_search_result") results.push({ url: r.url, title: r.title || null });
    } else if (block.type === "text") text += block.text;
  }
  const chosen: string[] = [];
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (last) {
    try {
      const parsed = JSON.parse(last) as { urls?: unknown };
      if (Array.isArray(parsed.urls)) for (const u of parsed.urls) if (typeof u === "string") chosen.push(u);
    } catch {
      // no valid JSON block: the raw results still count
    }
  }
  return { queries, results, chosen };
}

export function searchCostEur(usage: Anthropic.Usage): number {
  const usd =
    (usage.input_tokens * USD_PER_MTOK.input +
      usage.output_tokens * USD_PER_MTOK.output +
      (usage.cache_read_input_tokens ?? 0) * USD_PER_MTOK.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * USD_PER_MTOK.cacheWrite) /
      1e6 +
    (usage.server_tool_use?.web_search_requests ?? 0) * USD_PER_SEARCH;
  return usd * EUR_PER_USD;
}

function systemPrompt(): string {
  return [
    "You find web pages for Periplus, a data service about berths for sailing yachts.",
    "Task: find pages that describe anchorages, mooring fields or harbours in the given area for sailors: cruising guides,",
    "pilot pages, trip reports (blogs, logbooks), forum threads. Search in English, German and Greek; vary the wording",
    `(anchorages, best anchorages, sailing itinerary, Ankerplätze, Ankerbuchten, Törnbericht, αγκυροβόλια). Use at most ${MAX_SEARCHES} searches.`,
    "Pages for beachgoers, hotels, tours or real estate are not wanted. Do not reproduce page contents.",
    'End your answer with one JSON code block ```json {"urls": [...]} ``` listing the 10 to 25 most useful page URLs you found, best first.',
  ].join(" ");
}

type AreaRun = { area: string; queries: string[]; results: number; kept: number; chosen: number; costEur: number; stopReason: string | null };

/** Engine C: one request per area; finished areas (`queries-c.jsonl`) are skipped. */
export async function runSearchC(ledger: CostLedger, dir: string, areas: Area[], opts: SearchOpts = {}): Promise<void> {
  const cfg = getConfig();
  const client = new Anthropic();
  const blocked = resolveBlockedDomains(cfg.research.skipDomains);
  const finished = new Set((await readJsonl<AreaRun>(dir, "queries-c.jsonl")).map((r) => r.area));
  let budget = opts.limit ?? Number.POSITIVE_INFINITY;
  for (const area of areas) {
    if (finished.has(area.key) || (opts.area && area.key !== opts.area)) continue;
    if (budget-- <= 0) break;
    ledger.assertRoom(0.6);
    const names = [area.names.en, area.names.de, area.names.el].filter((n): n is string => !!n).join(" / ");
    const message = await client.messages.create({
      model: SEARCH_MODEL,
      max_tokens: 8000,
      system: systemPrompt(),
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES, blocked_domains: blocked }],
      messages: [{ role: "user", content: `Area: ${names} (Greece). Find the pages and end with the JSON block.` }],
    });
    const costEur = searchCostEur(message.usage);
    await ledger.add({ stage: "search-c", service: "anthropic", units: message.usage.server_tool_use?.web_search_requests ?? 0, costEur });
    const parsed = parseSearchMessage(message);
    const chosen = new Set(parsed.chosen);
    const hits: Hit[] = [];
    const seen = new Set<string>();
    parsed.results.forEach((r, i) => {
      if (seen.has(r.url)) return;
      seen.add(r.url);
      let domain: string;
      try {
        domain = registrableDomainOf(r.url);
      } catch {
        return;
      }
      if (isSkippedDomain(domain, cfg.research.skipDomains)) return;
      hits.push({ url: r.url, domain, engine: "c", area: area.key, lang: "any", keyword: parsed.queries.join(" | ").slice(0, 200), rank: i + 1, chosen: chosen.has(r.url) });
    });
    // URLs the model lists without a matching result block (it may cite from memory): kept, but marked by rank 0.
    for (const u of parsed.chosen) {
      if (seen.has(u)) continue;
      seen.add(u);
      try {
        const domain = registrableDomainOf(u);
        if (!isSkippedDomain(domain, cfg.research.skipDomains)) hits.push({ url: u, domain, engine: "c", area: area.key, lang: "any", keyword: "(chosen only)", rank: 0, chosen: true });
      } catch {
        // unusable URL
      }
    }
    await appendJsonl(dir, "hits.jsonl", hits);
    const run: AreaRun = { area: area.key, queries: parsed.queries, results: parsed.results.length, kept: hits.length, chosen: chosen.size, costEur, stopReason: message.stop_reason };
    await appendJsonl(dir, "queries-c.jsonl", [run]);
    process.stdout.write(`c ${area.key.padEnd(26)} ${parsed.queries.length} searches, ${parsed.results.length} results → ${hits.length} kept, ${chosen.size} chosen, ${costEur.toFixed(3)} EUR, ${message.stop_reason}\n`);
    for (const q of parsed.queries) process.stdout.write(`    ${q}\n`);
  }
}
