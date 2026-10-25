import type { Db } from "@/lib/db/client";
import { berthFacts, documents, pageAssessments, researchUnits, type PageKind } from "@/lib/db/schema";
import type { AppConfig } from "@/lib/config";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { activeExtractor } from "@/lib/domain/research/confirmation";
import { activeLandsideExtractor } from "@/lib/domain/research/landside-extraction";
import { newId } from "@/lib/domain/ids";
import { insertTestRun, insertTestVersion } from "@/test/text";

/** A page of `domain` for the place: an assessed current version with a research unit of the active extractor. */
export async function seedPage(
  tx: Db,
  config: AppConfig,
  placeId: string,
  o: { domain?: string; host?: string; model?: string; status?: "done" | "failed"; generated?: boolean; pageKind?: PageKind; kind?: "berth" | "landside"; promptVersion?: number } = {},
) {
  const { sourceId } = await insertTestVersion(tx, ["y"]);
  const url = `https://${o.host ?? `www.${o.domain ?? "guide.example"}`}/${newId()}`;
  const [doc] = await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "trip_report" }).returning({ id: documents.id });
  return { ...(await seedVersion(tx, config, placeId, doc!.id, o)), documentId: doc!.id, sourceId };
}

/** A new (now current) version of the document, assessed, with a research unit of the place. */
export async function seedVersion(
  tx: Db,
  config: AppConfig,
  placeId: string,
  documentId: string,
  o: { model?: string; status?: "done" | "failed"; generated?: boolean; pageKind?: PageKind; kind?: "berth" | "landside"; promptVersion?: number } = {},
) {
  const { model, promptVersion } = activeAssessor(config);
  const kind = o.kind ?? "berth";
  const ex = kind === "landside" ? activeLandsideExtractor(config) : activeExtractor(config);
  const v = await insertTestVersion(tx, ["x"], { documentId });
  await tx.insert(pageAssessments).values({
    documentVersionId: v.versionId, model, promptVersion, pageKind: o.pageKind ?? "trip_report", firstHand: true, generated: o.generated ?? false,
    observedAt: "2025-06-15", observedAtBasis: "explicit", berths: [], runId: await insertTestRun(tx),
  });
  const [u] = await tx
    .insert(researchUnits)
    .values({ documentVersionId: v.versionId, placeId, kind, model: o.model ?? ex.model, promptVersion: o.promptVersion ?? ex.promptVersion, status: o.status ?? "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 0 } })
    .returning({ id: researchUnits.id });
  return { unitId: u!.id, versionId: v.versionId };
}

/** A free fact (statement) on a page. */
export async function seedStatement(
  tx: Db,
  placeId: string,
  p: { unitId: string; versionId: string },
  o: { statement: string; observedAt?: string; tone?: "positive" | "negative" | "neutral" | null; subjectName?: string | null; subjectCategory?: string | null; safety?: boolean },
) {
  const [f] = await tx
    .insert(berthFacts)
    .values({
      unitId: p.unitId, placeId, documentVersionId: p.versionId, attribute: null, value: null, statement: o.statement,
      subjectName: o.subjectName ?? null, subjectCategory: o.subjectCategory ?? null, tone: o.tone ?? null, safety: o.safety ?? false,
      quote: "synthetic quote text", quoteStart: 0, quoteEnd: 20, observedAt: o.observedAt ?? "2025-06-15", observedAtBasis: "explicit",
    })
    .returning({ id: berthFacts.id });
  return f!.id;
}
