import type { CrawlRules } from "@/lib/domain/sources/crawl-rules";
import { HttpError, type CallContext, type RateLimit } from "../http";

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
  /** URL the page ended on when Periplus rendered it (scripts or a meta refresh may have moved it). */
  finalUrl?: string;
};

export interface Converter {
  name: ConverterName;
  convert(input: ConvertInput, ctx: CallContext): Promise<Converted>;
}

/** Loads a page in a browser with JavaScript and returns the resulting DOM as HTML. */
export type RenderPage = (url: string, opts: { timeoutMs: number }) => Promise<{ html: string; finalUrl: string; status: number }>;

/**
 * The page a converter service fetched for us answered a 4xx (Jina `data.httpStatus`, Firecrawl `metadata.statusCode`):
 * a verdict on the page, handled like the crawl's own `HttpError`.
 */
export class TargetHttpError extends HttpError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "TargetHttpError";
  }
}

/**
 * The converter service itself refused the call (its own 4xx such as 401/402/403 for a wrong key or no credit, or
 * Firecrawl `success: false`): not a verdict on the page. No `HttpError`, so a crawl job fails visibly (retries, then
 * a `failed_job` task) instead of marking the page failed.
 */
export class ConverterServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConverterServiceError";
  }
}

/** `httpCall` of a converter service: its own 4xx answer becomes a `ConverterServiceError`. */
export async function serviceCall<T>(service: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof HttpError) throw new ConverterServiceError(`${service}: ${error.message}`, { cause: error });
    throw error;
  }
}
