import { and, desc, eq, inArray } from "drizzle-orm";
import type { ResearchConfig } from "@/lib/config/schemas";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { placeWebsites, researchHits, serpResults } from "@/lib/db/schema";
import { isForbiddenUrl } from "@/lib/domain/sources/forbidden-domains";
import { registrableDomain } from "@/lib/domain/sources/urls";

/**
 * Takes over the results of all searches of one candidate and purpose as hits: without `skipDomains` and forbidden
 * domains, a URL the candidate already has for this purpose is not repeated (`on conflict do nothing`, so a repeated
 * call adds nothing). The cap `maxHitsPerCandidate` applies once over all `serpQueryIds`, existing rows counted:
 * the best ranks across all queries are kept, ties broken by the order of `serpQueryIds` (template order). Returns
 * the number of new rows.
 */
export async function recordHits(
  db: Db,
  input: { placeId: string; geoObjectId: string; serpQueryIds: string[]; purpose: "positive" | "negative"; runId: string },
  cfg: ResearchConfig,
): Promise<number> {
  const forbidden = getConfig().delivery.forbiddenDomains;
  const existing = await db
    .select({ urlNormalized: researchHits.urlNormalized, origin: researchHits.origin })
    .from(researchHits)
    .where(and(eq(researchHits.placeId, input.placeId), eq(researchHits.purpose, input.purpose)));
  // the cap counts search hits only: the place's own website (origin `place_website`) is outside it
  let room = cfg.maxHitsPerCandidate - existing.filter((e) => e.origin === "serp").length;
  if (room <= 0 || input.serpQueryIds.length === 0) return 0;
  const seen = new Set(existing.map((e) => e.urlNormalized));

  const order = new Map(input.serpQueryIds.map((id, i) => [id, i]));
  const results = (await db.select().from(serpResults).where(inArray(serpResults.serpQueryId, input.serpQueryIds))).sort(
    (a, b) => a.rank - b.rank || order.get(a.serpQueryId)! - order.get(b.serpQueryId)! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
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
      serpQueryId: r.serpQueryId,
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

/**
 * The newest bound website of the place (`place_websites.bound`) as a positive hit of rank 0 and origin
 * `place_website`, without a search behind it: the official page of the place (N3b). Not counted against
 * `maxHitsPerCandidate`; a URL the place already has as a positive hit adds nothing. Returns the number of new rows.
 */
export async function recordWebsiteHit(db: Db, input: { placeId: string; geoObjectId: string; runId: string }): Promise<number> {
  const [site] = await db
    .select({ urlNormalized: placeWebsites.urlNormalized })
    .from(placeWebsites)
    .where(and(eq(placeWebsites.placeId, input.placeId), eq(placeWebsites.bound, true)))
    .orderBy(desc(placeWebsites.createdAt), desc(placeWebsites.id))
    .limit(1);
  if (!site) return 0;
  const inserted = await db
    .insert(researchHits)
    .values({
      placeId: input.placeId,
      geoObjectId: input.geoObjectId,
      urlNormalized: site.urlNormalized,
      domain: registrableDomain(site.urlNormalized),
      rank: 0,
      purpose: "positive",
      origin: "place_website",
      runId: input.runId,
    })
    .onConflictDoNothing()
    .returning({ id: researchHits.id });
  return inserted.length;
}
