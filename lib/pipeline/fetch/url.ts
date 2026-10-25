import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import type { SimulatedFetcher } from "@/lib/adapters/fetch/simulated";
import { BlockedUrlError } from "@/lib/adapters/fetch/ssrf";
import { HttpError, type CallContext } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { crawlFrontier, documents, documentVersions, jobOutcomes, outlinks, sources, type DocType, type FrontierStatus } from "@/lib/db/schema";
import { detectLanguage } from "@/lib/domain/documents/language";
import { extractLinks } from "@/lib/domain/documents/links";
import { extractPublishedAt } from "@/lib/domain/documents/metadata";
import { markChecked, markGone, storeFetched } from "@/lib/domain/documents/store";
import { editBase } from "@/lib/domain/revisit/scenario";
import { extendStage, stageAcceptsJobs } from "@/lib/domain/runs";
import { urlAllowed } from "@/lib/domain/sources/crawl-rules";
import { getSource, type Source } from "@/lib/domain/sources/store";
import { normalizeUrl, registrableDomain } from "@/lib/domain/sources/urls";
import { decodeHtml, fetchFollowing, UPLOAD_PREFIX, urlJobKey, type FetchUrlDeps, type FetchUrlOutcome } from "./page";
import { FETCH_SOURCE_STAGE } from "./source";
import { convertAndStore } from "./store-page";
import type { JobData } from "@/lib/jobs/worker";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

export const FETCH_URL_STAGE = "fetch.url";

export type FetchUrlJob = { sourceId: string; url: string; depth: number; documentId?: string; maxPages?: number };

export type FetchUrlResult = { outcome: FetchUrlOutcome; newUrls: number };

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
 * A 404/410 of a known document: `markGone` once per run (a retried job of this run finds its row already failed),
 * the row `failed` with `HTTP <status>`. `gone` when the document turns gone now, else `missing`.
 */
async function recordMiss(
  db: Db,
  sourceId: string,
  urlNormalized: string,
  doc: { id: string; status: string },
  status: number,
  fetchedAt: Date,
  runId: string,
): Promise<FetchUrlResult> {
  const reason = `HTTP ${status}`;
  const gone = await db.transaction(async (tx) => {
    const row = await lockFrontierRow(tx, sourceId, urlNormalized);
    if (row?.status === "failed" && row.reason === reason && row.lastRunId === runId) return false;
    const marked = await markGone(tx, doc.id, fetchedAt, getConfig().fetch.goneAfter);
    await setFrontier(tx, sourceId, urlNormalized, runId, "failed", reason);
    return marked.gone && doc.status === "active";
  });
  return { outcome: gone ? "gone" : "missing", newUrls: 0 };
}

/**
 * A page of a simulated revisit (no request, no robots, no links): the scenario's answer for the URL, given the
 * document's current version (`editBase`, rulings M7-P9 and M7-F-R3).
 * - 304 → `markChecked` (`not_modified`). This also resets a recorded miss (`consecutive_gone` back to 0): the
 *   simulated web holds the page as recorded, so a page that missed once before the clone does not turn gone in the
 *   simulation (no spurious `gone` event). A URL never recorded has nothing to replay (`skipped`, row stays queued);
 *   a document recorded as gone answers 404 again, as recorded.
 * - 404 → `recordMiss` (`missing`, at the second miss `gone`). A `gone` entry whose document was recorded with one
 *   miss (`consecutive_gone = 1`) therefore turns gone at the first simulated revisit already (`goneAfter` 2), as the
 *   real crawl would.
 * - 200 → `storeFetched` with converter `simulated`, `simulated: true`, the Markdown as raw `md` object
 *   (`text/markdown`) and the document's type; the same edit on every fetch yields `unchanged` after the first.
 */
async function fetchSimulated(
  db: Db,
  simulated: SimulatedFetcher,
  archive: Archive,
  page: { sourceId: string; url: string; urlNormalized: string; doc: { id: string; status: string; docType: DocType } | null },
  fetchedAt: Date,
  runId: string,
): Promise<FetchUrlResult> {
  const cfg = getConfig().fetch;
  const { sourceId, urlNormalized, doc } = page;
  if (!doc) {
    await setFrontier(db, sourceId, urlNormalized, runId, "queued", "not_recorded");
    return { outcome: "skipped", newUrls: 0 };
  }
  const base = simulated.covers(urlNormalized) ? await editBase(db, archive, doc.id) : null;
  const res = simulated.respond(urlNormalized, base);
  if (res.status === 404 || (res.status === 304 && doc.status === "gone")) {
    return recordMiss(db, sourceId, urlNormalized, doc, 404, fetchedAt, runId);
  }
  if (res.status === 304) {
    await markChecked(db, doc.id, { at: fetchedAt });
    await setFrontier(db, sourceId, urlNormalized, runId, "fetched", null);
    return { outcome: "not_modified", newUrls: 0 };
  }
  const stored = await storeFetched(
    db,
    archive,
    doc.id,
    {
      fetchedAt,
      raw: new TextEncoder().encode(res.markdown),
      rawExt: "md",
      contentType: "text/markdown",
      finalUrl: null,
      markdown: res.markdown,
      converter: "simulated",
      language: detectLanguage(res.markdown, cfg.languages),
      publishedAt: extractPublishedAt({ html: null, url: page.url, hint: null, fetchedAt }),
      docType: doc.docType,
      etag: null,
      lastModified: null,
      simulated: true,
      runId,
    },
    cfg.chunk,
  );
  await setFrontier(db, sourceId, urlNormalized, runId, "fetched", null);
  return { outcome: stored.outcome, newUrls: 0 };
}

/**
 * Job `fetch.url`: fetches, converts and archives one URL of a source.
 * 1. The source must still be current (else `source_ended`) and approved (an upload is exempt; else `source_paused`):
 *    otherwise outcome `skipped`, row left `queued`.
 * 2. `upload://<sha256>` reads `uploads/<sha256>.pdf` from the archive (no robots, no HTTP). Otherwise a conditional
 *    GET (validators of the document) through `fetchFollowing`, rate-limited per registrable domain at the
 *    crawl-delay-adjusted rate.
 *    With `deps.simulated` the page comes from the scenario instead (`fetchSimulated`), steps 2–7 do not apply.
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
    .select({ id: documents.id, status: documents.status, docType: documents.docType, etag: documents.etag, lastModified: documents.lastModified })
    .from(documents)
    .where(job.documentId ? eq(documents.id, job.documentId) : eq(documents.urlNormalized, urlNormalized));
  const fetchedAt = now();
  if (deps.simulated) {
    return fetchSimulated(db, deps.simulated, deps.archive, { sourceId: source.id, url: job.url, urlNormalized, doc: doc ?? null }, fetchedAt, ctx.runId);
  }

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
        return recordMiss(db, source.id, urlNormalized, doc, res.status, fetchedAt, ctx.runId);
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

    const result = await convertAndStore(
      db,
      source,
      { url: job.url, urlNormalized, documentId: doc?.id ?? null, raw, contentType, finalUrl, etag, lastModified, fetchedAt, ratePerMinute, isUpload },
      deps,
      ctx,
    );
    if (result.kind === "skipped") return stop("skipped", "skipped", result.reason);
    const { html, pageUrl } = result;

    // Links are followed for every HTML fetch, also when the content is unchanged or reverted.
    const links = html !== null ? extractLinks(html, pageUrl, cfg.trackingParams) : [];
    const maxPages = job.maxPages ?? source.crawlRules.maxPages;
    const newUrls = await followLinks(db, source, { urlNormalized, depth: job.depth, links }, maxPages, deps, ctx.runId);
    return { outcome: result.outcome, newUrls };
  } catch (error) {
    // A blocked address may be a passing DNS answer: the row stays queued (ruling M3-C-R5).
    if (error instanceof BlockedUrlError) return stop("skipped", "queued", "blocked_address");
    if (error instanceof HttpError) return stop("failed", "failed", `HTTP ${error.status}`);
    throw error;
  }
}
