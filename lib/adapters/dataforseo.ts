import type { DiscoveryConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { HttpError, RetryableHttpError, httpCall, type CallContext, type HttpResponse, type Transport } from "./http";
import { assertNotSimulated } from "./simulation";

/** One organic result; `rank` is DataForSEO's `rank_absolute` (position among all SERP elements). */
export type SerpItem = { rank: number; url: string; title: string; snippet: string };

type Task = {
  status_code?: number;
  status_message?: string;
  result?: Array<{ items?: Array<Record<string, unknown>> | null }> | null;
};
type Answer = { status_code?: number; status_message?: string; tasks?: Task[] | null };

const OK = 20000;
/** Task status codes in the 40xxx range that are transient on DataForSEO's side and worth retrying. */
const RETRYABLE_TASK_CODES: ReadonlySet<number> = new Set([40101]);

function parseAnswer(res: HttpResponse): Answer {
  try {
    const answer = JSON.parse(res.text()) as Answer;
    if (typeof answer !== "object" || answer === null) throw new Error("not an object");
    return answer;
  } catch (error) {
    throw new RetryableHttpError("dataforseo returned an unreadable answer", res.status, { cause: error });
  }
}

/** The status of the one task (else of the whole answer) and its message. */
function statusOf(answer: Answer): { code: number; message: string } {
  const task = answer.tasks?.[0];
  if (answer.status_code !== OK || !task) {
    return { code: answer.status_code ?? 0, message: answer.status_message ?? "no task in answer" };
  }
  return { code: task.status_code ?? 0, message: task.status_message ?? "" };
}

function authorization(): string {
  const { DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD } = getEnv();
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) throw new Error("DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set");
  return `Basic ${Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString("base64")}`;
}

/**
 * One Google organic search (DataForSEO SERP Live/Regular, `cfg.depth` results). Charged against the daily
 * `dataforseo` budget at `cfg.costPerQueryEur` per HTTP 200 answer: DataForSEO bills a task that ends in an
 * error status too.
 * Returns the raw answer and its organic items only. A task status `40xxx` is an `HttpError` (the request is
 * wrong) except the transient codes in `RETRYABLE_TASK_CODES` (40101, a search-engine-side error): such a search is
 * repeated up to `cfg.taskRetries` times (pause `cfg.taskRetryDelayMs`, doubling) before it fails. Those, `50xxx`
 * and unreadable answers are `RetryableHttpError`.
 */
export async function searchOrganic(
  transport: Transport,
  q: { keyword: string; languageCode: string; locationCode: number },
  ctx: CallContext,
  cfg: DiscoveryConfig["serp"],
): Promise<{ raw: Uint8Array; items: SerpItem[] }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await searchOnce(transport, q, ctx, cfg);
    } catch (error) {
      if (!(error instanceof TransientTaskError) || attempt >= cfg.taskRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, cfg.taskRetryDelayMs * 2 ** attempt));
    }
  }
}

/** A transient task status (`RETRYABLE_TASK_CODES`): `searchOrganic` repeats the search before giving up. */
class TransientTaskError extends RetryableHttpError {}

async function searchOnce(
  transport: Transport,
  q: { keyword: string; languageCode: string; locationCode: number },
  ctx: CallContext,
  cfg: DiscoveryConfig["serp"],
): Promise<{ raw: Uint8Array; items: SerpItem[] }> {
  assertNotSimulated("dataforseo", "serp_organic");
  const res = await httpCall(
    transport,
    {
      service: "dataforseo",
      operation: "serp_organic",
      url: cfg.endpoint,
      method: "POST",
      body: JSON.stringify([
        { keyword: q.keyword, language_code: q.languageCode, location_code: q.locationCode, depth: cfg.depth },
      ]),
      headers: { Authorization: authorization(), "Content-Type": "application/json" },
      timeoutMs: cfg.timeoutMs,
      ratePerMinute: cfg.ratePerMinute,
      budget: "dataforseo",
      costOf: (r) =>
        r.status === 200 ? { units: 1, unit: "query", costEur: cfg.costPerQueryEur } : { units: 0, unit: "query", costEur: 0 },
      meta: { keyword: q.keyword, languageCode: q.languageCode, locationCode: q.locationCode },
    },
    ctx,
  );

  const answer = parseAnswer(res);
  const { code, message } = statusOf(answer);
  if (code !== OK) {
    const text = `dataforseo status ${code} for "${q.keyword}": ${message}`;
    if (RETRYABLE_TASK_CODES.has(code)) throw new TransientTaskError(text, code);
    if (code >= 40000 && code < 50000) throw new HttpError(text, code);
    throw new RetryableHttpError(text, code);
  }

  const items: SerpItem[] = [];
  for (const item of answer.tasks![0]!.result?.[0]?.items ?? []) {
    if (item.type !== "organic" || typeof item.url !== "string" || typeof item.rank_absolute !== "number") continue;
    items.push({
      rank: item.rank_absolute,
      url: item.url,
      title: typeof item.title === "string" ? item.title : "",
      snippet: typeof item.description === "string" ? item.description : "",
    });
  }
  items.sort((a, b) => a.rank - b.rank);
  return { raw: res.body, items };
}
