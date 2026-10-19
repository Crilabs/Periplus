import { createHash } from "node:crypto";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { resolveConverter, type Converter, type ConverterName } from "@/lib/adapters/fetch";
import { BlockedUrlError, isPublicHttpUrl } from "@/lib/adapters/fetch/ssrf";
import { HttpError, httpCall, RetryableHttpError, type CallContext, type HttpResponse, type Transport } from "@/lib/adapters/http";
import { convertPdf, type runPdftotext } from "@/lib/adapters/pdf";
import type { Archive } from "@/lib/adapters/s3";
import type { ModelClient } from "@/lib/ai/types";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { crawlFrontier, documents, documentVersions, jobOutcomes, outlinks, sources, type FrontierStatus } from "@/lib/db/schema";
import { detectLanguage } from "@/lib/domain/documents/language";
import { extractLinks } from "@/lib/domain/documents/links";
import { extractPublishedAt } from "@/lib/domain/documents/metadata";
import { ensureDocument, markChecked, markGone, storeFetched } from "@/lib/domain/documents/store";
import { structuredToMarkdown } from "@/lib/domain/documents/structured";
import { extendStage, stageAcceptsJobs } from "@/lib/domain/runs";
import { urlAllowed } from "@/lib/domain/sources/crawl-rules";
import { effectiveRate, robotsForRun } from "@/lib/domain/sources/robots";
import { getSource, type Source } from "@/lib/domain/sources/store";
import { normalizeUrl, registrableDomain } from "@/lib/domain/sources/urls";
import { FETCH_SOURCE_STAGE } from "./source";
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
 * Plan of the stage `fetch.url`: for every current approved source of `params.sourceIds` whose `fetch.source` job of
 * this run did not fail (its robots.txt could not be read: the rows stay queued), its frontier rows except `skipped`
 * (final verdicts only, ruling M3-C-R5) by depth and discovery, at most `params.maxPages ?? rules.maxPages`. The
 * planned rows are stamped with the run (ruling M3-P2: the per-run cap counts them) and queued again, so a row
 * `fetched`/`failed` with this run's id is one a job of this run has finished (retries check it). Plus one job per
 * uploaded document of `params.documentIds`.
 */
export async function planFetchUrls(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> {
  const jobs: JobData[] = [];
  const paramMax = typeof run.params.maxPages === "number" ? run.params.maxPages : undefined;
  const unprepared = new Set(
    (
      await db
        .select({ key: jobOutcomes.key })
        .from(jobOutcomes)
        .where(and(eq(jobOutcomes.runId, run.id), eq(jobOutcomes.stage, FETCH_SOURCE_STAGE), eq(jobOutcomes.outcome, "failed")))
    ).map((r) => r.key),
  );
  for (const sourceId of stringList(run.params.sourceIds)) {
    // A source whose fetch.source job failed (e.g. robots.txt answered 5xx) keeps its rows queued for the next run.
    if (unprepared.has(sourceId)) continue;
    const source = await getSource(db, sourceId);
    if (!source || source.status !== "approved" || source.validTo !== null) continue;
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
      .set({ lastRunId: run.id, status: "queued", reason: null, updatedAt: sql`now()` })
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

/** The page's frontier row, locked until `tx` ends. */
async function lockFrontierRow(tx: Db, sourceId: string, urlNormalized: string) {
  const [row] = await tx
    .select({ status: crawlFrontier.status, reason: crawlFrontier.reason, lastRunId: crawlFrontier.lastRunId })
    .from(crawlFrontier)
    .where(and(eq(crawlFrontier.sourceId, sourceId), eq(crawlFrontier.urlNormalized, urlNormalized)))
    .for("update");
  return row ?? null;
}

export type Fetched =
  | { kind: "response"; res: HttpResponse; finalUrl: string; ratePerMinute: number }
  | { kind: "stop"; outcome: FetchUrlOutcome; status: FrontierStatus; reason: string };

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

type Format = { kind: "pdf" } | { kind: "structured"; type: "csv" | "geojson" | "kml" } | { kind: "html" } | { kind: "unsupported" };

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

/**
 * Adds the page's links and marks its frontier row `fetched`, all in one transaction. Locks are taken in a fixed
 * order (source row, page row, outlinks by domain), so concurrent jobs of one source wait in turn instead of
 * deadlocking. Internal links the crawl rules allow within `maxDepth` become frontier rows of this run while the
 * source's rows of this run stay below `maxPages`; their jobs are enqueued and the stage extended in the same
 * transaction. External links count per registrable domain in `outlinks` for (source, domain, run), once per page and
 * run: a page row already `fetched` in this run (a retried job) adds nothing (ruling M3-C-R2). Returns the number of
 * new URLs.
 */
export async function followLinks(
  db: Db,
  source: Source,
  page: { urlNormalized: string; depth: number; links: string[] },
  maxPages: number,
  deps: Pick<FetchUrlDeps, "enqueue">,
  runId: string,
): Promise<number> {
  const rules = source.crawlRules;
  const { depth } = page;
  const internal: string[] = [];
  const external = new Map<string, number>();
  for (const link of page.links) {
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
    // `no key update`: jobs of the source wait for each other, inserts referencing the source do not.
    await tx.select({ id: sources.id }).from(sources).where(eq(sources.id, source.id)).for("no key update");
    const row = await lockFrontierRow(tx, source.id, page.urlNormalized);
    const counted = row?.status === "fetched" && row.lastRunId === runId;
    if (!counted) {
      for (const [toDomain, n] of [...external].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        await tx
          .insert(outlinks)
          .values({ fromSourceId: source.id, toDomain, count: n, runId })
          .onConflictDoUpdate({
            target: [outlinks.fromSourceId, outlinks.toDomain, outlinks.runId],
            set: { count: sql`${outlinks.count} + ${n}` },
          });
      }
    }
    const added = await addInternal(tx, source.id, internal, depth + 1, maxPages, deps, runId);
    await setFrontier(tx, source.id, page.urlNormalized, runId, "fetched", null);
    return added;
  });
}

/**
 * New frontier rows of this run for `internal` (the source row is locked by the caller), enqueued in `tx`. When the
 * stage no longer takes jobs (a job retried after its stage finished, or a run an admin ended), the new rows are
 * only stored `queued` without a run, enqueue nothing and are planned by the next run.
 */
async function addInternal(
  tx: Db,
  sourceId: string,
  internal: string[],
  depth: number,
  maxPages: number,
  deps: Pick<FetchUrlDeps, "enqueue">,
  runId: string,
): Promise<number> {
  if (internal.length === 0) return 0;
  const [row] = await tx
    .select({ n: count() })
    .from(crawlFrontier)
    .where(and(eq(crawlFrontier.sourceId, sourceId), eq(crawlFrontier.lastRunId, runId)));
  const room = maxPages - (row?.n ?? 0);
  if (room <= 0) return 0;
  const known = new Set(
    (
      await tx
        .select({ url: crawlFrontier.urlNormalized })
        .from(crawlFrontier)
        .where(and(eq(crawlFrontier.sourceId, sourceId), inArray(crawlFrontier.urlNormalized, internal)))
    ).map((r) => r.url),
  );
  const fresh = internal.filter((url) => !known.has(url)).slice(0, room);
  if (fresh.length === 0) return 0;
  const accepts = await stageAcceptsJobs(tx, runId, FETCH_URL_STAGE);
  const kept = await tx
    .insert(crawlFrontier)
    .values(fresh.map((url) => ({ sourceId, url, urlNormalized: url, depth, lastRunId: accepts ? runId : null })))
    .onConflictDoNothing({ target: [crawlFrontier.sourceId, crawlFrontier.urlNormalized] })
    .returning({ url: crawlFrontier.url });
  if (!accepts) return kept.length;
  const jobs = kept.map((r) => ({ key: urlJobKey(r.url), sourceId, url: r.url, depth, maxPages }));
  const enqueued = await deps.enqueue(tx, jobs);
  if (enqueued > 0 && !(await extendStage(tx, runId, FETCH_URL_STAGE, enqueued))) {
    throw new Error(`stage ${FETCH_URL_STAGE} of run ${runId} stopped running while locked`);
  }
  return kept.length;
}

/**
 * Links of the document's current version, read from its archived raw HTML (a 304 carries no body): the frontier
 * still grows behind pages that did not change. None when the current version is not HTML.
 */
async function archivedLinks(db: Db, archive: Archive, documentId: string, pageUrl: string, trackingParams: string[]): Promise<string[]> {
  const [version] = await db
    .select({ rawKey: documentVersions.rawKey, contentType: documentVersions.contentType, finalUrl: documentVersions.finalUrl })
    .from(documents)
    .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
    .where(eq(documents.id, documentId));
  if (!version || !version.rawKey.endsWith(".raw.html")) return [];
  const raw = await archive.get(version.rawKey);
  if (!raw) throw new Error(`archived raw content ${version.rawKey} is missing`);
  return extractLinks(decodeHtml(raw, version.contentType), version.finalUrl ?? pageUrl, trackingParams);
}

/**
 * Job `fetch.url`: fetches, converts and archives one URL of a source.
 * 1. The source must still be current (else `source_ended`) and approved (an upload is exempt; else `source_paused`):
 *    otherwise outcome `skipped`, row left `queued`.
 * 2. `upload://<sha256>` reads `uploads/<sha256>.pdf` from the archive (no robots, no HTTP). Otherwise a conditional
 *    GET (validators of the document) through `fetchFollowing`, rate-limited per registrable domain at the
 *    crawl-delay-adjusted rate.
 * 3. 304 → `markChecked` (`not_modified`), links from the archived current version; 404/410 → `markGone` once per
 *    run (`gone` when it turns gone now, else `missing`; a URL without document is `missing` and creates none); more
 *    than `maxRawBytes` → `skipped` (`too_large`).
 * 4. PDF (content type or `.pdf`, only with `rules.pdf`) → `convertPdf`; CSV/GeoJSON/KML → `structuredToMarkdown`;
 *    HTML → the source's converter.
 * 5. Language, publication date, `storeFetched` (document type = source type).
 * 6. Links of HTML (`followLinks`, none for other formats), which also marks the frontier row `fetched`.
 * 7. A 4xx other than 404/410/429 of the page (`HttpError` of the crawl's own request, or a `TargetHttpError` a
 *    converter service reports for the page) marks the row `failed` with `HTTP <status>` and is the outcome `failed`,
 *    not an exception; `RetryableHttpError` is thrown (retry, then `failed_job`), and so is a `ConverterServiceError`
 *    (the service refused, e.g. a lapsed key: every job fails visibly instead of every page).
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
  // Re-checked per job (ruling M3-E-R2): a source ended or paused since the run started is not fetched. Both are
  // temporary verdicts for the row, which stays queued (ruling M3-C-R5); an upload needs no approval, only a
  // current source.
  if (source.validTo !== null) return stop("skipped", "queued", "source_ended");
  if (!isUpload && source.status !== "approved") return stop("skipped", "queued", "source_paused");

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
        const links = await archivedLinks(db, deps.archive, doc.id, job.url, cfg.trackingParams);
        const maxPages = job.maxPages ?? source.crawlRules.maxPages;
        const newUrls = await followLinks(db, source, { urlNormalized, depth: job.depth, links }, maxPages, deps, ctx.runId);
        return { outcome: "not_modified", newUrls };
      }
      if (res.status === 404 || res.status === 410) {
        if (!doc) return stop("missing", "failed", `HTTP ${res.status}`);
        const reason = `HTTP ${res.status}`;
        const gone = await db.transaction(async (tx) => {
          // A retried job of this run finds its row already failed: the miss is counted once per run.
          const row = await lockFrontierRow(tx, source.id, urlNormalized);
          if (row?.status === "failed" && row.reason === reason && row.lastRunId === ctx.runId) return false;
          const marked = await markGone(tx, doc.id, fetchedAt, cfg.goneAfter);
          await setFrontier(tx, source.id, urlNormalized, ctx.runId, "failed", reason);
          return marked.gone && doc.status === "active";
        });
        return { outcome: gone ? "gone" : "missing", newUrls: 0 };
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
      // A render that scripts or a meta refresh moved to another site is not this source's page (like an offsite
      // redirect of the HTTP fetch).
      if (converted.finalUrl && registrableDomain(converted.finalUrl) !== registrableDomain(pageUrl)) {
        return stop("skipped", "skipped", "redirect_offsite");
      }
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

    // Links are followed for every HTML fetch, also when the content is unchanged or reverted.
    const links = html !== null ? extractLinks(html, pageUrl, cfg.trackingParams) : [];
    const maxPages = job.maxPages ?? source.crawlRules.maxPages;
    const newUrls = await followLinks(db, source, { urlNormalized, depth: job.depth, links }, maxPages, deps, ctx.runId);
    return { outcome: stored.outcome, newUrls };
  } catch (error) {
    // A blocked address may be a passing DNS answer: the row stays queued (ruling M3-C-R5).
    if (error instanceof BlockedUrlError) return stop("skipped", "queued", "blocked_address");
    if (error instanceof HttpError) return stop("failed", "failed", `HTTP ${error.status}`);
    throw error;
  }
}
