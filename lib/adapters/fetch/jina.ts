import type { FetchConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { httpCall, RetryableHttpError, type HttpResponse, type Transport } from "../http";
import type { Converter } from "./types";

type JinaAnswer = {
  data?: { title?: unknown; content?: unknown; publishedTime?: unknown; usage?: { tokens?: unknown } } | null;
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
 * `X-Remove-Selector`. Charged against the daily `jina` budget at `data.usage.tokens × eurPerMTok / 1e6`.
 */
export function createJinaConverter(transport: Transport, cfg: FetchConfig["jina"]): Converter {
  return {
    name: "jina",
    async convert(input, ctx) {
      const started = performance.now();
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
      const data = parse(res).data;
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
