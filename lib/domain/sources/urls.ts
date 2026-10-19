import { getDomain } from "tldts";

/** True when `key` matches a tracking-parameter entry; an entry ending in `*` is a prefix pattern. */
function isTrackingParam(key: string, trackingParams: string[]): boolean {
  const k = key.toLowerCase();
  return trackingParams.some((p) => (p.endsWith("*") ? k.startsWith(p.slice(0, -1).toLowerCase()) : k === p.toLowerCase()));
}

/**
 * Canonical form of an http(s) URL for de-duplication (spec 05): lower-case host (IDN as punycode), no default
 * port, no fragment, no tracking parameters, query sorted by key then value, empty query dropped. The path is
 * kept as is. Returns null for other schemes and unparsable input.
 */
export function normalizeUrl(url: string, trackingParams: string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  const params = [...u.searchParams].filter(([k]) => !isTrackingParam(k, trackingParams));
  params.sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0));
  u.search = params.length > 0 ? new URLSearchParams(params).toString() : "";
  return u.href;
}

/** Registrable domain of the URL's host by the Public Suffix List; the host itself for IPs and unknown suffixes. */
export function registrableDomain(url: string): string {
  const host = new URL(url).hostname;
  return getDomain(host) ?? host;
}
