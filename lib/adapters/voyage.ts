import type { EmbeddingsConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { RetryableHttpError, httpCall, type CallContext, type HttpResponse, type Transport } from "./http";

type Answer = { data?: Array<{ embedding?: unknown; index?: unknown }>; usage?: { total_tokens?: unknown } };

function parse(res: HttpResponse): Answer {
  try {
    const answer = JSON.parse(res.text()) as Answer;
    if (typeof answer !== "object" || answer === null) throw new Error("not an object");
    return answer;
  } catch (error) {
    throw new RetryableHttpError("voyage returned an unreadable answer", res.status, { cause: error });
  }
}

function tokensOf(answer: Answer): number {
  const tokens = answer.usage?.total_tokens;
  return typeof tokens === "number" && tokens > 0 ? tokens : 0;
}

/**
 * Embeds `texts` as documents with Voyage (`cfg.model`, `cfg.dimension`): one POST to `cfg.endpoint`. Charged against
 * the daily `voyage` budget at `usage.total_tokens × eurPerMTok / 1e6`. The vectors come back in the order of `texts`
 * (sorted by the answer's `data[].index`); a missing vector or one whose length is not `cfg.dimension` is an error.
 */
export async function embedTexts(
  transport: Transport,
  texts: string[],
  ctx: CallContext,
  cfg: EmbeddingsConfig,
): Promise<{ vectors: number[][]; tokens: number }> {
  if (texts.length === 0) return { vectors: [], tokens: 0 };
  const key = getEnv().VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is not set");
  const res = await httpCall(
    transport,
    {
      service: "voyage",
      operation: "embed",
      url: cfg.endpoint,
      method: "POST",
      body: JSON.stringify({ input: texts, model: cfg.model, input_type: "document", output_dimension: cfg.dimension }),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      timeoutMs: cfg.timeoutMs,
      ratePerMinute: cfg.ratePerMinute,
      budget: "voyage",
      costOf: (r) => {
        const tokens = r.status === 200 ? tokensOf(parse(r)) : 0;
        return { units: tokens, unit: "tokens", costEur: (tokens * cfg.eurPerMTok) / 1e6 };
      },
      meta: { model: cfg.model, texts: texts.length },
    },
    ctx,
  );

  const answer = parse(res);
  const data = Array.isArray(answer.data) ? answer.data : [];
  const vectors: number[][] = new Array(texts.length);
  for (const item of data) {
    const index = item.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= texts.length) {
      throw new Error(`voyage answer has an embedding with invalid index ${String(index)}`);
    }
    const embedding = item.embedding;
    if (!Array.isArray(embedding) || !embedding.every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new Error(`voyage embedding ${index} is not a list of numbers`);
    }
    if (embedding.length !== cfg.dimension) {
      throw new Error(`voyage embedding ${index} has ${embedding.length} dimensions, expected ${cfg.dimension}`);
    }
    vectors[index] = embedding as number[];
  }
  for (let i = 0; i < texts.length; i++) {
    if (!vectors[i]) throw new Error(`voyage answer has no embedding for text ${i} of ${texts.length}`);
  }
  return { vectors, tokens: tokensOf(answer) };
}

