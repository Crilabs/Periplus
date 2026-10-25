import { sql } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { DocType, PlaceKind } from "@/lib/db/schema";
import { activeExtractionRunIdSql } from "@/lib/domain/extraction/active-run";
import { boundGeoObjectFor } from "@/lib/domain/mentions/bound";
import { jsonUuids } from "@/lib/domain/research/util/json-uuids";
import { countingSourceSql, mergedChainSql } from "@/lib/domain/consolidation/inputs";
import type { ConsolidationInput } from "@/lib/domain/rules/types";
import { attributeIn } from "@/lib/domain/rules/weights";

/*
 * The evidence that confirms a place (spec 17 „Belegregel je Ortsart“). Thresholds, source types and the attributes
 * that count as a berth fact live in `config/delivery.json` › `confirmation`; the commercial OSM tags in
 * `config/gazetteer.json` › `commercialHarbourTags`.
 *
 * - Berth evidence (anchorage, mooring field, marina): text facts of a berth attribute (`berthable` only when true,
 *   `mooring.buoys` only when present) and route stops of the object whose (version, object) unit has an active
 *   extraction run (plan deviation 3: nothing counts from v2 leftovers before a subdivision is reprocessed). One item of
 *   an `aloneTypes` document confirms alone; items of `pairMinDomains` distinct sources (one source per registrable
 *   domain) of `pairTypes` or `aloneTypes` documents confirm as a pair. `ownSiteTypes` (marina pages) never count here.
 * - Own website (marina only): a `berthable = true` fact from a document version bound to this place (a `bound`
 *   mention of the object, ruling R4: the version is bound, the fact may sit on a name mention) whose document the
 *   place's current website still binds (`boundGeoObjectFor`).
 * - Port: the consolidated `place.kind_evidence` is `port`, or a `berthable = false` fact (`commercial_port`), both
 *   only from documents whose type counts for the place (`countingTextInputs`); or the object carries a commercial
 *   harbour tag and no `leisure=marina` (`osm_commercial`).
 */

export type EvidenceRule = "alone" | "pair" | "own_website" | "commercial_port" | "osm_commercial";

/** The rule that confirmed a place and what it rests on (sorted ids). */
export type Evidence = { rule: EvidenceRule; factIds: string[]; documentIds: string[]; routeStopIds: string[] };

export type EvidenceSubject = {
  geoObjectId: string;
  placeId: string;
  kind: PlaceKind;
  /** OSM tags of the place's geo object. */
  tags: Record<string, string>;
  /** The run date (`YYYY-MM-DD`): validity of the route stops' sources; default today. */
  today?: string;
  /** The consolidated `place.kind_evidence` (port evidence); computed by the caller with its rule. */
  kindEvidence?: string | null;
};

/** One piece of berth evidence: a fact or a route stop, of one source and document type. */
type Item = { factId: string | null; routeStopId: string | null; documentId: string; sourceKey: string; sourceType: DocType | null };

const sorted = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => v !== null))].sort();

function evidenceOf(rule: EvidenceRule, items: Item[]): Evidence {
  return { rule, factIds: sorted(items.map((i) => i.factId)), documentIds: sorted(items.map((i) => i.documentId)), routeStopIds: sorted(items.map((i) => i.routeStopId)) };
}

const isText = (i: ConsolidationInput) => i.origin === "text" && i.factId !== null && i.documentId !== null;

/** Whether a text input is a berth fact: a berth attribute, `berthable` only when true, `mooring.buoys` only when present. */
export function isBerthInput(i: ConsolidationInput, cfg: AppConfig): boolean {
  if (!isText(i) || !attributeIn(i.attribute, cfg.delivery.confirmation.berthAttributes)) return false;
  if (i.attribute === "berthable") return i.value === true;
  if (i.attribute === "mooring.buoys") return (i.value as { present?: unknown } | null)?.present !== false;
  return true;
}

const itemOf = (i: ConsolidationInput): Item => ({ factId: i.factId, routeStopId: null, documentId: i.documentId!, sourceKey: i.sourceKey, sourceType: i.sourceType });

/**
 * The route stops of the object (and of objects merged into it) from counting sources whose mention's (version, object)
 * has an active extraction run, with the version's effective document type.
 */
async function routeStopItems(tx: Db, geoObjectId: string, cfg: AppConfig, today: string): Promise<Item[]> {
  const { rows } = await tx.execute<{ id: string; document_id: string; source_id: string; doc_type: DocType }>(sql`
    select rs.id, d.id as document_id, d.source_id, coalesce(v.classified_doc_type, v.doc_type)::text as doc_type
    from route_stops rs
    join mentions m on m.id = rs.mention_id
    join document_versions v on v.id = m.document_version_id
    join documents d on d.id = v.document_id
    join sources s on s.id = d.source_id
    where rs.geo_object_id in ${mergedChainSql(geoObjectId)} and ${countingSourceSql(today)}
      and ${activeExtractionRunIdSql(cfg, sql`m.document_version_id`, sql`m.geo_object_id`)} is not null
    order by rs.id
  `);
  return rows.map((r) => ({ factId: null, routeStopId: r.id, documentId: r.document_id, sourceKey: `source:${r.source_id}`, sourceType: r.doc_type }));
}

/** Berth evidence from sources: one `aloneTypes` item, else items of `pairMinDomains` distinct sources. */
function sourceEvidence(items: Item[], cfg: AppConfig): Evidence | null {
  const c = cfg.delivery.confirmation;
  const alone = items.filter((i) => i.sourceType !== null && c.aloneTypes.includes(i.sourceType));
  if (alone.length > 0) return evidenceOf("alone", alone);
  const pairTypes = new Set<DocType>([...c.pairTypes, ...c.aloneTypes]);
  const pair = items.filter((i) => i.sourceType !== null && pairTypes.has(i.sourceType));
  if (new Set(pair.map((i) => i.sourceKey)).size >= c.pairMinDomains) return evidenceOf("pair", pair);
  return null;
}

/**
 * Of the facts `factIds`, those whose document version has a `bound` mention of the object (or one merged into it) and
 * whose document is still bound to the object now (`boundGeoObjectFor`, final review 4): the place's current website
 * row is bound and its start URL covers the document's URL. A bound mention stored once does not count after the
 * binding ended or the website moved.
 */
async function boundFactIds(tx: Db, geoObjectId: string, factIds: string[]): Promise<Set<string>> {
  if (factIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ id: string; url_normalized: string }>(sql`
    select f.id, d.url_normalized from facts f
    join mentions m on m.id = f.mention_id
    join document_versions v on v.id = m.document_version_id
    join documents d on d.id = v.document_id
    where f.id in ${jsonUuids(factIds)}
      and exists (
        select 1 from mentions b
        where b.document_version_id = m.document_version_id and b.match_kind = 'bound'
          and b.geo_object_id in ${mergedChainSql(geoObjectId)}
      )
  `);
  const boundTo = new Map<string, string | null>();
  const out = new Set<string>();
  for (const r of rows) {
    if (!boundTo.has(r.url_normalized)) boundTo.set(r.url_normalized, await boundGeoObjectFor(tx, r.url_normalized));
    if (boundTo.get(r.url_normalized) === geoObjectId) out.add(r.id);
  }
  return out;
}

/** Whether the OSM tags name a clearly commercial harbour (`commercialHarbourTags`) and no marina. */
export function isCommercialHarbour(tags: Record<string, string>, cfg: AppConfig): boolean {
  if (tags.leisure === "marina") return false;
  return Object.entries(cfg.gazetteer.commercialHarbourTags).some(([key, values]) => tags[key] !== undefined && values.includes(tags[key]!));
}

/**
 * Of the text inputs, those whose document type may count for the place (spec 17 Quelltyp-Tabelle): `aloneTypes` and
 * `pairTypes` documents; `ownSiteTypes` documents (marina pages) only when their version is bound to the object
 * (`boundFactIds`), never for a place nearby; anything else (a dataset) never. Drives the port rule and the kind switch.
 */
export async function countingTextInputs(tx: Db, geoObjectId: string, inputs: ConsolidationInput[], cfg: AppConfig): Promise<ConsolidationInput[]> {
  const c = cfg.delivery.confirmation;
  const sourceTypes = new Set<DocType>([...c.aloneTypes, ...c.pairTypes]);
  const ownSite = new Set<DocType>(c.ownSiteTypes);
  const text = inputs.filter(isText);
  const onOwnSite = text.filter((i) => i.sourceType !== null && ownSite.has(i.sourceType));
  const bound = await boundFactIds(tx, geoObjectId, onOwnSite.map((i) => i.factId!));
  return text.filter((i) => i.sourceType !== null && (sourceTypes.has(i.sourceType) || (ownSite.has(i.sourceType) && bound.has(i.factId!))));
}

/**
 * The evidence that confirms the place under its kind's rule (see the module comment), or null. `inputs` are the
 * consolidation inputs of the place's geo object (`loadInputs`): only text facts of active runs count.
 * `subject.kindEvidence` is the consolidated `place.kind_evidence` (of the counting inputs, `countingTextInputs`); when
 * it is undefined, a counting `place.kind_evidence` text input of `port` counts instead.
 */
export async function berthEvidence(tx: Db, subject: EvidenceSubject, inputs: ConsolidationInput[], cfg: AppConfig): Promise<Evidence | null> {
  const text = inputs.filter(isText);
  if (subject.kind === "port") {
    const counting = await countingTextInputs(tx, subject.geoObjectId, text, cfg);
    const kindInputs = counting.filter((i) => i.attribute === "place.kind_evidence");
    const portByKind = subject.kindEvidence === undefined || subject.kindEvidence === "port" ? kindInputs.filter((i) => i.value === "port") : [];
    const notBerthable = counting.filter((i) => i.attribute === "berthable" && i.value === false);
    const commercial = [...portByKind, ...notBerthable];
    if (commercial.length > 0) return evidenceOf("commercial_port", commercial.map(itemOf));
    if (isCommercialHarbour(subject.tags, cfg)) return evidenceOf("osm_commercial", []);
    return null;
  }

  if (subject.kind === "marina") {
    // the place's own website: a bound page (of an own-site type or any type that counts), never a dataset
    const c = cfg.delivery.confirmation;
    const types = new Set<DocType>([...c.ownSiteTypes, ...c.aloneTypes, ...c.pairTypes]);
    const yes = text.filter((i) => i.attribute === "berthable" && i.value === true && i.sourceType !== null && types.has(i.sourceType));
    const bound = await boundFactIds(tx, subject.geoObjectId, yes.map((i) => i.factId!));
    const own = yes.filter((i) => bound.has(i.factId!));
    if (own.length > 0) return evidenceOf("own_website", own.map(itemOf));
  }

  const items = text.filter((i) => isBerthInput(i, cfg)).map(itemOf);
  if (cfg.delivery.confirmation.routeStops) {
    items.push(...(await routeStopItems(tx, subject.geoObjectId, cfg, subject.today ?? new Date().toISOString().slice(0, 10))));
  }
  return sourceEvidence(items, cfg);
}
