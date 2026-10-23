import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { documents, pageAssessments, researchFetches, researchHits, serpQueries } from "@/lib/db/schema";
import type { PageKind, ResearchFetchOutcome, ResearchPurpose } from "@/lib/db/schema/research";
import { getConfig } from "@/lib/config";
import { activeAssessor } from "./assessment";

export type ResearchRow = {
  url: string;
  domain: string;
  rank: number;
  purpose: ResearchPurpose;
  keyword: string;
  documentId: string | null;
  /** The newest fetch attempt of the page (null while none was made). */
  fetch: { outcome: ResearchFetchOutcome; reason: string | null } | null;
  assessment: { pageKind: PageKind; firstHand: boolean; generated: boolean; observedAt: string; berths: string[] } | null;
};

/**
 * The research hits of a place with the search term, the archived document (null while not fetched) and the
 * assessment of its current version by the active model and prompt version (null while not assessed) and the
 * outcome of its newest fetch attempt (`research_fetches`). Confirmation
 * (positive) before negative search, then by rank.
 */
export async function researchView(db: Db, placeId: string): Promise<ResearchRow[]> {
  const hits = await db
    .select({
      url: researchHits.urlNormalized,
      domain: researchHits.domain,
      rank: researchHits.rank,
      purpose: researchHits.purpose,
      keyword: serpQueries.keyword,
      documentId: documents.id,
      versionId: documents.currentVersionId,
    })
    .from(researchHits)
    .innerJoin(serpQueries, eq(serpQueries.id, researchHits.serpQueryId))
    .leftJoin(documents, eq(documents.urlNormalized, researchHits.urlNormalized))
    .where(eq(researchHits.placeId, placeId));

  const versionIds = hits.flatMap((h) => (h.versionId ? [h.versionId] : []));
  const { model, promptVersion } = activeAssessor(getConfig());
  const assessments =
    versionIds.length === 0
      ? []
      : await db
          .select()
          .from(pageAssessments)
          .where(and(inArray(pageAssessments.documentVersionId, versionIds), eq(pageAssessments.model, model), eq(pageAssessments.promptVersion, promptVersion)));
  const byVersion = new Map(assessments.map((a) => [a.documentVersionId, a]));

  const urls = [...new Set(hits.map((h) => h.url))];
  const attempts =
    urls.length === 0
      ? []
      : await db
          .selectDistinctOn([researchFetches.urlNormalized], { url: researchFetches.urlNormalized, outcome: researchFetches.outcome, reason: researchFetches.reason })
          .from(researchFetches)
          .where(inArray(researchFetches.urlNormalized, urls))
          .orderBy(researchFetches.urlNormalized, desc(researchFetches.createdAt), desc(researchFetches.id));
  const fetchOf = new Map(attempts.map((f) => [f.url, { outcome: f.outcome, reason: f.reason }]));

  return hits
    .map((h): ResearchRow => {
      const a = h.versionId ? byVersion.get(h.versionId) : undefined;
      return {
        url: h.url,
        domain: h.domain,
        rank: h.rank,
        purpose: h.purpose,
        keyword: h.keyword,
        documentId: h.documentId,
        fetch: fetchOf.get(h.url) ?? null,
        assessment: a
          ? { pageKind: a.pageKind, firstHand: a.firstHand, generated: a.generated, observedAt: a.observedAt, berths: a.berths.map((b) => b.name) }
          : null,
      };
    })
    .sort((x, y) => (x.purpose === y.purpose ? x.rank - y.rank : x.purpose === "positive" ? -1 : 1));
}
