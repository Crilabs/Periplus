import type { FetchConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { HttpError, httpCall, RetryableHttpError, type HttpResponse, type Transport } from "../http";
import { BlockedUrlError, isPublicUrlLiteral } from "./ssrf";
import type { Converter } from "./types";

type JinaAnswer = {
  code?: unknown;
  data?: { title?: unknown; content?: unknown; publishedTime?: unknown; httpStatus?: unknown; usage?: { tokens?: unknown } } | null;
};

function parse(res: HttpResponse): JinaAnswer {
  try {
    const answer = JSON.parse(res.text()) as JinaAnswer;
    if (typeof answer !== "object" || answer === null) throw new Error("not an object");
    return answer;
  } catch (error) {
    throw new RetryableHttpError("jina returned an unreadable answer", res.status, { cause: error });
  }
}

/** Tokens Jina bills for an answer (its `data.usage.tokens`; 0 when the answer carries none). */
function tokensOf(res: HttpResponse): number {
  if (res.status < 200 || res.status > 299) return 0;
  const tokens = parse(res).data?.usage?.tokens;
  return typeof tokens === "number" && tokens > 0 ? tokens : 0;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Jina Reader: GET `<endpoint><url>` as JSON with Markdown content; the boilerplate selectors go into
 * `X-Remove-Selector`. Charged against the daily `jina` budget at `data.usage.tokens × eurPerMTok / 1e6`. A target
 * page Jina reports with a 4xx status (`data.httpStatus`, else the answer's `code`) is an `HttpError`, 429/5xx a
 * `RetryableHttpError`.
 */
export function createJinaConverter(transport: Transport, cfg: FetchConfig["jina"]): Converter {
  return {
    name: "jina",
    async convert(input, ctx) {
      const started = performance.now();
      if (!isPublicUrlLiteral(input.url)) throw new BlockedUrlError(input.url);
      const key = getEnv().JINA_API_KEY;
      if (!key) throw new Error("JINA_API_KEY is not set");
      const costOf = (res: HttpResponse) => {
        const tokens = tokensOf(res);
        return { units: tokens, unit: "tokens", costEur: (tokens * cfg.eurPerMTok) / 1e6 };
      };
      const res = await httpCall(
        transport,
        {
          service: "jina",
          operation: "read",
          url: `${cfg.endpoint}${input.url}`,
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
            "X-Return-Format": "markdown",
            ...(input.boilerplateSelectors.length > 0 ? { "X-Remove-Selector": input.boilerplateSelectors.join(", ") } : {}),
          },
          timeoutMs: cfg.timeoutMs,
          budget: "jina",
          costOf,
          meta: { url: input.url },
        },
        ctx,
      );
      const answer = parse(res);
      const data = answer.data;
      const targetStatus = typeof data?.httpStatus === "number" ? data.httpStatus : typeof answer.code === "number" ? answer.code : null;
      if (targetStatus !== null && (targetStatus < 200 || targetStatus > 299)) {
        const message = `jina: ${input.url} answered HTTP ${targetStatus}`;
        if (targetStatus === 429 || targetStatus >= 500) throw new RetryableHttpError(message, targetStatus);
        throw new HttpError(message, targetStatus);
      }
      if (typeof data?.content !== "string") throw new RetryableHttpError(`jina answer for ${input.url} has no content`, res.status);
      return {
        markdown: data.content.trim(),
        title: text(data.title),
        publishedHint: text(data.publishedTime),
        rendered: false,
        durationMs: Math.round(performance.now() - started),
        costEur: costOf(res).costEur,
      };
    },
  };
}
