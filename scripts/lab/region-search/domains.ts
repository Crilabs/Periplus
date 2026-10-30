import { registrableDomain } from "../../../lib/domain/sources/urls";

/** `tripadvisor.*` in `config/research.json` `skipDomains`, made concrete for the web search tool's `blocked_domains`. */
const WILDCARD_TLDS = ["com", "de", "co.uk", "it", "fr", "com.gr", "at", "ch", "es", "nl"];

/** `pattern` matches `domain` itself and its subdomains; `name.*` matches `name.<any suffix>`. */
export function isSkippedDomain(domain: string, patterns: string[]): boolean {
  const host = domain.toLowerCase();
  return patterns.some((p) => {
    const pattern = p.toLowerCase();
    if (pattern.endsWith(".*")) {
      const stem = pattern.slice(0, -2);
      return host.split(".").some((_, i, parts) => parts[i] === stem && i < parts.length - 1 && parts.slice(0, i).every(Boolean));
    }
    return host === pattern || host.endsWith(`.${pattern}`);
  });
}

export function resolveBlockedDomains(patterns: string[]): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    if (p.endsWith(".*")) for (const tld of WILDCARD_TLDS) out.add(`${p.slice(0, -2)}.${tld}`);
    else out.add(p);
  }
  return [...out];
}

export function registrableDomainOf(url: string): string {
  return registrableDomain(url);
}
