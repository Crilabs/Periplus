import { gfm } from "@joplin/turndown-plugin-gfm";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { FetchConfig } from "@/lib/config";
import { recordExternalCall } from "@/lib/domain/costs";
import { waitForRateToken, type CallContext, type RateLimit } from "../http";
import type { Converter, ConvertInput, RenderPage } from "./types";

/** Elements that never carry page content. */
const ALWAYS_REMOVED = "script, style, noscript, iframe";

let turndown: TurndownService | undefined;

function getTurndown(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
    turndown.use(gfm);
  }
  return turndown;
}

function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function removeAll(document: ReturnType<typeof parseHTML>["document"], selector: string): void {
  let nodes;
  try {
    nodes = document.querySelectorAll(selector);
  } catch (error) {
    throw new Error(`invalid boilerplate selector "${selector}": ${(error as Error).message}`, { cause: error });
  }
  for (const node of nodes) node.remove();
}

/**
 * Main content of an HTML page as Markdown: removes `script, style, noscript, iframe` and the `selectors`
 * (an invalid selector is an error), extracts the article with Readability (relative links resolved against
 * `<base href>`, else `url`) and converts it with Turndown (ATX headings, fenced code, GFM tables). The title
 * leads as `# <title>`, since Readability takes the page's `h1` out of the article. When Readability finds
 * no article, the whole body is converted and `mainChars` is 0.
 *
 * `mainChars` is the length of the article text without whitespace (the `render: auto` measure).
 */
export function htmlToMarkdown(html: string, url: string, selectors: string[]): { markdown: string; title: string | null; mainChars: number } {
  const { markdown, title, mainChars } = convertHtml(html, url, selectors);
  return { markdown, title, mainChars };
}

/** `htmlToMarkdown` plus the published date Readability reads from the metadata (`article:published_time` …). */
function convertHtml(html: string, url: string, selectors: string[]) {
  const { document } = parseHTML(html);
  removeAll(document, ALWAYS_REMOVED);
  for (const selector of selectors) removeAll(document, selector);

  const baseHref = document.querySelector("base[href]")?.getAttribute("href");
  const base = (baseHref && resolveUrl(baseHref, url)) || url;
  // linkedom has no base URI; Readability resolves links against these two.
  Object.defineProperty(document, "baseURI", { value: base, configurable: true });
  Object.defineProperty(document, "documentURI", { value: url, configurable: true });
  const fallbackTitle = document.querySelector("title")?.textContent?.trim() || null;
  const bodyHtml = document.body?.innerHTML ?? "";

  const article = new Readability(document as unknown as Document).parse();
  const title = article?.title?.trim() || fallbackTitle;
  const mainChars = article?.textContent ? article.textContent.replace(/\s/g, "").length : 0;
  let markdown = getTurndown().turndown(article?.content ?? bodyHtml).trim();
  if (title && !markdown.startsWith(`# ${title}`)) markdown = markdown ? `# ${title}\n\n${markdown}` : `# ${title}`;
  return { markdown, title, mainChars, publishedHint: article?.publishedTime?.trim() || null };
}

/**
 * Converts locally (Readability + Turndown, no cost). With a `renderPage`, the page is rendered in the browser
 * when `render` is `always`, when no HTML was fetched, or when `render` is `auto` and the fetched HTML has less
 * main text than `cfg.renderMinMainChars`; `never` never renders. Without `renderPage` it never renders (the
 * web process has no browser). A render first waits for a token of `input.rate` (the domain's crawl bucket) and is
 * recorded as a free `playwright` call.
 */
export function createLocalConverter(deps: { renderPage?: RenderPage; cfg: FetchConfig }): Converter {
  const { renderPage, cfg } = deps;

  async function render(url: string, rate: RateLimit | undefined, ctx: CallContext): Promise<{ html: string; finalUrl: string }> {
    if (rate) await waitForRateToken(ctx.db, rate);
    const page = await renderPage!(url, { timeoutMs: cfg.timeoutMs });
    await recordExternalCall(ctx.db, {
      service: "playwright",
      operation: "render",
      units: 1,
      unit: "request",
      costEur: 0,
      runId: ctx.runId,
      tileId: ctx.tileId,
      stage: ctx.stage,
      sourceId: ctx.sourceId,
      meta: { url, status: page.status, finalUrl: page.finalUrl, bytes: page.html.length },
    });
    return page;
  }

  return {
    name: "local",
    async convert(input: ConvertInput, ctx: CallContext) {
      const started = performance.now();
      const mayRender = renderPage !== undefined && input.render !== "never";
      let html = input.html;
      let base = input.url;
      let rendered = false;
      if (mayRender && (input.render === "always" || html === null)) {
        ({ html, finalUrl: base } = await render(input.url, input.rate, ctx));
        rendered = true;
      }
      if (html === null) throw new Error(`local converter got no HTML for ${input.url} and may not render it`);

      let result = convertHtml(html, base, input.boilerplateSelectors);
      if (mayRender && !rendered && input.render === "auto" && result.mainChars < cfg.renderMinMainChars) {
        ({ html, finalUrl: base } = await render(input.url, input.rate, ctx));
        rendered = true;
        result = convertHtml(html, base, input.boilerplateSelectors);
      }
      return {
        markdown: result.markdown,
        title: result.title,
        publishedHint: result.publishedHint,
        rendered,
        durationMs: Math.round(performance.now() - started),
        costEur: 0,
        ...(rendered ? { finalUrl: base } : {}),
      };
    },
  };
}
