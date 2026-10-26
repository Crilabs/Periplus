import type { DiscoveryConfig } from "@/lib/config";
import type { DocType } from "@/lib/db/schema";
import { safeDecode } from "./urls";

/*
 * Reading a source type off URLs and the ignored domains of the source finding: the part of the old proposals that the
 * place websites (`attachPlaceWebsite`, `websites.ts`, `website-find.ts`) still need.
 */

type ProposalsConfig = DiscoveryConfig["proposals"];

export function httpUrls(urls: string[]): URL[] {
  return urls.flatMap((u) => {
    try {
      const url = new URL(u);
      return url.protocol === "http:" || url.protocol === "https:" ? [url] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The first type hint (in config order) whose pattern matches `host + pathname` (case-insensitive, path decoded)
 * of at least half of the URLs; `defaultType` without URLs or without such a hint.
 */
export function suggestType(urls: string[], cfg: ProposalsConfig): DocType {
  const targets = httpUrls(urls).map((u) => u.hostname + safeDecode(u.pathname));
  if (targets.length === 0) return cfg.defaultType;
  for (const hint of cfg.typeHints) {
    const re = new RegExp(hint.pattern, "i");
    if (targets.filter((t) => re.test(t)).length * 2 >= targets.length) return hint.type;
  }
  return cfg.defaultType;
}

/** `domain` is one of `cfg.ignoreDomains` or a subdomain of one. */
export const isIgnoredDomain = (domain: string, cfg: Pick<ProposalsConfig, "ignoreDomains">) =>
  cfg.ignoreDomains.some((i) => domain === i || domain.endsWith(`.${i}`));
