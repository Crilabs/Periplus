import type { CrawlRules } from "@/lib/domain/sources/crawl-rules";
import type { CallContext, RateLimit } from "../http";

export type ConverterName = "jina" | "firecrawl" | "local";

export type ConvertInput = {
  url: string;
  /** The page's HTML as fetched over HTTP; `null` when the converter fetches (or renders) the page itself. */
  html: string | null;
  /** CSS selectors removed before conversion (crawl rule `boilerplateSelectors`). */
  boilerplateSelectors: string[];
  render: CrawlRules["render"];
  /** Rate bucket a page render waits for (the crawl's per-domain bucket), so renders count like requests. */
  rate?: RateLimit;
};

export type Converted = {
  markdown: string;
  title: string | null;
  /** Publication date as the page states it (unparsed), if the converter found one. */
  publishedHint: string | null;
  /** Whether Periplus rendered the page in its own browser (Playwright) before converting it. */
  rendered: boolean;
  durationMs: number;
  /** Cost of this conversion as booked in `external_calls` (`local`: 0). */
  costEur: number;
};

export interface Converter {
  name: ConverterName;
  convert(input: ConvertInput, ctx: CallContext): Promise<Converted>;
}

/** Loads a page in a browser with JavaScript and returns the resulting DOM as HTML. */
export type RenderPage = (url: string, opts: { timeoutMs: number }) => Promise<{ html: string; finalUrl: string; status: number }>;
