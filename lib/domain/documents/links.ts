import { parseHTML } from "linkedom";
import { normalizeUrl } from "@/lib/domain/sources/urls";

function resolve(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * Outgoing links of a page: every `a[href]` resolved against `<base href>` (else `baseUrl`), http(s) only,
 * normalized, deduplicated in document order; links back to the page itself (e.g. `#top`) are dropped.
 * A `<meta name="robots">` with `nofollow` yields no links.
 */
export function extractLinks(html: string, baseUrl: string, trackingParams: string[]): string[] {
  const { document } = parseHTML(html);
  for (const meta of document.querySelectorAll("meta[name]")) {
    if (meta.getAttribute("name")?.trim().toLowerCase() !== "robots") continue;
    const directives = (meta.getAttribute("content") ?? "").toLowerCase().split(/[\s,]+/);
    if (directives.includes("nofollow") || directives.includes("none")) return [];
  }
  const baseHref = document.querySelector("base[href]")?.getAttribute("href");
  const base = (baseHref && resolve(baseHref, baseUrl)) || baseUrl;
  const self = normalizeUrl(baseUrl, trackingParams);
  const links = new Set<string>();
  for (const a of document.querySelectorAll("a[href]")) {
    const resolved = resolve(a.getAttribute("href") ?? "", base);
    const url = resolved && normalizeUrl(resolved, trackingParams);
    if (url && url !== self) links.add(url);
  }
  return [...links];
}
