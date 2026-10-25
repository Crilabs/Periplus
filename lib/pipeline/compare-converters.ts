import { and, eq, isNull } from "drizzle-orm";
import type { Converter, ConverterName } from "@/lib/adapters/fetch";
import { BlockedUrlError } from "@/lib/adapters/fetch/ssrf";
import { HttpError, RetryableHttpError, type CallContext, type Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { converterOutputs, converterSamples } from "@/lib/db/schema";
import { comparisonMdKey } from "@/lib/domain/converter-comparison";
import { BudgetExceeded } from "@/lib/domain/costs";
import { CONVERTERS } from "@/lib/domain/sources/crawl-rules";
import { getSource } from "@/lib/domain/sources/store";
import { registrableDomain } from "@/lib/domain/sources/urls";
import { decodeHtml, fetchFollowing, formatOf } from "@/lib/pipeline/fetch/page";

// No import of ./runs here: the job handler imports this module (import cycle through the stage registry).

export const COMPARE_STAGE = "compare.converters";

export type CompareDeps = {
  transport: Transport;
  archive: Archive;
  converters: Record<ConverterName, Converter>;
  /** Address check before every request and redirect hop (default `isPublicHttpUrl`). */
  isAllowed?: (url: string) => Promise<boolean>;
};

/** Longest error text stored per output. */
const MAX_ERROR_CHARS = 500;

type OutputValues = { mdKey: string | null; chars: number; durationMs: number; costEur: number; error: string | null };

/** Inserts or replaces the output of `converter` for the sample (a new output has no rating yet). */
async function storeOutput(db: Db, sampleId: string, converter: ConverterName, v: OutputValues): Promise<void> {
  const values = {
    mdKey: v.mdKey,
    chars: v.chars,
    durationMs: v.durationMs,
    costEur: v.costEur.toFixed(6),
    error: v.error === null ? null : v.error.slice(0, MAX_ERROR_CHARS),
    rating: null,
    ratedBy: null,
    ratedAt: null,
  };
  await db
    .insert(converterOutputs)
    .values({ sampleId, converter, ...values })
    .onConflictDoUpdate({ target: [converterOutputs.sampleId, converterOutputs.converter], set: values });
}

/**
 * Job `compare.converters`: converts one sample page with every converter that has no successful output yet (a
 * retry or a later run never redoes, and never unrates, a successful one).
 * 1. The page is fetched once like a crawl (`fetchFollowing`: robots.txt of every hop, address check, per-domain
 *    rate). A stop (robots, offsite redirect, blocked address), a 4xx, an unreachable address or a non-HTML answer is
 *    stored as the error of every pending converter: Jina and Firecrawl would fetch a page Periplus may not.
 * 2. `local` converts the fetched HTML, Jina and Firecrawl the (final) URL themselves, each with its duration and cost
 *    (`Converted.costEur`, the sum the converter booked in `external_calls`); the Markdown goes to
 *    `comparison/converters/<sampleId>/<converter>.md`.
 * 3. A converter's error is stored in its `error` and the others still run; `BudgetExceeded` is thrown (the job
 *    waits for the next budget day), as is a temporary failure of the page fetch (`RetryableHttpError`). A temporary
 *    failure of a converter (`RetryableHttpError`, e.g. Jina or Firecrawl answering 429/5xx) is stored too and thrown
 *    once the other converters ran, so the job's retries convert it again (only what is still missing).
 * Outputs are upserted per (sample, converter): a retry creates no duplicate.
 */
export async function compareSample(db: Db, sampleId: string, deps: CompareDeps, ctx: CallContext & { runId: string }): Promise<void> {
  const [sample] = await db.select().from(converterSamples).where(eq(converterSamples.id, sampleId));
  if (!sample) throw new Error(`converter sample ${sampleId} not found`);
  const done = new Set(
    (
      await db
        .select({ converter: converterOutputs.converter })
        .from(converterOutputs)
        .where(and(eq(converterOutputs.sampleId, sampleId), isNull(converterOutputs.error)))
    ).map((r) => r.converter),
  );
  const pending = CONVERTERS.filter((c) => !done.has(c));
  if (pending.length === 0) return;
  const failAll = async (error: string) => {
    for (const converter of pending) await storeOutput(db, sampleId, converter, { mdKey: null, chars: 0, durationMs: 0, costEur: 0, error });
  };

  const source = await getSource(db, sample.sourceId);
  if (!source) throw new Error(`source ${sample.sourceId} not found`);
  if (source.validTo !== null || source.status !== "approved") return failAll("source_not_approved");
  const callCtx = { ...ctx, db, sourceId: source.id };

  let html: string;
  let pageUrl: string;
  let ratePerMinute: number;
  try {
    const fetched = await fetchFollowing(db, source, sample.url, null, deps, callCtx);
    if (fetched.kind === "stop") return failAll(fetched.reason);
    const { res } = fetched;
    if (res.status >= 300) return failAll(`HTTP ${res.status}`);
    if (res.truncated || res.body.byteLength > getConfig().fetch.maxRawBytes) return failAll("too_large");
    const contentType = res.headers["content-type"] ?? null;
    if (formatOf(contentType, fetched.finalUrl).kind !== "html") return failAll("not_html");
    html = decodeHtml(res.body, contentType);
    pageUrl = fetched.finalUrl;
    ratePerMinute = fetched.ratePerMinute;
  } catch (error) {
    if (error instanceof BlockedUrlError) return failAll("blocked_address");
    if (error instanceof HttpError) return failAll(`HTTP ${error.status}`);
    throw error;
  }

  const cfg = getConfig().fetch;
  const rate = { key: `domain:${registrableDomain(pageUrl)}`, perMinute: ratePerMinute, maxWaitMs: cfg.maxRateWaitMs };
  let temporary: RetryableHttpError | null = null;
  for (const name of pending) {
    const started = performance.now();
    try {
      const converted = await deps.converters[name].convert(
        {
          url: pageUrl,
          html: name === "local" ? html : null,
          boilerplateSelectors: source.crawlRules.boilerplateSelectors,
          render: source.crawlRules.render,
          rate,
        },
        callCtx,
      );
      const mdKey = comparisonMdKey(sampleId, name);
      await deps.archive.put(mdKey, converted.markdown, "text/markdown; charset=utf-8");
      await storeOutput(db, sampleId, name, {
        mdKey,
        chars: converted.markdown.length,
        durationMs: converted.durationMs,
        costEur: converted.costEur,
        error: null,
      });
    } catch (error) {
      if (error instanceof BudgetExceeded) throw error;
      const message = error instanceof Error ? error.message : String(error);
      await storeOutput(db, sampleId, name, { mdKey: null, chars: 0, durationMs: Math.round(performance.now() - started), costEur: 0, error: message });
      if (error instanceof RetryableHttpError) temporary ??= error;
    }
  }
  if (temporary) throw temporary;
}

/** Plan of the stage `compare.converters`: one job per sample of `params.sampleIds`. */
export async function planCompareSamples(_db: Db, run: { params: Record<string, unknown> }) {
  const ids = Array.isArray(run.params.sampleIds) ? run.params.sampleIds.filter((v): v is string => typeof v === "string") : [];
  return ids.map((sampleId) => ({ key: sampleId, sampleId }));
}
