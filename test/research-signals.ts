import type { Archive } from "@/lib/adapters/s3";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import {
  berthFacts,
  berthSignals,
  documentVersions,
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
import { eq } from "drizzle-orm";
import { newId } from "@/lib/domain/ids";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { activeRouteExtractor } from "@/lib/domain/research/assign";
import { activeExtractor } from "@/lib/domain/research/confirmation";
import { insertTestRun, insertTestSource, insertTestVersion } from "@/test/text";

export type SignalPageOpts = {
  domain: string;
  kind?: BerthSignalKind;
  firstHand?: boolean;
  confidence?: number;
  observedAt?: string;
  observedAtBasis?: "explicit" | "fetched";
  pageKind?: PageKind;
  /** How the page is linked to the place: a search hit (default), a route stop matched by name or by the corridor, or none. */
  link?: "search" | "name" | "corridor" | "none";
  /** The purpose of the search hit of a `search` link (default `positive`). */
  hitPurpose?: "positive" | "negative" | "landside";
  unitStatus?: "done" | "failed";
  unitModel?: string;
  quote?: string;
};

/** One page of `domain` with an active assessment, a research unit of the place and one signal in it. */
export async function signalPage(tx: Db, config: AppConfig, place: { placeId: string; objectId: string }, o: SignalPageOpts): Promise<{ signalId: string; versionId: string }> {
  const sourceId = await insertTestSource(tx);
  const url = `https://www.${o.domain}/${newId()}`;
  const [doc] = await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "trip_report" }).returning({ id: documents.id });
  const { versionId } = await insertTestVersion(tx, ["x"], { documentId: doc!.id });
  const assessor = activeAssessor(config);
  await tx.insert(pageAssessments).values({
    documentVersionId: versionId, model: assessor.model, promptVersion: assessor.promptVersion, pageKind: o.pageKind ?? "trip_report", firstHand: true,
    generated: false, observedAt: o.observedAt ?? "2024-06-15", observedAtBasis: "explicit", berths: [], runId: await insertTestRun(tx),
  });
  const link = o.link ?? "search";
  if (link === "search") {
    const [q] = await tx
      .insert(serpQueries)
      .values({ keyword: "k", languageCode: "en", locationCode: 2300, depth: 10, level: "place", scopeId: place.objectId, rawKey: `serp/x/${url}.json`, fetchedAt: new Date() })
      .returning({ id: serpQueries.id });
    const [r] = await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url, urlNormalized: url, domain: o.domain, title: "t", snippet: "s" }).returning({ id: serpResults.id });
    await tx.insert(researchHits).values({ placeId: place.placeId, geoObjectId: place.objectId, serpQueryId: q!.id, serpResultId: r!.id, urlNormalized: url, domain: o.domain, rank: 1, purpose: o.hitPurpose ?? "positive" });
  } else if (link !== "none") {
    const route = activeRouteExtractor(config);
    await tx.insert(researchRouteStops).values({
      documentVersionId: versionId, seq: 1, name: "Bay", quote: "q", observedAt: o.observedAt ?? "2024-06-15", placeId: place.placeId, match: link, model: route.model, promptVersion: route.promptVersion,
    });
  }
  const extractor = activeExtractor(config);
  const [unit] = await tx
    .insert(researchUnits)
    .values({ documentVersionId: versionId, placeId: place.placeId, model: o.unitModel ?? extractor.model, promptVersion: extractor.promptVersion, status: o.unitStatus ?? "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 0 } })
    .returning({ id: researchUnits.id });
  const [signal] = await tx
    .insert(berthSignals)
    .values({
      unitId: unit!.id, placeId: place.placeId, documentVersionId: versionId, kind: o.kind ?? "anchored", firstHand: o.firstHand ?? true, confidence: o.confidence ?? 0.9,
      quote: o.quote ?? "We anchored here", quoteStart: 0, quoteEnd: 16, observedAt: o.observedAt ?? "2024-06-15", observedAtBasis: o.observedAtBasis ?? "explicit",
    })
    .returning({ id: berthSignals.id });
  return { signalId: signal!.id, versionId };
}


/**
 * A source page of the place whose archived markdown is `markdown`, with one free fact extracted from it: what the
 * delivery copy check (`loadCopyIndex`) holds the place's delivered texts against.
 */
export async function factSourcePage(tx: Db, config: AppConfig, archive: Archive, place: { placeId: string; objectId: string }, markdown: string): Promise<{ versionId: string }> {
  const { versionId } = await signalPage(tx, config, place, { domain: `src-${newId().slice(0, 8)}.example`, link: "none" });
  const [unit] = await tx.select({ id: researchUnits.id }).from(researchUnits).where(eq(researchUnits.documentVersionId, versionId));
  const [version] = await tx.select({ mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, versionId));
  await archive.put(version!.mdKey, markdown, "text/markdown");
  await tx.insert(berthFacts).values({
    unitId: unit!.id, placeId: place.placeId, documentVersionId: versionId, statement: "A fact from this page.", quote: markdown.slice(0, 20),
    quoteStart: 0, quoteEnd: Math.min(20, markdown.length), observedAt: "2024-06-15", observedAtBasis: "explicit",
  });
  return { versionId };
}
