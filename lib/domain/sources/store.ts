import { and, eq } from "drizzle-orm";
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
    })
    .from(sources)
    .where(eq(sources.id, id));
  if (!row) return null;
  return { ...row, crawlRules: crawlRulesSchema.parse(row.crawlRules) };
}

/**
 * Sets status and reason of the source `id` (the history trigger records the change); throws for an unknown id.
 * With `from`, only a source still in that status changes; returns whether it changed.
 */
export async function setSourceStatus(
  db: Db,
  id: string,
  status: SourceStatus,
  reason: string | null,
  opts: { from?: SourceStatus } = {},
): Promise<boolean> {
  const updated = await db
    .update(sources)
    .set({ status, statusReason: reason })
    .where(opts.from ? and(eq(sources.id, id), eq(sources.status, opts.from)) : eq(sources.id, id))
    .returning({ id: sources.id });
  if (updated.length > 0) return true;
  if (opts.from) return false;
  throw new Error(`source ${id} not found`);
}
