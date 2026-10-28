import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { htmlToMarkdown } from "../../../lib/adapters/fetch";
import { createJinaConverter } from "../../../lib/adapters/fetch/jina";
import { HttpError, RetryableHttpError, getTransport, httpCall, type CallContext } from "../../../lib/adapters/http";
import { runPdftotext } from "../../../lib/adapters/pdf";
import { getConfig } from "../../../lib/config";
import { createDb, type Db } from "../../../lib/db/client";
import { fetchRobots, type RobotsPolicy } from "../../../lib/domain/sources/robots";
import { parseFlags, type Command } from "./cli";
import type { Hit } from "./search-dataforseo";
import { appendJsonl, readJsonl } from "./store";

/*
 * Spec 5B: fetch every hit URL once and keep its Markdown in `pages/<sha1>.md`. The pipeline's fetch stage is bound to
 * sources, documents and the archive; here only the transport, the HTML converter, pdftotext and robots.txt are reused.
 * Rate: 20 requests per minute per registrable domain (the research crawl's `source.ratePerMinute`), tokens in the
 * local database.
 */

export type PageRow = { url: string; domain: string; file: string; title: string | null; chars: number; finalUrl: string | null; error?: string };

export type FetchResult = { markdown: string; title: string | null; finalUrl: string } | { error: string };

const THIN_PAGE_CHARS = 400;

const robotsCache = new Map<string, Promise<RobotsPolicy>>();

async function robotsFor(url: string, ctx: CallContext): Promise<RobotsPolicy> {
  const origin = new URL(url).origin;
  let p = robotsCache.get(origin);
  if (!p) {
    p = fetchRobots(getTransport(), origin, ctx).catch(() => ({ origin, status: "allow_all", text: null, crawlDelaySec: null, sitemaps: [], hasAllowRule: false, isAllowed: () => true }) as RobotsPolicy);
    robotsCache.set(origin, p);
  }
  return p;
}

export async function fetchToMarkdown(url: string, domain: string, ctx: CallContext): Promise<FetchResult> {
  const cfg = getConfig().fetch;
  try {
    const robots = await robotsFor(url, ctx);
    if (!robots.isAllowed(url)) return { error: "robots" };
    const res = await httpCall(
      getTransport(),
      { service: "lab-fetch", operation: "page", url, timeoutMs: cfg.timeoutMs, ratePerMinute: 20, rateKey: domain, maxBodyBytes: cfg.maxRawBytes, okStatuses: [404, 410] },
      ctx,
    );
    if (res.status === 404 || res.status === 410) return { error: `HTTP ${res.status}` };
    if (res.truncated) return { error: "too_large" };
    const type = (res.headers["content-type"] ?? "").toLowerCase();
    const finalUrl = res.finalUrl ?? url;
    if (type.includes("application/pdf") || url.toLowerCase().endsWith(".pdf")) {
      const text = await runPdftotext(res.body, { timeoutMs: cfg.timeoutMs });
      return { markdown: text, title: null, finalUrl };
    }
    const { markdown, title } = htmlToMarkdown(res.text(), finalUrl, []);
    // Ruling (Task 6): a page that yields almost no text locally (scripts build it; the worker would render it in a
    // browser) is fetched once more through Jina, which renders.
    if (markdown.length < THIN_PAGE_CHARS) {
      const jina = createJinaConverter(getTransport(), cfg.jina);
      const converted = await jina.convert({ url, html: null, boilerplateSelectors: [], render: "auto" }, ctx);
      if (converted.markdown.length > markdown.length) return { markdown: converted.markdown, title: converted.title ?? title, finalUrl: converted.finalUrl ?? finalUrl };
    }
    return { markdown, title, finalUrl };
  } catch (error) {
    if (error instanceof HttpError || error instanceof RetryableHttpError) return { error: `HTTP ${(error as HttpError).status ?? "?"}: ${error.message.slice(0, 120)}` };
    return { error: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
  }
}

export function pageFile(url: string): string {
  return `${createHash("sha1").update(url).digest("hex")}.md`;
}

export async function runFetch(db: Db, dir: string, opts: { limit?: number; concurrency?: number } = {}): Promise<void> {
  await mkdir(path.join(dir, "pages"), { recursive: true });
  const done = new Set((await readJsonl<PageRow>(dir, "pages.jsonl")).map((p) => p.url));
  const urls = new Map<string, string>();
  for (const h of await readJsonl<Hit>(dir, "hits.jsonl")) if (!done.has(h.url) && !urls.has(h.url)) urls.set(h.url, h.domain);
  const queue = [...urls.entries()].slice(0, opts.limit ?? urls.size);
  let n = 0;
  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [url, domain] = next;
      const result = await fetchToMarkdown(url, domain, { db, stage: "lab.fetch" });
      const file = pageFile(url);
      let row: PageRow;
      if ("error" in result) row = { url, domain, file, title: null, chars: 0, finalUrl: null, error: result.error };
      else {
        await writeFile(path.join(dir, "pages", file), result.markdown, "utf8");
        row = { url, domain, file, title: result.title, chars: result.markdown.length, finalUrl: result.finalUrl === url ? null : result.finalUrl };
      }
      await appendJsonl(dir, "pages.jsonl", [row]);
      n++;
      process.stdout.write(`fetch ${String(n).padStart(4)}/${queue.length + n} ${row.error ? `ERR ${row.error}` : `${row.chars} chars`}  ${url.slice(0, 90)}\n`);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
}

export const fetchCommand: Command = async (args, dir) => {
  const flags = parseFlags(args);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  try {
    await runFetch(db, dir, {
      limit: typeof flags.limit === "string" ? Number(flags.limit) : undefined,
      concurrency: typeof flags.concurrency === "string" ? Number(flags.concurrency) : undefined,
    });
  } finally {
    await close();
  }
};
