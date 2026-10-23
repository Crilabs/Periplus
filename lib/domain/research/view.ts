import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { berthFacts, berthSignals, documents, pageAssessments, places, researchFetches, researchHits, researchUnits, serpQueries } from "@/lib/db/schema";
import type { PageKind, ResearchFetchOutcome, ResearchPurpose } from "@/lib/db/schema/research";
import type { BerthSignalKind, Tone } from "@/lib/db/schema/research-extract";
import type { ObservedAtBasis } from "@/lib/db/schema/sources";
import { getConfig } from "@/lib/config";
import { activeAssessor } from "./assessment";
import { activeExtractor, decideBerth, loadEvidence, type Verdict } from "./confirmation";

export type SignalRow = {
  kind: BerthSignalKind;
  firstHand: boolean;
  confidence: number;
  observedAt: string;
  observedAtBasis: ObservedAtBasis;
  quote: string;
};

export type FactRow = {
  /** What the page says: the statement, else the attribute and its value. */
  statement: string;
  /** `null`: the berth itself; else the name of the landside thing. */
  subject: string | null;
  observedAt: string;
  tone: Tone | null;
  quote: string;
};

export type ResearchRow = {
  url: string;
  domain: string;
  rank: number;
  purpose: ResearchPurpose;
  keyword: string;
  documentId: string | null;
  /** The newest fetch attempt of the page (null while none was made). */
  fetch: { outcome: ResearchFetchOutcome; reason: string | null } | null;
  assessment: {
    pageKind: PageKind;
    firstHand: boolean;
    generated: boolean;
    observedAt: string;
    berths: string[];
  } | null;
  /** The signals and facts the active extraction found on the current version of the page for this place. */
  signals: SignalRow[];
  facts: FactRow[];
  signalCount: number;
  factCount: number;
};

export type ResearchViewData = {
  /** The confirmation rule applied to the place's evidence now (what `research.confirm` would decide). */
  verdict: Verdict;
  rows: ResearchRow[];
};

/**
 * The research hits of a place with the search term, the archived document (null while not fetched) and the
 * assessment of its current version by the active model and prompt version (null while not assessed) and the
 * outcome of its newest fetch attempt (`research_fetches`). Confirmation
 * (positive) before negative search, then by rank.
 */
export async function researchView(db: Db, placeId: string): Promise<ResearchViewData> {
  const [place] = await db.select({ kind: places.kind }).from(places).where(eq(places.id, placeId));
  if (!place) throw new Error(`place ${placeId} does not exist`);
  const cfg = getConfig();
  const verdict = decideBerth(place.kind, (await loadEvidence(db, [placeId], cfg)).get(placeId) ?? [], cfg.research.confirmation);

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
          .where(
            and(inArray(pageAssessments.documentVersionId, versionIds), eq(pageAssessments.model, model), eq(pageAssessments.promptVersion, promptVersion)),
          );
  const byVersion = new Map(assessments.map((a) => [a.documentVersionId, a]));

  const urls = [...new Set(hits.map((h) => h.url))];
  const attempts =
    urls.length === 0
      ? []
      : await db
          .selectDistinctOn([researchFetches.urlNormalized], {
            url: researchFetches.urlNormalized,
            outcome: researchFetches.outcome,
            reason: researchFetches.reason,
          })
          .from(researchFetches)
          .where(inArray(researchFetches.urlNormalized, urls))
          .orderBy(researchFetches.urlNormalized, desc(researchFetches.createdAt), desc(researchFetches.id));
  const fetchOf = new Map(attempts.map((f) => [f.url, { outcome: f.outcome, reason: f.reason }]));

  const extractor = activeExtractor(cfg);
  const unitOf = and(
    eq(researchUnits.id, berthSignals.unitId),
    eq(researchUnits.model, extractor.model),
    eq(researchUnits.promptVersion, extractor.promptVersion),
  );
  const signalRows =
    versionIds.length === 0
      ? []
      : await db
          .select({
            versionId: berthSignals.documentVersionId,
            kind: berthSignals.kind,
            firstHand: berthSignals.firstHand,
            confidence: berthSignals.confidence,
            observedAt: berthSignals.observedAt,
            observedAtBasis: berthSignals.observedAtBasis,
            quote: berthSignals.quote,
          })
          .from(berthSignals)
          .innerJoin(researchUnits, unitOf)
          .where(and(eq(berthSignals.placeId, placeId), inArray(berthSignals.documentVersionId, versionIds)))
          .orderBy(asc(berthSignals.observedAt), asc(berthSignals.id));
  const factRows =
    versionIds.length === 0
      ? []
      : await db
          .select({
            versionId: berthFacts.documentVersionId,
            attribute: berthFacts.attribute,
            value: berthFacts.value,
            statement: berthFacts.statement,
            subject: berthFacts.subjectName,
            observedAt: berthFacts.observedAt,
            tone: berthFacts.tone,
            quote: berthFacts.quote,
          })
          .from(berthFacts)
          .innerJoin(
            researchUnits,
            and(eq(researchUnits.id, berthFacts.unitId), eq(researchUnits.model, extractor.model), eq(researchUnits.promptVersion, extractor.promptVersion)),
          )
          .where(and(eq(berthFacts.placeId, placeId), inArray(berthFacts.documentVersionId, versionIds)))
          .orderBy(asc(berthFacts.observedAt), asc(berthFacts.id));
  const signalsOf = new Map<string, SignalRow[]>();
  for (const { versionId, ...r } of signalRows) (signalsOf.get(versionId) ?? signalsOf.set(versionId, []).get(versionId)!).push(r);
  const factsOf = new Map<string, FactRow[]>();
  for (const f of factRows) {
    const fact: FactRow = {
      statement: f.statement ?? `${f.attribute}: ${JSON.stringify(f.value)}`,
      subject: f.subject,
      observedAt: f.observedAt,
      tone: f.tone,
      quote: f.quote,
    };
    (factsOf.get(f.versionId) ?? factsOf.set(f.versionId, []).get(f.versionId)!).push(fact);
  }

  const rows = hits
    .map((h): ResearchRow => {
      const a = h.versionId ? byVersion.get(h.versionId) : undefined;
      const signals = (h.versionId ? signalsOf.get(h.versionId) : undefined) ?? [];
      const facts = (h.versionId ? factsOf.get(h.versionId) : undefined) ?? [];
      return {
        url: h.url,
        domain: h.domain,
        rank: h.rank,
        purpose: h.purpose,
        keyword: h.keyword,
        documentId: h.documentId,
        fetch: fetchOf.get(h.url) ?? null,
        assessment: a
          ? {
              pageKind: a.pageKind,
              firstHand: a.firstHand,
              generated: a.generated,
              observedAt: a.observedAt,
              berths: a.berths.map((b) => b.name),
            }
          : null,
        signals,
        facts,
        signalCount: signals.length,
        factCount: facts.length,
      };
    })
    .sort((x, y) => (x.purpose === y.purpose ? x.rank - y.rank : x.purpose === "positive" ? -1 : 1));
  return { verdict, rows };
}
