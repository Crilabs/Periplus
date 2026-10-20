/*
 * Forbidden domains (`config/delivery.json` `forbiddenDomains`, Navily and Google): their content never leaves
 * Periplus (Teil B "Keine fremden Inhalte", anti-goal "Navily-Daten, Google-Inhalte"). A source on one of them is never
 * approved, whitelisted or proposed (ruling M6-D-R2), and the package validation blocks any value citing one.
 */

/** Lower case, without the one trailing dot of a fully qualified host (`navily.com.`). */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/** `host` is one of `domains` or a subdomain of one. */
export function isForbiddenHost(host: string, domains: readonly string[]): boolean {
  const h = normalizeHost(host);
  return domains.some((d) => {
    const domain = normalizeHost(d);
    return h === domain || h.endsWith(`.${domain}`);
  });
}

/** The host of `url` is forbidden; an unparsable URL counts as forbidden. */
export function isForbiddenUrl(url: string, domains: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  return isForbiddenHost(host, domains);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` names a forbidden domain as a bare host (`navily.com/…`, `goo.gl/x`, `maps.google.com`), any case. */
export function mentionsForbiddenDomain(text: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return false;
  const alternatives = domains.map((d) => escape(normalizeHost(d))).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}-])(?:[\\p{L}\\p{N}-]+\\.)*(?:${alternatives})\\.?(?![\\p{L}\\p{N}-]|\\.[\\p{L}\\p{N}])`, "iu").test(text);
}

/** A source for a forbidden domain was to be created, approved or resumed. */
export class ForbiddenSourceDomain extends Error {
  constructor(readonly domain: string) {
    super(`${domain} is a forbidden domain`);
    this.name = "ForbiddenSourceDomain";
  }
}

/** Throws `ForbiddenSourceDomain` for a forbidden source domain. */
export function assertAllowedSourceDomain(domain: string, domains: readonly string[]): void {
  if (isForbiddenHost(domain, domains)) throw new ForbiddenSourceDomain(domain);
}
