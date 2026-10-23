import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { documents, pageAssessments, researchHits, serpQueries } from "@/lib/db/schema";
import type { PageKind, ResearchPurpose } from "@/lib/db/schema/research";
import { getConfig } from "@/lib/config";
import { activeAssessor } from "./assessment";

export type ResearchRow = {
  url: string;
  domain: string;
  rank: number;
  purpose: ResearchPurpose;
  keyword: string;
  documentId: string | null;
  assessment: { pageKind: PageKind; firstHand: boolean; generated: boolean; observedAt: string; berths: string[] } | null;
};

/**
 * The research hits of a place with the search term, the archived document (null while not fetched) and the
 * assessment of its current version by the active model and prompt version (null while not assessed). Confirmation
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
        assessment: a
          ? { pageKind: a.pageKind, firstHand: a.firstHand, generated: a.generated, observedAt: a.observedAt, berths: a.berths.map((b) => b.name) }
          : null,
      };
    })
    .sort((x, y) => (x.purpose === y.purpose ? x.rank - y.rank : x.purpose === "positive" ? -1 : 1));
}
