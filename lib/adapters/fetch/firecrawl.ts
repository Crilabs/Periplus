import type { FetchConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { httpCall, RetryableHttpError, type HttpResponse, type Transport } from "../http";
import { assertNotSimulated } from "../simulation";
import { BlockedUrlError, isPublicUrlLiteral } from "./ssrf";
import { ConverterServiceError, serviceCall, TargetHttpError, type Converter } from "./types";

type FirecrawlAnswer = {
  success?: unknown;
  error?: unknown;
  data?: { markdown?: unknown; metadata?: Record<string, unknown> | null } | null;
};

function parse(res: HttpResponse): FirecrawlAnswer {
  try {
    const answer = JSON.parse(res.text()) as FirecrawlAnswer;
    if (typeof answer !== "object" || answer === null) throw new Error("not an object");
    return answer;
  } catch (error) {
    throw new RetryableHttpError("firecrawl returned an unreadable answer", res.status, { cause: error });
  }
}

/** Credits Firecrawl bills for a successful answer (`data.metadata.creditsUsed`, else 1); nothing for a failed one. */
function creditsOf(res: HttpResponse): number {
  if (res.status < 200 || res.status > 299) return 0;
  const answer = parse(res);
  if (answer.success !== true) return 0;
  const credits = answer.data?.metadata?.creditsUsed;
  return typeof credits === "number" && credits >= 0 ? credits : 1;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Firecrawl scrape: POST main-content Markdown for the URL, the boilerplate selectors as `excludeTags`.
 * Charged against the daily `firecrawl` budget at `(creditsUsed ?? 1) × eurPerCredit`. `success: false` and
 * Firecrawl's own 4xx (wrong key, no credit) are a `ConverterServiceError`; a target page Firecrawl reports with a 4xx
 * status is a `TargetHttpError` (5xx: `RetryableHttpError`).
 */
export function createFirecrawlConverter(transport: Transport, cfg: FetchConfig["firecrawl"]): Converter {
  return {
    name: "firecrawl",
    async convert(input, ctx) {
      assertNotSimulated("firecrawl", "convert");
      const started = performance.now();
      if (!isPublicUrlLiteral(input.url)) throw new BlockedUrlError(input.url);
      const key = getEnv().FIRECRAWL_API_KEY;
      if (!key) throw new Error("FIRECRAWL_API_KEY is not set");
      const costOf = (res: HttpResponse) => {
        const credits = creditsOf(res);
        return { units: credits, unit: "credits", costEur: credits * cfg.eurPerCredit };
      };
      const res = await serviceCall("firecrawl", () =>
        httpCall(
          transport,
          {
            service: "firecrawl",
            operation: "scrape",
            url: cfg.endpoint,
            method: "POST",
            body: JSON.stringify({ url: input.url, formats: ["markdown"], onlyMainContent: true, excludeTags: input.boilerplateSelectors }),
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            timeoutMs: cfg.timeoutMs,
            budget: "firecrawl",
            costOf,
            meta: { url: input.url },
          },
          ctx,
        ),
      );
      const answer = parse(res);
      if (answer.success !== true) {
        throw new ConverterServiceError(`firecrawl scrape of ${input.url} failed: ${text(answer.error) ?? "success false"}`);
      }
      const metadata = answer.data?.metadata ?? {};
      const pageStatus = metadata.statusCode;
      if (typeof pageStatus === "number" && pageStatus >= 400) {
        const message = `firecrawl: ${input.url} answered HTTP ${pageStatus}`;
        if (pageStatus === 429 || pageStatus >= 500) throw new RetryableHttpError(message, pageStatus);
        throw new TargetHttpError(message, pageStatus);
      }
      if (typeof answer.data?.markdown !== "string") throw new RetryableHttpError(`firecrawl answer for ${input.url} has no markdown`, res.status);
      return {
        markdown: answer.data.markdown.trim(),
        title: text(metadata.title) ?? text(metadata.ogTitle),
        publishedHint: text(metadata.publishedTime) ?? text(metadata["article:published_time"]),
        rendered: false,
        durationMs: Math.round(performance.now() - started),
        costEur: costOf(res).costEur,
      };
    },
  };
}
