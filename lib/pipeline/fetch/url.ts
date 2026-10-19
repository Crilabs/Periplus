import { createHash } from "node:crypto";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { resolveConverter, type Converter, type ConverterName } from "@/lib/adapters/fetch";
import { BlockedUrlError, isPublicHttpUrl } from "@/lib/adapters/fetch/ssrf";
import { HttpError, httpCall, type CallContext, type HttpResponse, type Transport } from "@/lib/adapters/http";
import { convertPdf, type runPdftotext } from "@/lib/adapters/pdf";
import type { Archive } from "@/lib/adapters/s3";
import type { ModelClient } from "@/lib/ai/types";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { crawlFrontier, documents, outlinks, sources, type FrontierStatus } from "@/lib/db/schema";
import { detectLanguage } from "@/lib/domain/documents/language";
import { extractLinks } from "@/lib/domain/documents/links";
import { extractPublishedAt } from "@/lib/domain/documents/metadata";
import { ensureDocument, markChecked, markGone, storeFetched } from "@/lib/domain/documents/store";
import { structuredToMarkdown } from "@/lib/domain/documents/structured";
import { extendStage } from "@/lib/domain/runs";
import { urlAllowed } from "@/lib/domain/sources/crawl-rules";
import { effectiveRate, robotsForRun } from "@/lib/domain/sources/robots";
import { getSource, type Source } from "@/lib/domain/sources/store";
import { normalizeUrl, registrableDomain } from "@/lib/domain/sources/urls";
import type { JobData } from "@/lib/jobs/worker";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

export const FETCH_URL_STAGE = "fetch.url";

/** Redirect hops the crawl follows itself (each checked for domain, address and robots). */
const MAX_REDIRECTS = 5;
const REDIRECTS = [301, 302, 303, 307, 308];
const UPLOAD_PREFIX = "upload://";

export type FetchUrlJob = { sourceId: string; url: string; depth: number; documentId?: string; maxPages?: number };

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

export type FetchUrlResult = { outcome: FetchUrlOutcome; newUrls: number };

/** Job key of a URL: the first 32 hex characters of sha256(url_normalized). */
export function urlJobKey(urlNormalized: string): string {
  return createHash("sha256").update(urlNormalized).digest("hex").slice(0, 32);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Plan of the stage `fetch.url`: for every approved source of `params.sourceIds`, its frontier rows except `skipped`
 * by depth and discovery, at most `params.maxPages ?? rules.maxPages`; the planned rows are stamped with the run
 * (ruling M3-P2: the per-run cap counts them). Plus one job per uploaded document of `params.documentIds`.
 */
export async function planFetchUrls(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> {
  const jobs: JobData[] = [];
  const paramMax = typeof run.params.maxPages === "number" ? run.params.maxPages : undefined;
  for (const sourceId of stringList(run.params.sourceIds)) {
    const source = await getSource(db, sourceId);
    if (!source || source.status !== "approved") continue;
    const maxPages = paramMax ?? source.crawlRules.maxPages;
    const rows = await db
      .select({ id: crawlFrontier.id, url: crawlFrontier.url, urlNormalized: crawlFrontier.urlNormalized, depth: crawlFrontier.depth })
      .from(crawlFrontier)
      .where(and(eq(crawlFrontier.sourceId, sourceId), ne(crawlFrontier.status, "skipped")))
      .orderBy(asc(crawlFrontier.depth), asc(crawlFrontier.discoveredAt), asc(crawlFrontier.id))
      .limit(maxPages);
    if (rows.length === 0) continue;
    await db
      .update(crawlFrontier)
      .set({ lastRunId: run.id, updatedAt: sql`now()` })
      .where(inArray(crawlFrontier.id, rows.map((r) => r.id)));
    for (const r of rows) jobs.push({ key: urlJobKey(r.urlNormalized), sourceId, url: r.url, depth: r.depth, maxPages });
  }
  const documentIds = stringList(run.params.documentIds);
  if (documentIds.length > 0) {
    const docs = await db
      .select({ id: documents.id, sourceId: documents.sourceId, url: documents.url, urlNormalized: documents.urlNormalized })
      .from(documents)
      .where(inArray(documents.id, documentIds));
    for (const d of docs) jobs.push({ key: urlJobKey(d.urlNormalized), sourceId: d.sourceId, url: d.url, depth: 0, documentId: d.id });
  }
  return jobs;
}

async function setFrontier(db: Db, sourceId: string, urlNormalized: string, runId: string, status: FrontierStatus, reason: string | null) {
  await db
    .update(crawlFrontier)
    .set({ status, reason, lastRunId: runId, updatedAt: sql`now()` })
    .where(and(eq(crawlFrontier.sourceId, sourceId), eq(crawlFrontier.urlNormalized, urlNormalized)));
}

type Fetched =
  | { kind: "response"; res: HttpResponse; finalUrl: string; ratePerMinute: number }
  | { kind: "stop"; outcome: FetchUrlOutcome; status: FrontierStatus; reason: string };

/**
 * GETs the page with redirects followed here, at most `MAX_REDIRECTS` hops: before every hop the target must be on
 * the source's registrable domain (else `redirect_offsite`), pass the address check (`blocked_address`) and the
 * robots.txt of its host, read once per run (`robots`). Conditional headers go with the first request only.
 */
async function fetchFollowing(
  db: Db,
  source: Source,
  url: string,
  validators: { etag: string | null; lastModified: string | null } | null,
  deps: FetchUrlDeps,
  ctx: CallContext & { runId: string },
): Promise<Fetched> {
  const cfg = getConfig().fetch;
  const isAllowed = deps.isAllowed ?? ((u: string) => isPublicHttpUrl(u));
  const domain = registrableDomain(url);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop > 0 && registrableDomain(current) !== domain) return { kind: "stop", outcome: "skipped", status: "skipped", reason: "redirect_offsite" };
    const robots = await robotsForRun(db, deps.archive, deps.transport, new URL(current).origin, ctx.runId, ctx);
    if (!robots.isAllowed(current)) return { kind: "stop", outcome: "disallowed", status: "skipped", reason: "robots" };
    if (!(await isAllowed(current))) return { kind: "stop", outcome: "skipped", status: "skipped", reason: "blocked_address" };
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

type Format = { kind: "pdf" } | { kind: "structured"; type: "csv" | "geojson" | "kml" } | { kind: "html" } | { kind: "unsupported" };

function formatOf(contentType: string | null, url: string): Format {
  const mime = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const path = url.startsWith(UPLOAD_PREFIX) ? "" : new URL(url).pathname.toLowerCase();
  if (mime === "application/pdf" || path.endsWith(".pdf")) return { kind: "pdf" };
  if (mime === "text/csv" || path.endsWith(".csv")) return { kind: "structured", type: "csv" };
  if (mime === "application/geo+json" || path.endsWith(".geojson")) return { kind: "structured", type: "geojson" };
  if (mime === "application/vnd.google-earth.kml+xml" || path.endsWith(".kml")) return { kind: "structured", type: "kml" };
  if (mime === "" || mime === "text/html" || mime === "application/xhtml+xml" || mime === "text/plain") return { kind: "html" };
  return { kind: "unsupported" };
}

/** Text of an HTML answer in its declared charset (UTF-8 when none or unknown). */
function decodeHtml(body: Uint8Array, contentType: string | null): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/**
 * Adds the page's links: internal ones the crawl rules allow within `maxDepth` become frontier rows of this run while
 * the source's rows of this run stay below `maxPages` (the source row is locked, so concurrent jobs count in turn);
 * their jobs are enqueued and the stage extended in the same transaction. External links count per registrable
 * domain in `outlinks` for (source, domain, run). Returns the number of new URLs.
 */
async function followLinks(
  db: Db,
  source: Source,
  links: string[],
  depth: number,
  maxPages: number,
  deps: FetchUrlDeps,
  runId: string,
): Promise<number> {
  const rules = source.crawlRules;
  const internal: string[] = [];
  const external = new Map<string, number>();
  for (const link of links) {
    let domain: string;
    try {
      domain = registrableDomain(link);
    } catch {
      continue;
    }
    if (domain !== source.domain) {
      external.set(domain, (external.get(domain) ?? 0) + 1);
      continue;
    }
    if (depth + 1 <= rules.maxDepth && urlAllowed(link, rules, source.domain).ok) internal.push(link);
  }

  return db.transaction(async (tx) => {
    for (const [toDomain, n] of external) {
      await tx
        .insert(outlinks)
        .values({ fromSourceId: source.id, toDomain, count: n, runId })
        .onConflictDoUpdate({
          target: [outlinks.fromSourceId, outlinks.toDomain, outlinks.runId],
          set: { count: sql`${outlinks.count} + ${n}` },
        });
    }
    if (internal.length === 0) return 0;
    await tx.select({ id: sources.id }).from(sources).where(eq(sources.id, source.id)).for("update");
    const [row] = await tx
      .select({ n: count() })
      .from(crawlFrontier)
      .where(and(eq(crawlFrontier.sourceId, source.id), eq(crawlFrontier.lastRunId, runId)));
    const room = maxPages - (row?.n ?? 0);
    if (room <= 0) return 0;
    const known = new Set(
      (
        await tx
          .select({ url: crawlFrontier.urlNormalized })
          .from(crawlFrontier)
          .where(and(eq(crawlFrontier.sourceId, source.id), inArray(crawlFrontier.urlNormalized, internal)))
      ).map((r) => r.url),
    );
    const fresh = internal.filter((url) => !known.has(url)).slice(0, room);
    if (fresh.length === 0) return 0;
    const kept = await tx
      .insert(crawlFrontier)
      .values(fresh.map((url) => ({ sourceId: source.id, url, urlNormalized: url, depth: depth + 1, lastRunId: runId })))
      .onConflictDoNothing({ target: [crawlFrontier.sourceId, crawlFrontier.urlNormalized] })
      .returning({ url: crawlFrontier.url });
    const jobs = kept.map((r) => ({ key: urlJobKey(r.url), sourceId: source.id, url: r.url, depth: depth + 1, maxPages }));
    const enqueued = await deps.enqueue(tx, jobs);
    if (enqueued > 0) await extendStage(tx, runId, FETCH_URL_STAGE, enqueued);
    return kept.length;
  });
}

/**
 * Job `fetch.url`: fetches, converts and archives one URL of a source.
 * 1. The source must still be approved (an upload is exempt), else `skipped` (`source_paused`).
 * 2. `upload://<sha256>` reads `uploads/<sha256>.pdf` from the archive (no robots, no HTTP). Otherwise a conditional
 *    GET (validators of the document) through `fetchFollowing`, rate-limited per registrable domain at the
 *    crawl-delay-adjusted rate.
 * 3. 304 → `markChecked` (`not_modified`); 404/410 → `markGone` (`gone` when it turns gone now, else `missing`; a URL
 *    without document is `missing` and creates none); more than `maxRawBytes` → `skipped` (`too_large`).
 * 4. PDF (content type or `.pdf`, only with `rules.pdf`) → `convertPdf`; CSV/GeoJSON/KML → `structuredToMarkdown`;
 *    HTML → the source's converter.
 * 5. Language, publication date, `storeFetched` (document type = source type).
 * 6. HTML only: links (`followLinks`).
 * 7. Frontier `fetched`. A 4xx other than 404/410/429 (`HttpError`) marks the row `failed` with `HTTP <status>` and
 *    is the outcome `failed`, not an exception; `RetryableHttpError` is thrown (retry, then `failed_job`).
 */
export async function fetchUrl(db: Db, job: FetchUrlJob, deps: FetchUrlDeps, ctx: CallContext & { runId: string }): Promise<FetchUrlResult> {
  const cfg = getConfig().fetch;
  const now = deps.now ?? (() => new Date());
  const source = await getSource(db, job.sourceId);
  if (!source) throw new Error(`source ${job.sourceId} not found`);
  const isUpload = job.url.startsWith(UPLOAD_PREFIX);
  const urlNormalized = isUpload ? job.url : (normalizeUrl(job.url, cfg.trackingParams) ?? job.url);
  const callCtx = { ...ctx, db, sourceId: source.id };
  const stop = async (outcome: FetchUrlOutcome, status: FrontierStatus, reason: string | null): Promise<FetchUrlResult> => {
    await setFrontier(db, source.id, urlNormalized, ctx.runId, status, reason);
    return { outcome, newUrls: 0 };
  };
  if (!isUpload && source.status !== "approved") return stop("skipped", "skipped", "source_paused");

  const [doc] = await db
    .select({ id: documents.id, status: documents.status, etag: documents.etag, lastModified: documents.lastModified })
    .from(documents)
    .where(job.documentId ? eq(documents.id, job.documentId) : eq(documents.urlNormalized, urlNormalized));
  const fetchedAt = now();

  let raw: Uint8Array;
  let contentType: string | null;
  let finalUrl: string | null = null;
  let etag: string | null = null;
  let lastModified: string | null = null;
  let ratePerMinute = source.crawlRules.ratePerMinute;
  try {
    if (isUpload) {
      const sha = job.url.slice(UPLOAD_PREFIX.length);
      const stored = await deps.archive.get(`uploads/${sha}.pdf`);
      if (!stored) throw new Error(`upload ${sha} is not in the archive`);
      raw = stored;
      contentType = "application/pdf";
    } else {
      const fetched = await fetchFollowing(db, source, job.url, doc ?? null, deps, callCtx);
      if (fetched.kind === "stop") return stop(fetched.outcome, fetched.status, fetched.reason);
      const { res } = fetched;
      if (res.status === 304) {
        if (!doc) return stop("failed", "failed", "HTTP 304");
        await markChecked(db, doc.id, { at: fetchedAt, etag: res.headers.etag, lastModified: res.headers["last-modified"] });
        return stop("not_modified", "fetched", null);
      }
      if (res.status === 404 || res.status === 410) {
        if (!doc) return stop("missing", "failed", `HTTP ${res.status}`);
        const marked = await markGone(db, doc.id, fetchedAt, cfg.goneAfter);
        return stop(marked.gone && doc.status === "active" ? "gone" : "missing", "failed", `HTTP ${res.status}`);
      }
      const declared = Number(res.headers["content-length"]);
      if (res.truncated || res.body.byteLength > cfg.maxRawBytes || declared > cfg.maxRawBytes) return stop("skipped", "skipped", "too_large");
      raw = res.body;
      contentType = res.headers["content-type"] ?? null;
      finalUrl = fetched.finalUrl === job.url ? null : fetched.finalUrl;
      etag = res.headers.etag ?? null;
      lastModified = res.headers["last-modified"] ?? null;
      ratePerMinute = fetched.ratePerMinute;
    }

    const pageUrl = finalUrl ?? job.url;
    const format = formatOf(contentType, pageUrl);
    let markdown: string;
    let converter: string;
    let rawExt: string;
    let html: string | null = null;
    let hint: string | null = null;
    if (format.kind === "pdf") {
      if (!source.crawlRules.pdf && !isUpload) return stop("skipped", "skipped", "pdf_disabled");
      const pdf = await convertPdf(raw, { ...deps.pdf, cfg: cfg.pdf }, { runId: ctx.runId, stage: ctx.stage, sourceId: source.id });
      markdown = pdf.markdown;
      converter = pdf.converter;
      rawExt = "pdf";
    } else if (format.kind === "structured") {
      markdown = structuredToMarkdown(raw, format.type);
      converter = "structured";
      rawExt = format.type;
    } else if (format.kind === "html") {
      html = decodeHtml(raw, contentType);
      const name = resolveConverter(source.crawlRules, source.domain, cfg);
      // A render requests the page again: it waits for the same per-domain bucket as the fetch.
      const rate = { key: `domain:${registrableDomain(pageUrl)}`, perMinute: ratePerMinute, maxWaitMs: cfg.maxRateWaitMs };
      const converted = await deps.converters[name].convert(
        { url: pageUrl, html: name === "local" ? html : null, boilerplateSelectors: source.crawlRules.boilerplateSelectors, render: source.crawlRules.render, rate },
        callCtx,
      );
      markdown = converted.markdown;
      converter = name;
      hint = converted.publishedHint;
      rawExt = "html";
    } else {
      return stop("skipped", "skipped", "unsupported_type");
    }

    const documentId =
      doc?.id ?? (await ensureDocument(db, { sourceId: source.id, url: job.url, urlNormalized, docType: source.type })).id;
    const stored = await storeFetched(
      db,
      deps.archive,
      documentId,
      {
        fetchedAt,
        raw,
        rawExt,
        contentType,
        finalUrl,
        markdown,
        converter,
        language: detectLanguage(markdown, cfg.languages),
        publishedAt: extractPublishedAt({ html, url: pageUrl, hint, fetchedAt }),
        docType: source.type,
        etag,
        lastModified,
        runId: ctx.runId,
      },
      cfg.chunk,
    );

    let newUrls = 0;
    if (html !== null) {
      const maxPages = job.maxPages ?? source.crawlRules.maxPages;
      newUrls = await followLinks(db, source, extractLinks(html, pageUrl, cfg.trackingParams), job.depth, maxPages, deps, ctx.runId);
    }
    await setFrontier(db, source.id, urlNormalized, ctx.runId, "fetched", null);
    return { outcome: stored.outcome, newUrls };
  } catch (error) {
    if (error instanceof BlockedUrlError) return stop("skipped", "skipped", "blocked_address");
    if (error instanceof HttpError) return stop("failed", "failed", `HTTP ${error.status}`);
    throw error;
  }
}
