import { parseHTML } from "linkedom";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
/** `/YYYY/MM` with an optional `/DD` in the URL path, not inside a longer digit run. */
const URL_DATE = /\/((?:19|20)\d{2})\/(0[1-9]|1[0-2])(?:\/(0[1-9]|[12]\d|3[01]))?(?!\d)/;
const MIN_DATE = "1990-01-01";
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` when the parts name a real calendar day. */
function calendarDate(y: string, m: string, d: string): string | null {
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const iso = date.toISOString().slice(0, 10);
  return iso === `${y}-${m}-${d}` ? iso : null;
}

/** Date part of an ISO 8601 value as written (the publisher's local day), or null. */
function isoDay(value: string | null | undefined): string | null {
  const m = value?.trim().match(ISO_DATE);
  return m ? calendarDate(m[1], m[2], m[3]) : null;
}

/** First string `datePublished` of the JSON-LD items, top level or inside `@graph`. */
function jsonLdDatePublished(data: unknown): string | null {
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.datePublished === "string") return rec.datePublished;
    if (rec["@graph"] !== undefined) {
      const inner = jsonLdDatePublished(rec["@graph"]);
      if (inner) return inner;
    }
  }
  return null;
}

function htmlCandidates(html: string): Array<string | null> {
  const { document } = parseHTML(html);
  const meta = document.querySelector('meta[property="article:published_time"]')?.getAttribute("content") ?? null;
  let jsonLd: string | null = null;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      jsonLd = jsonLdDatePublished(JSON.parse(script.textContent ?? ""));
    } catch {
      continue;
    }
    if (jsonLd) break;
  }
  return [isoDay(meta), isoDay(jsonLd)];
}

function urlDate(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = path.match(URL_DATE);
  return m ? calendarDate(m[1], m[2], m[3] ?? "01") : null;
}

/**
 * Publication day (`YYYY-MM-DD`) of a page. Candidates in order: `meta[property=article:published_time]`, JSON-LD
 * `datePublished` (also in `@graph`), the converter's `hint`, a `/YYYY/MM(/DD)` URL path (missing day → 01).
 * A candidate before 1990 or later than `fetchedAt` + 1 day is discarded and the next one tried.
 */
export function extractPublishedAt(input: { html: string | null; url: string; hint: string | null; fetchedAt: Date }): string | null {
  const latest = new Date(input.fetchedAt.getTime() + DAY_MS).toISOString().slice(0, 10);
  const candidates = [...(input.html ? htmlCandidates(input.html) : []), isoDay(input.hint), urlDate(input.url)];
  return candidates.find((d): d is string => d !== null && d >= MIN_DATE && d <= latest) ?? null;
}

/** `observed_at` of a version: the publication day if known, otherwise the UTC day of the fetch. */
export function observedFrom(publishedAt: string | null, fetchedAt: Date): { observedAt: string; basis: "published" | "fetched" } {
  return publishedAt
    ? { observedAt: publishedAt, basis: "published" }
    : { observedAt: fetchedAt.toISOString().slice(0, 10), basis: "fetched" };
}
