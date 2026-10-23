import { and, asc, eq } from "drizzle-orm";
import type { ResearchConfig } from "@/lib/config/schemas";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { researchHits, serpResults } from "@/lib/db/schema";
import { isForbiddenUrl } from "@/lib/domain/sources/forbidden-domains";

/**
 * Takes over the results of one search as hits of a candidate: without `skipDomains` and forbidden domains, a URL
 * the candidate already has for this purpose is not repeated (`on conflict do nothing`). A candidate keeps at most
 * `maxHitsPerCandidate` hits per purpose, better ranks first. Returns the number of new rows.
 */
export async function recordHits(
  db: Db,
  input: { placeId: string; geoObjectId: string; serpQueryId: string; purpose: "positive" | "negative"; runId: string },
  cfg: ResearchConfig,
): Promise<number> {
  const forbidden = getConfig().delivery.forbiddenDomains;
  const existing = await db
    .select({ urlNormalized: researchHits.urlNormalized })
    .from(researchHits)
    .where(and(eq(researchHits.placeId, input.placeId), eq(researchHits.purpose, input.purpose)));
  let room = cfg.maxHitsPerCandidate - existing.length;
  if (room <= 0) return 0;
  const seen = new Set(existing.map((e) => e.urlNormalized));

  const results = await db
    .select()
    .from(serpResults)
    .where(eq(serpResults.serpQueryId, input.serpQueryId))
    .orderBy(asc(serpResults.rank), asc(serpResults.id));
  const rows = [];
  for (const r of results) {
    if (room === 0) break;
    if (seen.has(r.urlNormalized)) continue;
    if (isForbiddenUrl(r.urlNormalized, cfg.skipDomains) || isForbiddenUrl(r.urlNormalized, forbidden)) continue;
    seen.add(r.urlNormalized);
    room--;
    rows.push({
      placeId: input.placeId,
      geoObjectId: input.geoObjectId,
      serpQueryId: input.serpQueryId,
      serpResultId: r.id,
      urlNormalized: r.urlNormalized,
      domain: r.domain,
      rank: r.rank,
      purpose: input.purpose,
      runId: input.runId,
    });
  }
  if (rows.length === 0) return 0;
  const inserted = await db.insert(researchHits).values(rows).onConflictDoNothing().returning({ id: researchHits.id });
  return inserted.length;
}
