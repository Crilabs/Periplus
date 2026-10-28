import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { structuredOutputSchema } from "../../../lib/ai/anthropic";
import { getConfig } from "../../../lib/config";
import { locateQuote } from "../../../lib/domain/research/text/quote";
import { firstWords } from "../../../lib/domain/research/util/dates";
import type { Assessment } from "./assess";
import { parseFlags, type Command } from "./cli";
import { coordinatesIn, parseCoordinate, type Coord } from "./coords";
import { CostLedger } from "./costs";
import type { PageRow } from "./fetch";
import { searchCostEur } from "./search-claude";
import { appendJsonl, readJsonl } from "./store";

/*
 * Spec 5C: per counting page, every berth the page describes, each with a verbatim quote that proves it is a berth,
 * a coordinate only when the page states one (quoted), and a quoted position description. Quotes are checked with
 * the pipeline's `locateQuote`; what fails the check is dropped (berth) or nulled (coordinate, position).
 */

export const EXTRACT_MODEL = "claude-sonnet-5-5";

const mentionKinds = ["anchorage", "mooring_field", "port", "marina", "unknown"] as const;

export const extractionSchema = z.object({
  mentions: z.array(
    z.object({
      name: z.string(),
      aliases: z.array(z.string()),
      area: z.string().nullable(),
      kind: z.enum(mentionKinds),
      coordinate_text: z.string().nullable(),
      coordinate_quote: z.string().nullable(),
      position_quote: z.string().nullable(),
      berth_quote: z.string(),
    }),
  ),
});

export type ExtractionOutput = z.infer<typeof extractionSchema>;

export type Mention = {
  url: string;
  domain: string;
  name: string;
  aliases: string[];
  area: string | null;
  kind: (typeof mentionKinds)[number];
  coordinate: Coord | null;
  coordinateQuote: string | null;
  positionQuote: string | null;
  berthQuote: string;
  firstHand: boolean;
  pageKind: string;
};

type PageMeta = { url: string; domain: string; first_hand: boolean; page_kind: string };

export function validateMentions(
  raw: ExtractionOutput,
  markdown: string,
  page: PageMeta,
  quoteCfg: { minChars: number; maxChars: number },
): { mentions: Mention[]; dropped: Array<{ name: string; reason: string }> } {
  const mentions: Mention[] = [];
  const dropped: Array<{ name: string; reason: string }> = [];
  const check = (quote: string | null): string | null => {
    if (quote === null || quote.trim() === "") return null;
    const r = locateQuote(markdown, quote, quoteCfg);
    return r.ok ? quote : `${r.reason}`;
  };
  for (const m of raw.mentions) {
    if (!m.name.trim()) {
      dropped.push({ name: m.name, reason: "no name" });
      continue;
    }
    const berth = locateQuote(markdown, m.berth_quote, quoteCfg);
    if (!berth.ok) {
      dropped.push({ name: m.name, reason: `berth_quote ${berth.reason}` });
      continue;
    }
    let coordinate: Coord | null = null;
    let coordinateQuote: string | null = null;
    if (m.coordinate_text && m.coordinate_quote) {
      const q = locateQuote(markdown, m.coordinate_quote, quoteCfg);
      const parsed = parseCoordinate(m.coordinate_text);
      // the quote must hold the coordinate itself, not only talk about one
      if (q.ok && parsed && coordinatesIn(m.coordinate_quote).length > 0) {
        coordinate = parsed;
        coordinateQuote = m.coordinate_quote;
      }
    }
    const position = check(m.position_quote);
    mentions.push({
      url: page.url,
      domain: page.domain,
      name: m.name.trim(),
      aliases: m.aliases.map((a) => a.trim()).filter((a) => a && a !== m.name.trim()),
      area: m.area?.trim() || null,
      kind: m.kind,
      coordinate,
      coordinateQuote,
      positionQuote: position !== null && !/^(not_found|too_short|too_long|ellipsis|empty)$/.test(position) ? position : null,
      berthQuote: m.berth_quote,
      firstHand: page.first_hand,
      pageKind: page.page_kind,
    });
  }
  return { mentions, dropped };
}

export type ExtractRow = { url: string; mentions: number; dropped: Array<{ name: string; reason: string }>; regexCoords: number; costEur: number; error?: string };

async function systemPrompt(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFile(path.join(here, "prompts", "extract-anchorages.md"), "utf8");
}

/** Every counting, not generated page without a row in `extract.jsonl`; writes `mentions.jsonl` and `extract.jsonl`. */
export async function runExtract(ledger: CostLedger, dir: string, opts: { limit?: number } = {}): Promise<void> {
  const cfg = getConfig();
  const counting = new Set<string>(cfg.research.confirmation.countingPageKinds);
  const quoteCfg = cfg.extraction.quote;
  const client = new Anthropic();
  const system = await systemPrompt();
  const schema = structuredOutputSchema(z.toJSONSchema(extractionSchema)) as Record<string, unknown>;
  const pages = new Map((await readJsonl<PageRow>(dir, "pages.jsonl")).filter((p) => !p.error).map((p) => [p.url, p]));
  const done = new Set((await readJsonl<ExtractRow>(dir, "extract.jsonl")).map((r) => r.url));
  const todo = (await readJsonl<Assessment>(dir, "assessments.jsonl")).filter((a) => !a.error && counting.has(a.page_kind) && !a.generated && !done.has(a.url) && pages.has(a.url));
  let budget = opts.limit ?? Number.POSITIVE_INFINITY;
  let n = 0;
  for (const a of todo) {
    if (budget-- <= 0) break;
    const page = pages.get(a.url)!;
    const markdown = await readFile(path.join(dir, "pages", page.file), "utf8");
    const text = firstWords(markdown, cfg.research.extraction.maxUnitWords);
    ledger.assertRoom(0.05);
    let row: ExtractRow;
    try {
      const message = await client.messages.create({
        model: EXTRACT_MODEL,
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content: `URL: ${a.url}\nPage kind: ${a.page_kind}\nFirst hand: ${a.first_hand}\n\n<page>\n${text}\n</page>` }],
        output_config: { effort: "medium", format: { type: "json_schema", schema } },
      });
      const costEur = searchCostEur(message.usage);
      await ledger.add({ stage: "extract", service: "anthropic", units: 1, costEur });
      const textOut = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const parsed = extractionSchema.safeParse(JSON.parse(textOut));
      if (!parsed.success) {
        row = { url: a.url, mentions: 0, dropped: [], regexCoords: coordinatesIn(markdown).length, costEur, error: `invalid output: ${parsed.error.message.slice(0, 200)}` };
      } else {
        const { mentions, dropped } = validateMentions(parsed.data, markdown, { url: a.url, domain: page.domain, first_hand: a.first_hand, page_kind: a.page_kind }, quoteCfg);
        await appendJsonl(dir, "mentions.jsonl", mentions);
        row = { url: a.url, mentions: mentions.length, dropped, regexCoords: coordinatesIn(markdown).length, costEur };
      }
    } catch (error) {
      if (error instanceof Anthropic.APIError && error.status === 400) {
        row = { url: a.url, mentions: 0, dropped: [], regexCoords: 0, costEur: 0, error: `API 400: ${error.message.slice(0, 200)}` };
      } else throw error;
    }
    await appendJsonl(dir, "extract.jsonl", [row]);
    n++;
    process.stdout.write(`extract ${String(n).padStart(4)}/${todo.length} ${row.mentions} mentions, ${row.dropped.length} dropped, ${row.regexCoords} coords, ${row.costEur.toFixed(3)} EUR  ${a.url.slice(0, 80)}${row.error ? `  ERROR ${row.error}` : ""}\n`);
  }
}

export const extractCommand: Command = async (args, dir) => {
  const flags = parseFlags(args);
  const ledger = await CostLedger.open(dir);
  await runExtract(ledger, dir, { limit: typeof flags.limit === "string" ? Number(flags.limit) : undefined });
  process.stdout.write(`spent ${ledger.totalEur.toFixed(3)} EUR\n`);
};
