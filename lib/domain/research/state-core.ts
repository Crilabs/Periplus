import { sql } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { VersionedConsolidationConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import type { PageKind, PlaceKind, PlaceStatus } from "@/lib/db/schema";
import type { BerthStateOrigin, BerthStateValue } from "@/lib/db/schema/research-state";
import type { DocType, ObservedAtBasis } from "@/lib/db/schema/sources";
import { derivedBerthable } from "@/lib/domain/consolidation/berthable";
import { byAttributeDateId } from "@/lib/domain/consolidation/build";
import { computedInputs } from "@/lib/domain/consolidation/inputs";
import { applyRule } from "@/lib/domain/consolidation/rules";
import type { ConsolidationInput, RuleName } from "@/lib/domain/consolidation/types";
import { attributeIn } from "@/lib/domain/consolidation/weights";
import { getFactSchema } from "@/lib/domain/facts/schema";
import { registrableDomain } from "@/lib/domain/sources/urls";
import { activeAssessor } from "./assessment";
import { activeExtractor } from "./confirmation";
import { liveResearchSourceSql } from "./sources";

/*
 * Core values of a berth state (spec 5.7, plan N4a task 2): the consolidation rules per attribute of fact schema v4
 * (computed shelter as the basis a text corrects, holding from text only, the youngest observation for services,
 * prohibitions until lifted), without profile versions. Inputs carry evidence only: the facts of the geo object's
 * newest computations, and the structured `berth_facts` (checked quote) of done units of the active `extract-berth`
 * model and prompt. No Navily values, no old `mentions` facts.
 *
 * The rules version (`rules`) is passed in, never read from `getConfig()`: the stage resolves it once per run with
 * `consolidationConfigFor(db)` (the activated version, ruling M7-P10), so every berth of a run is decided by one version.
 */

/**
 * The document type whose `config/source-types.json` weight a page kind takes: the same vocabulary, except a listing
 * (aggregator), which is no source type of its own and weighs as `other`.
 */
const PAGE_KIND_DOC_TYPE: Record<PageKind, DocType> = {
  trip_report: "trip_report",
  pilot_guide: "pilot_guide",
  marina: "marina",
  authority: "authority",
  forum: "forum",
  travel_guide: "travel_guide",
  listing: "other",
  other: "other",
};

type TextRow = {
  id: string;
  attribute: string;
  value: unknown;
  observed_at: string;
  observed_at_basis: ObservedAtBasis;
  document_id: string;
  url: string;
  gone: boolean;
  page_kind: PageKind;
};

/**
 * The inputs of the berth's core values, restricted to the attributes of the research fact schema (v4): the facts of
 * the newest computation per kind of the place's geo object (as the consolidation reads them, weight
 * `rules.weights.computed`), and its structured text facts of done units of the active extractor on the current
 * version of a page with an active, not generated assessment, of a source neither rejected nor ended. A text input is
 * one source per registrable domain, weighs as its page kind's document type, has confidence `state.textConfidence`,
 * and is confirmed on its observation date; a fetch date (basis `fetched`) is no observation date. Sorted by
 * attribute, date and id (`byAttributeDateId`, as the profile build).
 */
export async function coreInputs(db: Db, placeId: string, config: AppConfig, rules: VersionedConsolidationConfig): Promise<ConsolidationInput[]> {
  const known = new Set(getFactSchema(config.research.extraction.factSchema).levels.place.map((d) => d.key));
  const { rows: places } = await db.execute<{ geo_object_id: string }>(sql`select geo_object_id from places where id = ${placeId}`);
  const place = places[0];
  if (!place) throw new Error(`Unknown place ${placeId}`);

  const extractor = activeExtractor(config);
  const assessor = activeAssessor(config);
  const { rows } = await db.execute<TextRow>(sql`
    select f.id, f.attribute, f.value, f.observed_at::text as observed_at, f.observed_at_basis::text as observed_at_basis,
           d.id as document_id, d.url, d.status = 'gone' as gone, a.page_kind::text as page_kind
    from berth_facts f
    join research_units u on u.id = f.unit_id
    join documents d on d.current_version_id = f.document_version_id
    join sources src on src.id = d.source_id
    join page_assessments a on a.document_version_id = f.document_version_id and a.model = ${assessor.model} and a.prompt_version = ${assessor.promptVersion}
    where f.place_id = ${placeId} and f.attribute is not null
      and u.status = 'done' and u.model = ${extractor.model} and u.prompt_version = ${extractor.promptVersion}
      and a.generated = false and ${liveResearchSourceSql("src")}
    order by f.id`);

  const texts = rows.map((r): ConsolidationInput => {
    const docType = PAGE_KIND_DOC_TYPE[r.page_kind];
    return {
      factId: r.id,
      attribute: r.attribute,
      value: r.value,
      origin: "text",
      confidence: config.research.state.textConfidence,
      observedAt: r.observed_at,
      dateKnown: r.observed_at_basis !== "fetched",
      sourceKey: registrableDomain(r.url),
      sourceWeight: config.sourceTypes[docType].weight,
      sourceType: docType,
      documentId: r.document_id,
      gone: r.gone,
      lastConfirmedAt: r.observed_at,
      computationId: null,
      poiId: null,
    };
  });
  const computed = await computedInputs(db, place.geo_object_id, rules);
  return [...computed, ...texts].filter((i) => known.has(i.attribute)).sort(byAttributeDateId);
}

export type CoreOptions = { config: AppConfig; rules: VersionedConsolidationConfig; today: string };

/**
 * The core values: per v4 attribute, its rule (`applyRule` with the rules version `rules`) over the inputs of that
 * attribute, on the run date `today`. As the profile build: `berthable` without a value is derived from the place's
 * kind and status (`derivedBerthable`, origin `rule`, confidence 1, no fact); an attribute without a value is a gap
 * unless `rules.gaps.ignore[place.kind]` names it. Gaps keep the schema's order. Pure.
 */
export function decideCore(
  inputs: ConsolidationInput[],
  place: { kind: PlaceKind; status: PlaceStatus },
  { config, rules, today }: CoreOptions,
): { core: Record<string, BerthStateValue>; gaps: string[] } {
  const core: Record<string, BerthStateValue> = {};
  const defs = getFactSchema(config.research.extraction.factSchema).levels.place;
  for (const def of defs) {
    const own = inputs.filter((i) => i.attribute === def.key);
    const result = applyRule(def.rule as RuleName, own, { attribute: def.key, level: "place", place, today, cfg: rules });
    if (!result || result.value === null || result.value === undefined) continue;
    core[def.key] = {
      value: result.value,
      confidence: result.confidence,
      origin: stateOrigin(result.origin),
      observedAt: result.observedAt,
      factIds: [...new Set(result.support.flatMap((i) => (i.factId ? [i.factId] : [])))],
    };
  }
  if (!("berthable" in core) && defs.some((d) => d.key === "berthable")) {
    const berthable = derivedBerthable(place.kind, place.status);
    if (berthable !== null) core.berthable = { value: berthable, confidence: 1, origin: "rule", observedAt: null, factIds: [] };
  }
  const ignore = rules.gaps.ignore[place.kind] ?? [];
  const gaps = defs.map((d) => d.key).filter((k) => !(k in core) && !attributeIn(k, ignore));
  return { core, gaps };
}

/** The state knows computed, text and rule values only: no review or observation inputs enter it. */
function stateOrigin(origin: string): BerthStateOrigin {
  if (origin === "computed" || origin === "text" || origin === "rule") return origin;
  throw new Error(`Unexpected core value origin ${origin}`);
}
