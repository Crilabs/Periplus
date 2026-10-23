import type { Db } from "@/lib/db/client";
import type { AppConfig } from "@/lib/config";
import {
  berthSignals,
  documents,
  pageAssessments,
  researchHits,
  researchRouteStops,
  researchUnits,
  serpQueries,
  serpResults,
  type BerthSignalKind,
  type PageKind,
} from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { activeRouteExtractor } from "@/lib/domain/research/assign";
import { activeExtractor } from "@/lib/domain/research/confirmation";
import { insertTestRun, insertTestSource, insertTestVersion } from "@/test/text";

export type SignalPageOpts = {
  domain: string;
  kind?: BerthSignalKind;
  firstHand?: boolean;
  pageKind?: PageKind;
  observedAt?: string;
  /** How the page is linked to the place: a search hit (default) or a route stop matched by name. */
  link?: "search" | "name";
  quote?: string;
};

/** One page of `domain` with an active assessment, a done research unit of the place and one signal in it (meant for `withRollback`). */
export async function signalPage(tx: Db, config: AppConfig, place: { placeId: string; objectId: string }, o: SignalPageOpts): Promise<{ signalId: string }> {
  const sourceId = await insertTestSource(tx);
  const url = `https://www.${o.domain}/${newId()}`;
  const [doc] = await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "trip_report" }).returning({ id: documents.id });
  const { versionId } = await insertTestVersion(tx, ["x"], { documentId: doc!.id });
  const assessor = activeAssessor(config);
  const observedAt = o.observedAt ?? "2024-06-15";
  await tx.insert(pageAssessments).values({
    documentVersionId: versionId, model: assessor.model, promptVersion: assessor.promptVersion, pageKind: o.pageKind ?? "trip_report", firstHand: true,
    generated: false, observedAt, observedAtBasis: "explicit", berths: [], runId: await insertTestRun(tx),
  });
  if ((o.link ?? "search") === "search") {
    const [q] = await tx
      .insert(serpQueries)
      .values({ keyword: "k", languageCode: "en", locationCode: 2300, depth: 10, level: "place", scopeId: place.objectId, rawKey: `serp/x/${url}.json`, fetchedAt: new Date() })
      .returning({ id: serpQueries.id });
    const [r] = await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url, urlNormalized: url, domain: o.domain, title: "t", snippet: "s" }).returning({ id: serpResults.id });
    await tx.insert(researchHits).values({ placeId: place.placeId, geoObjectId: place.objectId, serpQueryId: q!.id, serpResultId: r!.id, urlNormalized: url, domain: o.domain, rank: 1, purpose: "positive" });
  } else {
    const route = activeRouteExtractor(config);
    await tx.insert(researchRouteStops).values({
      documentVersionId: versionId, seq: 1, name: "Bay", quote: "q", observedAt, placeId: place.placeId, match: "name", model: route.model, promptVersion: route.promptVersion,
    });
  }
  const extractor = activeExtractor(config);
  const [unit] = await tx
    .insert(researchUnits)
    .values({ documentVersionId: versionId, placeId: place.placeId, model: extractor.model, promptVersion: extractor.promptVersion, status: "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 0 } })
    .returning({ id: researchUnits.id });
  const [signal] = await tx
    .insert(berthSignals)
    .values({
      unitId: unit!.id, placeId: place.placeId, documentVersionId: versionId, kind: o.kind ?? "anchored", firstHand: o.firstHand ?? true, confidence: 0.9,
      quote: o.quote ?? "We anchored here", quoteStart: 0, quoteEnd: 16, observedAt, observedAtBasis: "explicit",
    })
    .returning({ id: berthSignals.id });
  return { signalId: signal!.id };
}
