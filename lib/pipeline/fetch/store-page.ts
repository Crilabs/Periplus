import { resolveConverter } from "@/lib/adapters/fetch";
import type { CallContext } from "@/lib/adapters/http";
import { convertPdf } from "@/lib/adapters/pdf";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { detectLanguage } from "@/lib/domain/documents/language";
import { extractPublishedAt } from "@/lib/domain/documents/metadata";
import { ensureDocument, storeFetched, type StoreOutcome } from "@/lib/domain/documents/store";
import { structuredToMarkdown } from "@/lib/domain/documents/structured";
import type { Source } from "@/lib/domain/sources/store";
import { registrableDomain } from "@/lib/domain/sources/urls";
import { decodeHtml, formatOf, type FetchUrlDeps } from "./page";

/** A fetched page body with what the answer said about it, ready to be converted and stored. */
export type FetchedPage = {
  url: string;
  urlNormalized: string;
  /** The page's document when it exists; else one is created for the source. */
  documentId: string | null;
  raw: Uint8Array;
  contentType: string | null;
  finalUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: Date;
  ratePerMinute: number;
  isUpload: boolean;
  /** Convert a PDF although the source's rules say `pdf: false` (research fetches; an upload is always allowed). */
  allowPdf?: boolean;
};

export type StoredPage =
  | { kind: "stored"; documentId: string; versionId: string; outcome: StoreOutcome; html: string | null; pageUrl: string }
  | { kind: "skipped"; reason: "pdf_disabled" | "redirect_offsite" | "unsupported_type" };

/**
 * Format, conversion, document and version of one fetched page (shared by the crawl's `fetchUrl` and the research
 * fetch): PDF (only with `rules.pdf`, an upload is exempt) through `convertPdf`, CSV/GeoJSON/KML through
 * `structuredToMarkdown`, HTML through the source's converter (a render that ended on another site is
 * `redirect_offsite`), anything else `unsupported_type`. Then `ensureDocument` and `storeFetched`.
 */
export async function convertAndStore(
  db: Db,
  source: Source,
  page: FetchedPage,
  deps: Pick<FetchUrlDeps, "archive" | "converters" | "pdf">,
  ctx: CallContext & { runId: string },
): Promise<StoredPage> {
  const cfg = getConfig().fetch;
  const callCtx = { ...ctx, db, sourceId: source.id };
  const { raw, contentType, finalUrl } = page;
  const pageUrl = finalUrl ?? page.url;
  const format = formatOf(contentType, pageUrl);
  let markdown: string;
  let converter: string;
  let rawExt: string;
  let html: string | null = null;
  let hint: string | null = null;
  if (format.kind === "pdf") {
    if (!source.crawlRules.pdf && !page.isUpload && !page.allowPdf) return { kind: "skipped", reason: "pdf_disabled" };
    const pdf = await convertPdf(raw, { ...deps.pdf, cfg: cfg.pdf, archive: deps.archive }, { runId: ctx.runId, stage: ctx.stage, sourceId: source.id });
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
    const rate = { key: `domain:${registrableDomain(pageUrl)}`, perMinute: page.ratePerMinute, maxWaitMs: cfg.maxRateWaitMs };
    const converted = await deps.converters[name].convert(
      { url: pageUrl, html: name === "local" ? html : null, boilerplateSelectors: source.crawlRules.boilerplateSelectors, render: source.crawlRules.render, rate },
      callCtx,
    );
    // A render that scripts or a meta refresh moved to another site is not this source's page (like an offsite
    // redirect of the HTTP fetch).
    if (converted.finalUrl && registrableDomain(converted.finalUrl) !== registrableDomain(pageUrl)) {
      return { kind: "skipped", reason: "redirect_offsite" };
    }
    markdown = converted.markdown;
    converter = name;
    hint = converted.publishedHint;
    rawExt = "html";
  } else {
    return { kind: "skipped", reason: "unsupported_type" };
  }

  const documentId =
    page.documentId ?? (await ensureDocument(db, { sourceId: source.id, url: page.url, urlNormalized: page.urlNormalized, docType: source.type })).id;
  const stored = await storeFetched(
    db,
    deps.archive,
    documentId,
    {
      fetchedAt: page.fetchedAt,
      raw,
      rawExt,
      contentType,
      finalUrl,
      markdown,
      converter,
      language: detectLanguage(markdown, cfg.languages),
      publishedAt: extractPublishedAt({ html, url: pageUrl, hint, fetchedAt: page.fetchedAt }),
      docType: source.type,
      etag: page.etag,
      lastModified: page.lastModified,
      runId: ctx.runId,
    },
    cfg.chunk,
  );
  return { kind: "stored", documentId, versionId: stored.versionId, outcome: stored.outcome, html, pageUrl };
}
