import { and, gt, inArray, sql } from "drizzle-orm";
import type { CallContext, Transport } from "@/lib/adapters/http";
import { sitelinkCounts } from "@/lib/adapters/wikidata";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { wikidataSitelinks } from "@/lib/db/schema";

/** Rows per statement when reading or upserting sitelink counts. */
const SITELINK_ROWS = 1000;

/**
 * The Wikidata sitelink counts (importance signal, ruling M5-P1) of `qids`, kept in `wikidata_sitelinks`: a count
 * fetched within `datasets.sitelinks.reuseDays` before `now` is reused without a call, the others are fetched
 * (`sitelinkCounts`, 50 per request) and upserted with `fetched_at` = `now`; an item Wikidata no longer knows counts 0.
 * Shared by the dataset `sitelinks` and the stage `gazetteer.land`. Returns the count of every asked id.
 */
export async function ensureSitelinkCounts(
  db: Db,
  qids: string[],
  deps: { transport: Transport },
  ctx: CallContext,
  now: Date,
): Promise<{ counts: Map<string, number>; fetched: number; reused: number }> {
  const { datasets, gazetteer } = getConfig();
  const ids = [...new Set(qids)].sort();
  const counts = new Map<string, number>();
  const freshAfter = new Date(now.getTime() - datasets.sitelinks.reuseDays * 86_400_000);
  for (let i = 0; i < ids.length; i += SITELINK_ROWS) {
    const rows = await db
      .select({ qid: wikidataSitelinks.wikidataId, sitelinks: wikidataSitelinks.sitelinks })
      .from(wikidataSitelinks)
      .where(and(inArray(wikidataSitelinks.wikidataId, ids.slice(i, i + SITELINK_ROWS)), gt(wikidataSitelinks.fetchedAt, freshAfter)));
    for (const r of rows) counts.set(r.qid, r.sitelinks);
  }
  const stale = ids.filter((id) => !counts.has(id));
  if (stale.length > 0) {
    const fetched = await sitelinkCounts(deps.transport, stale, ctx, gazetteer.wikidata);
    for (let i = 0; i < stale.length; i += SITELINK_ROWS) {
      const values = stale.slice(i, i + SITELINK_ROWS).map((id) => ({ wikidataId: id, sitelinks: fetched.get(id) ?? 0, fetchedAt: now }));
      await db
        .insert(wikidataSitelinks)
        .values(values)
        .onConflictDoUpdate({
          target: wikidataSitelinks.wikidataId,
          set: { sitelinks: sql`excluded.sitelinks`, fetchedAt: sql`excluded.fetched_at` },
        });
      for (const v of values) counts.set(v.wikidataId, v.sitelinks);
    }
  }
  return { counts, fetched: stale.length, reused: ids.length - stale.length };
}
