import { parseHTML } from "linkedom";
import { z } from "zod";
import { registrableDomain, safeDecode } from "./urls";

export const CONVERTERS = ["jina", "firecrawl", "local"] as const;
export type Converter = (typeof CONVERTERS)[number];

/** Longest crawl-rule pattern: every URL of a crawl is tested against every pattern (ReDoS guard). */
export const MAX_PATTERN_LENGTH = 200;

/** A string of at most `MAX_PATTERN_LENGTH` characters that compiles as a JavaScript regular expression. */
export const regexPattern = z.string().max(MAX_PATTERN_LENGTH).refine((s) => {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}, "must be a valid regular expression");

let selectorProbe: ReturnType<typeof parseHTML>["document"] | undefined;

/** Whether the converter can use `selector`: it runs against an empty document as `htmlToMarkdown` runs it. */
function isValidSelector(selector: string): boolean {
  selectorProbe ??= parseHTML("<!doctype html><html><body></body></html>").document;
  try {
    selectorProbe.querySelectorAll(selector);
    return true;
  } catch {
    return false;
  }
}

/** Field schemas of the crawl rules (spec 05), without defaults. */
const fields = {
  startUrls: z.array(z.url({ protocol: /^https?$/ })),
  /** Regexes against the decoded `pathname + search`; empty = everything on the source's domain. */
  allow: z.array(regexPattern),
  /** Regexes against the decoded `pathname + search`; a match wins over `allow`. */
  deny: z.array(regexPattern),
  maxDepth: z.number().int().min(0).max(10),
  maxPages: z.number().int().min(1).max(5000),
  ratePerMinute: z.number().min(1).max(120),
  render: z.enum(["never", "always", "auto"]),
  converter: z.enum(["auto", ...CONVERTERS]),
  pdf: z.boolean(),
  /** CSS selectors removed before conversion (boilerplate per source). */
  boilerplateSelectors: z.array(z.string().trim().min(1).refine(isValidSelector, "must be a valid CSS selector")),
};

export const crawlRulesSchema = z.strictObject({
  startUrls: fields.startUrls.default([]),
  allow: fields.allow.default([]),
  deny: fields.deny.default([]),
  maxDepth: fields.maxDepth.default(3),
  maxPages: fields.maxPages.default(500),
  ratePerMinute: fields.ratePerMinute.default(20),
  render: fields.render.default("auto"),
  converter: fields.converter.default("auto"),
  pdf: fields.pdf.default(true),
  boilerplateSelectors: fields.boilerplateSelectors.default([]),
});

export type CrawlRules = z.infer<typeof crawlRulesSchema>;

export const DEFAULT_CRAWL_RULES: CrawlRules = crawlRulesSchema.parse({});

export type UrlVerdict = { ok: true } | { ok: false; reason: "other_domain" | "not_allowed" | "denied" | "pdf_disabled" };

/**
 * Whether a URL may be crawled for a source: same registrable domain, no `deny` match, an `allow` match (empty
 * `allow` = all), no PDF when `pdf` is off. Unparsable URLs count as another domain.
 */
export function urlAllowed(url: string, rules: CrawlRules, sourceDomain: string): UrlVerdict {
  let u: URL;
  let domain: string;
  try {
    u = new URL(url);
    domain = registrableDomain(url);
  } catch {
    return { ok: false, reason: "other_domain" };
  }
  let source: string;
  try {
    source = new URL("http://" + sourceDomain).hostname;
  } catch {
    return { ok: false, reason: "other_domain" };
  }
  if (domain !== source) return { ok: false, reason: "other_domain" };
  const target = safeDecode(u.pathname) + u.search;
  if (rules.deny.some((p) => new RegExp(p).test(target))) return { ok: false, reason: "denied" };
  if (rules.allow.length > 0 && !rules.allow.some((p) => new RegExp(p).test(target))) {
    return { ok: false, reason: "not_allowed" };
  }
  if (!rules.pdf && u.pathname.toLowerCase().endsWith(".pdf")) return { ok: false, reason: "pdf_disabled" };
  return { ok: true };
}
