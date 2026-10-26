import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { sources, type ChangeRate, type DocType, type SourceOrigin, type SourceStatus } from "@/lib/db/schema";
import { crawlRulesSchema, type CrawlRules } from "./crawl-rules";

export type Source = {
  id: string;
  domain: string;
  name: string;
  type: DocType;
  weight: number;
  status: SourceStatus;
  statusReason: string | null;
  crawlRules: CrawlRules;
  changeRate: ChangeRate;
  languages: string[];
  origin: SourceOrigin;
  /** Set when the source has ended (never deleted, spec 02); an ended source is neither crawled nor changed. */
  validTo: string | null;
};

/** The source `id` with its crawl rules parsed (defaults filled in; invalid stored rules throw); null when unknown. */
export async function getSource(db: Db, id: string): Promise<Source | null> {
  const [row] = await db
    .select({
      id: sources.id,
      domain: sources.domain,
      name: sources.name,
      type: sources.type,
      weight: sources.weight,
      status: sources.status,
      statusReason: sources.statusReason,
      crawlRules: sources.crawlRules,
      changeRate: sources.changeRate,
      languages: sources.languages,
      origin: sources.origin,
      validTo: sources.validTo,
    })
    .from(sources)
    .where(eq(sources.id, id));
  if (!row) return null;
  return { ...row, crawlRules: crawlRulesSchema.parse(row.crawlRules) };
}
