import { getDomain } from "tldts";

/** True when `key` matches a tracking-parameter entry; an entry ending in `*` is a prefix pattern. */
function isTrackingParam(key: string, trackingParams: string[]): boolean {
  const k = key.toLowerCase();
  return trackingParams.some((p) => (p.endsWith("*") ? k.startsWith(p.slice(0, -1).toLowerCase()) : k === p.toLowerCase()));
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Canonical form of an http(s) URL for de-duplication (spec 05): lower-case host (IDN as punycode), no default
 * port, no fragment, no tracking parameters, raw query segments (never re-encoded) sorted by decoded key then value, empty query
 * dropped, credentials and trailing host dot removed. The path is kept as is. Returns null for other schemes and unparsable input.
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
  u.username = "";
  u.password = "";
  if (u.hostname.endsWith(".")) u.hostname = u.hostname.slice(0, -1);
  const raw = u.search.startsWith("?") ? u.search.slice(1) : "";
  const kept = raw
    .split("&")
    .filter((seg) => seg !== "")
    .map((seg) => {
      const eq = seg.indexOf("=");
      const rawKey = eq === -1 ? seg : seg.slice(0, eq);
      return { seg, key: safeDecode(rawKey.replace(/\+/g, " ")), value: eq === -1 ? "" : seg.slice(eq + 1) };
    })
    .filter(({ key }) => !isTrackingParam(key, trackingParams));
  kept.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  u.search = kept.map(({ seg }) => seg).join("&");
  return u.href;
}

/** Registrable domain of the URL's host by the Public Suffix List; the host itself for IPs and unknown suffixes. */
export function registrableDomain(url: string): string {
  const host = new URL(url).hostname;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}
