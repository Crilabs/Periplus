import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { BlockedUrlError } from "@/lib/adapters/fetch/ssrf";
import { HttpError, type CallContext } from "@/lib/adapters/http";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, researchHits } from "@/lib/db/schema";
import { markChecked, markGone } from "@/lib/domain/documents/store";
import { researchCandidates } from "@/lib/domain/research/candidates";
import { ensureResearchSource } from "@/lib/domain/research/sources";
import { ForbiddenSourceDomain } from "@/lib/domain/sources/forbidden-domains";
import { normalizeUrl, registrableDomain } from "@/lib/domain/sources/urls";
import type { JobData } from "@/lib/jobs/worker";
import { convertAndStore } from "@/lib/pipeline/fetch/store-page";
import { fetchFollowing, urlJobKey, type FetchUrlDeps } from "@/lib/pipeline/fetch/url";
import { researchScope } from "./search";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

export const RESEARCH_FETCH_STAGE = "research.fetch";

export type ResearchFetchResult = {
  outcome: "stored" | "unchanged" | "skipped" | "gone" | "failed";
  versionId: string | null;
  reason?: string;
};

/**
 * Plan of the stage `research.fetch`: one job per distinct `url_normalized` among the hits of the run's candidates
 * (several candidates sharing a page fetch it once), except a URL whose document has a version younger than
 * `research.refetchDays`.
 */
export async function planResearchFetch(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> {
  const cfg = getConfig().research;
  const placeIds = await researchCandidates(db, researchScope(run.params));
  if (placeIds.length === 0) return [];
  const urls = (
    await db
      .selectDistinct({ url: researchHits.urlNormalized })
      .from(researchHits)
      .where(inArray(researchHits.placeId, placeIds))
      .orderBy(researchHits.urlNormalized)
  ).map((r) => r.url);
  if (urls.length === 0) return [];
  const fresh = new Set(
    (
      await db
        .select({ url: documents.urlNormalized })
        .from(documents)
        .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
        .where(
          and(
            inArray(documents.urlNormalized, urls),
            gt(documentVersions.fetchedAt, sql`now() - make_interval(days => ${cfg.refetchDays})`),
          ),
        )
    ).map((r) => r.url),
  );
  return urls.filter((url) => !fresh.has(url)).map((url) => ({ key: urlJobKey(url), url }));
}

/**
 * Job `research.fetch`: fetches, converts and archives one hit page. The page's domain gets a research source when it
 * has none; an existing source of any status is used as it is (no status check: a page is judged by itself). No
 * frontier, no links. A 404/410 of a known document goes through `markGone` (`gone` once it turns gone, else
 * `failed`; an already gone one stays `failed`), without a document it is `failed`; a body over `fetch.maxRawBytes` is `skipped` (`too_large`), as are a
 * robots.txt refusal (`robots`), an offsite redirect, a blocked address and a PDF/format that cannot be stored.
 */
export async function fetchResearchPage(
  db: Db,
  url: string,
  deps: FetchUrlDeps,
  ctx: CallContext & { runId: string },
): Promise<ResearchFetchResult> {
  const cfg = getConfig().fetch;
  const fetchedAt = (deps.now ?? (() => new Date()))();
  const urlNormalized = normalizeUrl(url, cfg.trackingParams) ?? url;
  const skipped = (reason: string): ResearchFetchResult => ({ outcome: "skipped", versionId: null, reason });
  let source;
  try {
    source = await ensureResearchSource(db, registrableDomain(url));
  } catch (error) {
    if (error instanceof ForbiddenSourceDomain) return skipped("forbidden_domain");
    throw error;
  }
  const callCtx = { ...ctx, db, sourceId: source.id };
  const [doc] = await db
    .select({ id: documents.id, status: documents.status, etag: documents.etag, lastModified: documents.lastModified, currentVersionId: documents.currentVersionId })
    .from(documents)
    .where(eq(documents.urlNormalized, urlNormalized));

  try {
    const fetched = await fetchFollowing(db, source, url, doc ?? null, deps, callCtx);
    if (fetched.kind === "stop") {
      return fetched.outcome === "failed" ? { outcome: "failed", versionId: null, reason: fetched.reason } : skipped(fetched.reason);
    }
    const { res } = fetched;
    if (res.status === 304) {
      if (!doc) return { outcome: "failed", versionId: null, reason: "HTTP 304" };
      await markChecked(db, doc.id, { at: fetchedAt, etag: res.headers.etag, lastModified: res.headers["last-modified"] });
      return { outcome: "unchanged", versionId: doc.currentVersionId };
    }
    if (res.status === 404 || res.status === 410) {
      const reason = `HTTP ${res.status}`;
      if (!doc) return { outcome: "failed", versionId: null, reason };
      const marked = await markGone(db, doc.id, fetchedAt, cfg.goneAfter);
      // `gone` only on the transition active -> gone (as the crawl's recordMiss).
      return marked.gone && doc.status === "active" ? { outcome: "gone", versionId: null, reason } : { outcome: "failed", versionId: null, reason };
    }
    const declared = Number(res.headers["content-length"]);
    if (res.truncated || res.body.byteLength > cfg.maxRawBytes || declared > cfg.maxRawBytes) return skipped("too_large");

    const stored = await convertAndStore(
      db,
      source,
      {
        url,
        urlNormalized,
        documentId: doc?.id ?? null,
        raw: res.body,
        contentType: res.headers["content-type"] ?? null,
        finalUrl: fetched.finalUrl === url ? null : fetched.finalUrl,
        etag: res.headers.etag ?? null,
        lastModified: res.headers["last-modified"] ?? null,
        fetchedAt,
        ratePerMinute: fetched.ratePerMinute,
        isUpload: false,
        allowPdf: true,
      },
      deps,
      ctx,
    );
    if (stored.kind === "skipped") return skipped(stored.reason);
    return { outcome: stored.outcome === "unchanged" ? "unchanged" : "stored", versionId: stored.versionId };
  } catch (error) {
    if (error instanceof BlockedUrlError) return skipped("blocked_address");
    if (error instanceof HttpError) return { outcome: "failed", versionId: null, reason: `HTTP ${error.status}` };
    throw error;
  }
}
