import { createHash } from "node:crypto";
import { type Converter, type ConverterName } from "@/lib/adapters/fetch";
import type { SimulatedFetcher } from "@/lib/adapters/fetch/simulated";
import { isPublicHttpUrl } from "@/lib/adapters/fetch/ssrf";
import { httpCall, RetryableHttpError, type CallContext, type HttpResponse, type Transport } from "@/lib/adapters/http";
import { type runPdftotext } from "@/lib/adapters/pdf";
import type { Archive } from "@/lib/adapters/s3";
import type { ModelClient } from "@/lib/ai/types";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { effectiveRate, robotsForRun } from "@/lib/domain/sources/robots";
import type { Source } from "@/lib/domain/sources/store";
import { registrableDomain } from "@/lib/domain/sources/urls";
import type { JobData } from "@/lib/jobs/worker";

/*
 * The single-URL part of fetching: one page GET with the redirects, address and robots checks, the format and charset
 * of the answer, and the dependencies of a fetch. Shared by the research fetch and the crawl (`./url`).
 */

/** Redirect hops the crawl follows itself (each checked for domain, address and robots). */
const MAX_REDIRECTS = 5;
const REDIRECTS = [301, 302, 303, 307, 308];
export const UPLOAD_PREFIX = "upload://";

/** Where a stopped fetch leaves its URL: queued again, skipped for good, or failed. */
export type StopStatus = "queued" | "skipped" | "failed";

export type FetchUrlDeps = {
  transport: Transport;
  archive: Archive;
  converters: Record<ConverterName, Converter>;
  pdf: { pdftotext: typeof runPdftotext; model?: ModelClient };
  /** Enqueues follow-up `fetch.url` jobs in `tx`; returns how many were new. */
  enqueue(tx: Db, jobs: JobData[]): Promise<number>;
  now?: () => Date;
  /** Address check before every request and redirect hop (default `isPublicHttpUrl`). */
  isAllowed?: (url: string) => Promise<boolean>;
  /** A simulated revisit: pages come from the scenario instead of the network (`fetchSimulated`). */
  simulated?: SimulatedFetcher;
};

export type FetchUrlOutcome =
  | "new_version"
  | "unchanged"
  | "reverted"
  | "not_modified"
  | "gone"
  | "missing"
  | "disallowed"
  | "skipped"
  | "failed";

/** Job key of a URL: the first 32 hex characters of sha256(url_normalized). */
export function urlJobKey(urlNormalized: string): string {
  return createHash("sha256").update(urlNormalized).digest("hex").slice(0, 32);
}

export type Fetched =
  | { kind: "response"; res: HttpResponse; finalUrl: string; ratePerMinute: number }
  | { kind: "stop"; outcome: FetchUrlOutcome; status: StopStatus; reason: string };

/**
 * GETs the page with redirects followed here, at most `MAX_REDIRECTS` hops: before every hop the target must be on
 * the source's registrable domain (else `skipped`/`redirect_offsite`, final), pass the address check (else
 * `queued`/`blocked_address`) and then the robots.txt of its host, read once per run (else `queued`/`robots`, or
 * `queued`/`robots_unavailable` when it cannot be read). The
 * temporary reasons leave the row for the next run (ruling M3-C-R5). Conditional headers go with the first request
 * only.
 */
export async function fetchFollowing(
  db: Db,
  source: Source,
  url: string,
  validators: { etag: string | null; lastModified: string | null } | null,
  deps: Pick<FetchUrlDeps, "transport" | "archive" | "isAllowed">,
  ctx: CallContext & { runId: string },
): Promise<Fetched> {
  const cfg = getConfig().fetch;
  const isAllowed = deps.isAllowed ?? ((u: string) => isPublicHttpUrl(u));
  const domain = registrableDomain(url);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop > 0 && registrableDomain(current) !== domain) return { kind: "stop", outcome: "skipped", status: "skipped", reason: "redirect_offsite" };
    if (!(await isAllowed(current))) return { kind: "stop", outcome: "skipped", status: "queued", reason: "blocked_address" };
    let robots: Awaited<ReturnType<typeof robotsForRun>>;
    try {
      robots = await robotsForRun(db, deps.archive, deps.transport, new URL(current).origin, ctx.runId, ctx);
    } catch (error) {
      // robots.txt unreadable (5xx, timeout) means nothing is allowed now: a temporary stop, not one failed job per
      // URL (ruling M3-FIN-R1; fetch.source already retried the start host).
      if (error instanceof RetryableHttpError) return { kind: "stop", outcome: "disallowed", status: "queued", reason: "robots_unavailable" };
      throw error;
    }
    if (!robots.isAllowed(current)) return { kind: "stop", outcome: "disallowed", status: "queued", reason: "robots" };
    const ratePerMinute = effectiveRate(source.crawlRules.ratePerMinute, robots.crawlDelaySec);
    const headers: Record<string, string> = {};
    if (hop === 0 && validators?.etag) headers["If-None-Match"] = validators.etag;
    if (hop === 0 && validators?.lastModified) headers["If-Modified-Since"] = validators.lastModified;
    const res = await httpCall(
      deps.transport,
      {
        service: "crawl",
        operation: "page",
        url: current,
        headers,
        timeoutMs: cfg.timeoutMs,
        redirect: "manual",
        okStatuses: [304, 404, 410, ...REDIRECTS],
        rateKey: `domain:${registrableDomain(current)}`,
        ratePerMinute,
        maxRateWaitMs: cfg.maxRateWaitMs,
        maxBodyBytes: cfg.maxRawBytes + 1,
        meta: { url: current },
      },
      ctx,
    );
    const location = res.headers.location;
    if (!REDIRECTS.includes(res.status)) return { kind: "response", res, finalUrl: current, ratePerMinute };
    if (!location) return { kind: "stop", outcome: "failed", status: "failed", reason: `HTTP ${res.status}` };
    current = new URL(location, current).href;
  }
  return { kind: "stop", outcome: "failed", status: "failed", reason: "too_many_redirects" };
}

export type Format = { kind: "pdf" } | { kind: "structured"; type: "csv" | "geojson" | "kml" } | { kind: "html" } | { kind: "unsupported" };

export function formatOf(contentType: string | null, url: string): Format {
  const mime = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const path = url.startsWith(UPLOAD_PREFIX) ? "" : new URL(url).pathname.toLowerCase();
  if (mime === "application/pdf" || path.endsWith(".pdf")) return { kind: "pdf" };
  if (mime === "text/csv" || path.endsWith(".csv")) return { kind: "structured", type: "csv" };
  if (mime === "application/geo+json" || path.endsWith(".geojson")) return { kind: "structured", type: "geojson" };
  if (mime === "application/vnd.google-earth.kml+xml" || path.endsWith(".kml")) return { kind: "structured", type: "kml" };
  if (mime === "" || mime === "text/html" || mime === "application/xhtml+xml" || mime === "text/plain") return { kind: "html" };
  return { kind: "unsupported" };
}

/** Bytes of an HTML document searched for a `<meta>` charset (the WHATWG prescan looks at the first 1024). */
const META_PRESCAN_BYTES = 1024;

/**
 * The charset a `<meta charset>` or `<meta http-equiv="Content-Type" content="…; charset=…">` in the first 1024 bytes
 * declares (UTF-16 counts as UTF-8: a document that can be read as ASCII here is not UTF-16), or null.
 */
function metaCharset(body: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(body.subarray(0, META_PRESCAN_BYTES));
  const declared = /<meta\b[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1];
  if (!declared) return null;
  return /^utf-16/i.test(declared) ? "utf-8" : declared;
}

/**
 * Text of an HTML answer in its declared charset: the `Content-Type` header's, else a `<meta>` charset of the
 * document (older Greek sites declare `windows-1253`/`iso-8859-7` only there), else UTF-8; an unknown one is UTF-8.
 */
export function decodeHtml(body: Uint8Array, contentType: string | null): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ?? metaCharset(body) ?? undefined;
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}
