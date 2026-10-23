import { and, eq, isNull } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { crawlRulesSchema } from "@/lib/domain/sources/crawl-rules";
import { assertAllowedSourceDomain } from "@/lib/domain/sources/forbidden-domains";
import { getSource, type Source } from "@/lib/domain/sources/store";

/** Crawl rules of a research source: a page is fetched on its own, nothing is crawled from it. */
const RESEARCH_CRAWL_RULES = crawlRulesSchema.parse({
  startUrls: [],
  allow: [],
  deny: [],
  maxDepth: 0,
  maxPages: 1,
  ratePerMinute: 20,
  render: "auto",
  converter: "auto",
  pdf: true,
});

async function currentSource(db: Db, domain: string): Promise<Source | null> {
  const [row] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.domain, domain), isNull(sources.validTo)));
  return row ? getSource(db, row.id) : null;
}

/**
 * The source a research hit page is stored under. A current source of the registrable `domain` is returned as it is
 * (also `rejected` or `proposed`: a page is judged by itself, not by its domain); otherwise one is created
 * (`approved`, origin `research`, type `other`, weight 0.5, no crawl). Concurrent calls for one domain create one
 * source (the unique index on the current domain; the loser reads it). A forbidden domain throws
 * `ForbiddenSourceDomain`.
 */
export async function ensureResearchSource(db: Db, domain: string): Promise<Source> {
  const known = await currentSource(db, domain);
  if (known) return known;
  assertAllowedSourceDomain(domain, getConfig().delivery.forbiddenDomains);
  const [inserted] = await db
    .insert(sources)
    .values({ domain, name: domain, type: "other", weight: 0.5, status: "approved", crawlRules: RESEARCH_CRAWL_RULES, origin: "research" })
    .onConflictDoNothing()
    .returning({ id: sources.id });
  const source = inserted ? await getSource(db, inserted.id) : await currentSource(db, domain);
  if (!source) throw new Error(`research source ${domain} neither inserted nor found`);
  return source;
}
