import { parse } from "tldts";

/*
 * Forbidden domains (`config/delivery.json` `forbiddenDomains`, Navily and Google): their content never leaves
 * Periplus (Teil B "Keine fremden Inhalte", anti-goal "Navily-Daten, Google-Inhalte"). A source on one of them is never
 * approved, whitelisted or proposed (ruling M6-D-R2), and the package validation blocks any value citing one.
 * An entry `label.*` forbids that registrable label on any ICANN public suffix (`google.*`: `google.de`,
 * `books.google.co.uk`, `google.com.gr`; SEC-4); a private suffix (`google.github.io`) or an unknown TLD is not matched.
 */

const WILDCARD = ".*";

/** Lower case, without the one trailing dot of a fully qualified host (`navily.com.`). */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/** `host` is one of `domains` or a subdomain of one, or its registrable label matches a `label.*` entry. */
export function isForbiddenHost(host: string, domains: readonly string[]): boolean {
  const h = normalizeHost(host);
  const labels = wildcardLabels(domains);
  if (labels.length > 0) {
    const parsed = parse(h);
    if (parsed.isIcann === true && parsed.domainWithoutSuffix != null && labels.includes(parsed.domainWithoutSuffix)) return true;
  }
  return exactDomains(domains).some((domain) => h === domain || h.endsWith(`.${domain}`));
}

const wildcardLabels = (domains: readonly string[]) =>
  domains.filter((d) => d.endsWith(WILDCARD)).map((d) => normalizeHost(d.slice(0, -WILDCARD.length)));
const exactDomains = (domains: readonly string[]) => domains.filter((d) => !d.endsWith(WILDCARD)).map(normalizeHost);

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

/** A bare host in running text: dot-separated labels, not glued to a letter, digit or hyphen on either side. */
const HOST_IN_TEXT = /(?<![\p{L}\p{N}.-])(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]+(?![\p{L}\p{N}-]|\.[\p{L}\p{N}])/giu;

/** `text` names a forbidden domain as a bare host (`navily.com/…`, `goo.gl/x`, `maps.google.com`, `maps.google.it`), any case. */
export function mentionsForbiddenDomain(text: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return false;
  const exact = exactDomains(domains);
  if (exact.length > 0) {
    const alternatives = exact.map(escape).join("|");
    if (new RegExp(`(?<![\\p{L}\\p{N}-])(?:[\\p{L}\\p{N}-]+\\.)*(?:${alternatives})\\.?(?![\\p{L}\\p{N}-]|\\.[\\p{L}\\p{N}])`, "iu").test(text)) return true;
  }
  const wildcards = domains.filter((d) => d.endsWith(WILDCARD));
  if (wildcards.length === 0) return false;
  return [...text.matchAll(HOST_IN_TEXT)].some((m) => isForbiddenHost(m[0], wildcards));
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
