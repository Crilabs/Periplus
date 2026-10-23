import { and, eq, inArray, isNull } from "drizzle-orm";
import { resolveTaskModel } from "@/lib/ai/cost";
import type { ExtractBerthOutput } from "@/lib/ai/tasks/extract-berth";
import type { ExtractLandsideOutput } from "@/lib/ai/tasks/extract-landside";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, pageAssessments, places, researchHits, researchUnits } from "@/lib/db/schema";
import { activeAssessor } from "./assessment";
import { storeExtraction, type ExtractionStats, type ExtractionUnit } from "./extraction";
import { landsideSubjects } from "./landside-queries";
import { namesOccur } from "./unit-text";

/*
 * Landside extraction (plan N4b). A landside unit (`research_units.kind = 'landside'`) is a current, actively assessed,
 * not generated version of a landside hit page of a confirmed place that names one of the place's landside subjects
 * (`landsideSubjects`: the towns and sights around the berth). Its facts are about things on land and reach the berth
 * state as free facts; the unit never yields a signal, a core value or a landing hint, and no reader of berth evidence
 * counts it (those read `kind = 'berth'` only).
 */

/** The skip reason of a landside unit whose page names none of the place's subjects. */
export const LANDSIDE_NOT_NAMED_REASON = "Landthema auf der Seite nicht genannt";

/** The model and prompt version that extracts landside facts now (task `extract-landside`). */
export function activeLandsideExtractor(config: AppConfig = getConfig()): { model: string; promptVersion: number } {
  const { model, taskConfig } = resolveTaskModel(config, "extract-landside");
  return { model, promptVersion: taskConfig.promptVersion };
}

/** The names of the landside subjects of each place (all languages), places without subject left out. */
export async function landsideSubjectNames(db: Db, placeIds: string[], config: AppConfig): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const placeId of placeIds) {
    const names = [...new Set((await landsideSubjects(db, placeId, config.research.landside)).map((s) => s.name))];
    if (names.length > 0) out.set(placeId, names);
  }
  return out;
}

export type LandsideUnitPlan = { documentVersionId: string; placeId: string };

/**
 * The landside units of the places: per confirmed place and current, actively assessed, not generated version of one of
 * its landside hit pages, a unit when the page names one of the place's subjects (whole words, `namesOccur`). Also the
 * judged pairs (version x place). A pair whose landside unit is already `done` is not judged again (the text of a
 * version does not change); a version whose Markdown is missing stays in (extraction skips it, retryably). Sorted by
 * version, then place.
 */
export async function planLandsideUnits(
  db: Db,
  placeIds: string[],
  config: AppConfig,
  archive: Pick<Archive, "get">,
): Promise<{ units: LandsideUnitPlan[]; judgedPairs: LandsideUnitPlan[] }> {
  const none = { units: [], judgedPairs: [] };
  if (placeIds.length === 0) return none;
  const hitRows = await db
    .selectDistinct({ placeId: researchHits.placeId, versionId: documents.currentVersionId })
    .from(researchHits)
    .innerJoin(places, eq(places.id, researchHits.placeId))
    .innerJoin(documents, eq(documents.urlNormalized, researchHits.urlNormalized))
    .where(
      and(
        inArray(researchHits.placeId, placeIds),
        eq(researchHits.purpose, "landside"),
        eq(places.status, "confirmed"),
        isNull(places.mergedIntoId),
        isNull(places.validTo),
      ),
    );
  const pairs = hitRows.flatMap((h) => (h.versionId ? [{ documentVersionId: h.versionId, placeId: h.placeId }] : []));
  if (pairs.length === 0) return none;
  const assessor = activeAssessor(config);
  const assessed = new Set(
    (
      await db
        .select({ versionId: pageAssessments.documentVersionId })
        .from(pageAssessments)
        .where(
          and(
            inArray(pageAssessments.documentVersionId, [...new Set(pairs.map((p) => p.documentVersionId))]),
            eq(pageAssessments.model, assessor.model),
            eq(pageAssessments.promptVersion, assessor.promptVersion),
            eq(pageAssessments.generated, false),
          ),
        )
    ).map((a) => a.versionId),
  );
  const judged = pairs.filter((p) => assessed.has(p.documentVersionId));
  if (judged.length === 0) return none;

  const extractor = activeLandsideExtractor(config);
  const done = new Set(
    (
      await db
        .select({ versionId: researchUnits.documentVersionId, placeId: researchUnits.placeId })
        .from(researchUnits)
        .where(
          and(
            inArray(researchUnits.documentVersionId, [...new Set(judged.map((p) => p.documentVersionId))]),
            eq(researchUnits.kind, "landside"),
            eq(researchUnits.model, extractor.model),
            eq(researchUnits.promptVersion, extractor.promptVersion),
            eq(researchUnits.status, "done"),
          ),
        )
    ).map((u) => `${u.versionId}:${u.placeId}`),
  );
  const subjects = await landsideSubjectNames(db, [...new Set(judged.map((p) => p.placeId))], config);
  const named = new Set<string>();
  const toRead = new Map<string, LandsideUnitPlan[]>(); // version -> pairs to look for in the text
  for (const p of judged) {
    const key = `${p.documentVersionId}:${p.placeId}`;
    if (done.has(key)) named.add(key);
    else if (subjects.has(p.placeId)) (toRead.get(p.documentVersionId) ?? toRead.set(p.documentVersionId, []).get(p.documentVersionId)!).push(p);
  }
  if (toRead.size > 0) {
    const versions = await db
      .select({ id: documentVersions.id, mdKey: documentVersions.mdKey })
      .from(documentVersions)
      .where(inArray(documentVersions.id, [...toRead.keys()]));
    const limit = config.research.extraction.markdownReadConcurrency;
    let next = 0;
    const worker = async () => {
      while (next < versions.length) {
        const v = versions[next++]!;
        const body = await archive.get(v.mdKey);
        const md = body === null ? null : new TextDecoder().decode(body);
        for (const p of toRead.get(v.id)!) {
          // no Markdown: undecidable here, the unit stays and extraction skips it as missing Markdown
          if (md === null || namesOccur(md, subjects.get(p.placeId)!)) named.add(`${v.id}:${p.placeId}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, versions.length) }, worker));
  }
  const byKey = (a: LandsideUnitPlan, b: LandsideUnitPlan) =>
    a.documentVersionId < b.documentVersionId ? -1 : a.documentVersionId > b.documentVersionId ? 1 : a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0;
  return {
    units: judged.filter((p) => named.has(`${p.documentVersionId}:${p.placeId}`)).sort(byKey),
    judgedPairs: [...judged].sort(byKey),
  };
}

/**
 * Stores the verified facts of one landside unit's answer with the checks of the berth extraction (`storeExtraction`:
 * quote found in the unit text, statement not copied, a name only when the quote has it) and marks the unit done. The
 * answer is mapped to a berth answer without core values, signals and landing hints, so nothing of the page can become
 * evidence of a berth; every fact is a landside fact and keeps a category (`other` when empty).
 */
export async function storeLandsideExtraction(
  db: Db,
  unit: Omit<ExtractionUnit, "names" | "otherBerths">,
  out: ExtractLandsideOutput,
  config: AppConfig,
): Promise<ExtractionStats> {
  const mapped: ExtractBerthOutput = {
    core: [],
    signals: [],
    landing: [],
    facts: out.facts.map((f) => ({ ...f, about: "landside" as const, subject_category: f.subject_category.trim() || "other" })),
  };
  return storeExtraction(db, { ...unit, names: [], otherBerths: [] }, mapped, config);
}
