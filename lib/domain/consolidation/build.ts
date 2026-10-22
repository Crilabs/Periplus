import { createHash } from "node:crypto";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import { canonicalJson, getFactSchema } from "@/lib/domain/facts/schema";
import { profileConfidence } from "./derived/confidence";
import { importanceOf, spotIdsWithin } from "./derived/importance";
import { type OccupancyWord, quietnessScore, type QuietnessWord } from "./derived/quietness";
import { hasObservedMonths, observedMonths, seasonHints } from "./derived/season";
import { excludeValue, restrictionOf } from "./exclude";
import type { DerivedInputs, ProfileContext } from "./inputs";
import { applyRule } from "./rules";
import type {
  AttributeProvenance,
  ConflictNote,
  ConsolidationInput,
  ProfileGap,
  ProfileSnapshot,
  RuleContext,
  RuleName,
  RuleResult,
} from "./types";
import {
  attributeIn,
  classMidpoint,
  confidenceClass,
  independentCount,
  inputId,
  lowerClass,
  roundTo,
} from "./weights";

/*
 * Builds one profile of a geo object from its inputs (spec 07 "Ablauf" steps 2–4): one rule per attribute of the
 * level, provenance, conflicts, expiry, identity fields, derived values, gaps and the profile confidence. Pure: the
 * loading is in `inputs.ts`, the comparison and the writes in later steps.
 */

/**
 * What a change needs to count as `changed` (ruling M5-P7): independent sources, the largest source weight, fact ids.
 * `confirmedAt`: per value an input of the attribute carries (`canonicalJson`), the latest `lastConfirmedAt` of those
 * inputs (POI import dates left out), so a value kept from the previous profile is still confirmed by its source
 * (ruling M5-F-R3 M-1).
 */
export type AttributeSupport = {
  independent: number;
  maxWeight: number;
  factIds: string[];
  confirmedAt: Record<string, string>;
  /**
   * Per input of the attribute (`inputId`, POIs left out), its `lastConfirmedAt`: a kept value no single input carries
   * (a weighted mean, a united list) is confirmed again while the inputs it was made of are still current (ruling
   * M5-F-R3 N-2).
   */
  confirmedByInput: Record<string, string>;
  /** Safety lists: the entry keys review removal decisions took out, with the removal date (`RuleResult.removedEntries`, GR-1/GR-12). */
  removedEntries?: Record<string, string>;
};

export type BuiltProfile = Omit<ProfileSnapshot, "version" | "validFrom"> & { support: Record<string, AttributeSupport> };

export type BuildProfileInput = {
  inputs: ConsolidationInput[];
  context: ProfileContext;
  derived: DerivedInputs;
  /** The run date `YYYY-MM-DD`. */
  today: string;
  cfg: ConsolidationConfig;
  schemaVersion: string;
  rulesVersion: string;
};

const DAY_MS = 86_400_000;
const POSITION_DIGITS = 6;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => v !== null && v !== ""))].sort();

/** Inputs by (attribute, observedAt, fact or POI id), then the remaining ids and the source: a total order. */
function byAttributeDateId(a: ConsolidationInput, b: ConsolidationInput): number {
  return (
    cmp(a.attribute, b.attribute) ||
    cmp(a.observedAt, b.observedAt) ||
    cmp(a.factId ?? a.poiId ?? "", b.factId ?? b.poiId ?? "") ||
    cmp(inputId(a), inputId(b)) ||
    cmp(a.sourceKey, b.sourceKey)
  );
}

function dateMinusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/** Provenance of a value the profile build sets itself (identity: gazetteer; derived values). */
/** Spec 17: no anchoring or a port → false; a confirmed anchorage, marina or mooring field → true; else no value. */
function derivedBerthable(kind: string, status: string): boolean | null {
  if (status === "no_anchoring" || kind === "port") return false;
  if (status === "confirmed" && ["anchorage", "marina", "mooring_field"].includes(kind)) return true;
  return null;
}

function fixedProvenance(
  origin: "gazetteer" | "derived",
  cites: Partial<Pick<AttributeProvenance, "factIds" | "sourceKeys" | "computationIds" | "poiIds">> = {},
  derivedFrom?: Record<string, unknown>,
): AttributeProvenance {
  const provenance: AttributeProvenance = {
    origin,
    rule: origin === "gazetteer" ? "identity" : "derived",
    confidence: 1,
    confidenceClass: "high",
    observedAt: null,
    lastConfirmedAt: null,
    factIds: cites.factIds ?? [],
    sourceKeys: cites.sourceKeys ?? [],
    computationIds: cites.computationIds ?? [],
    poiIds: cites.poiIds ?? [],
    expired: false,
    onlyGoneSources: false,
    conflictKey: null,
    observedMonths: [],
  };
  if (derivedFrom) provenance.derivedFrom = derivedFrom;
  return provenance;
}

/**
 * Provenance of a rule result.
 * - `lastConfirmedAt` = the latest of the supporting inputs, POI import dates left out (an import is no confirmation,
 *   ruling M5-E-R3 M-7); only POIs → null.
 * - Expiry (spec 07): a value from text or observation whose supporting inputs are all text or observation inputs
 *   (computations, reviews and POIs never expire) last confirmed before `cutoff` keeps its value and drops one class:
 *   its confidence becomes the middle of the lower class, but never rises (spec 07 "Konfidenz sinkt"). An undated
 *   text expires too: its `lastConfirmedAt` is a real confirmation date (ruling M5-E-R3 I-1, I-2).
 * - `onlyGoneSources`: documents support the value, all of them are gone, and no other input (computation, review,
 *   observation, POI) carries it (ruling M5-E-R3 M-2).
 */
function ruleProvenance(attribute: string, rule: RuleName, r: RuleResult, cutoff: string, cfg: ConsolidationConfig): AttributeProvenance {
  const support = r.support;
  const lastConfirmedAt = support
    .filter((i) => i.poiId === null)
    .reduce<string | null>((max, i) => (max === null || i.lastConfirmedAt > max ? i.lastConfirmedAt : max), null);
  const documents = support.filter((i) => i.documentId !== null);
  const textual = r.origin === "text" || r.origin === "observed";
  const canExpire = support.length > 0 && support.every((i) => i.origin === "text" || i.origin === "observed");
  const expired = textual && canExpire && lastConfirmedAt !== null && lastConfirmedAt < cutoff;
  let confidence = r.confidence;
  let klass = confidenceClass(confidence, cfg);
  if (expired) {
    klass = lowerClass(klass);
    confidence = Math.min(confidence, classMidpoint(klass, cfg));
  }
  const provenance: AttributeProvenance = {
    origin: r.origin,
    rule,
    confidence,
    confidenceClass: klass,
    observedAt: r.observedAt,
    lastConfirmedAt,
    factIds: sortedUnique(support.map((i) => i.factId)),
    sourceKeys: sortedUnique(support.map((i) => i.sourceKey)),
    computationIds: sortedUnique(support.map((i) => i.computationId)),
    poiIds: sortedUnique(support.map((i) => i.poiId)),
    expired,
    onlyGoneSources: documents.length > 0 && documents.length === support.length && documents.every((i) => i.gone),
    conflictKey: r.conflict?.key ?? null,
    observedMonths: hasObservedMonths(attribute) ? observedMonths(r) : [],
  };
  if (r.entryFactIds) provenance.entryFactIds = r.entryFactIds;
  return provenance;
}

/**
 * The resolution of a conflict key: the admin's `seasonal` / `left_open`, `decided` when a task picked one value
 * (ruling M5-F-R3 M-2), else null (open).
 */
export function conflictResolution(key: string, context: Pick<ProfileContext, "resolutions" | "decidedConflictKeys">): ConflictNote["resolution"] {
  return context.resolutions.get(key) ?? (context.decidedConflictKeys.has(key) ? "decided" : null);
}

/** Per value of the inputs, the latest `lastConfirmedAt` (POI import dates are no confirmation, ruling M5-E-R3 M-7). */
function confirmedAtByValue(inputs: ConsolidationInput[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of inputs) {
    if (i.poiId !== null) continue;
    const value = canonicalJson(i.value);
    if (out[value] === undefined || i.lastConfirmedAt > out[value]) out[value] = i.lastConfirmedAt;
  }
  return out;
}

/** Per input (`inputId`), its latest `lastConfirmedAt`; POI import dates are no confirmation. */
function confirmedAtByInput(inputs: ConsolidationInput[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of inputs) {
    if (i.poiId !== null) continue;
    const id = inputId(i);
    if (out[id] === undefined || i.lastConfirmedAt > out[id]) out[id] = i.lastConfirmedAt;
  }
  return out;
}

/** The factual citations of the given provenance entries, merged (for derived values built on them). */
function cite(provenance: Record<string, AttributeProvenance>, keys: string[]) {
  const used = keys.map((k) => provenance[k]).filter((p): p is AttributeProvenance => p !== undefined);
  return {
    factIds: sortedUnique(used.flatMap((p) => p.factIds)),
    sourceKeys: sortedUnique(used.flatMap((p) => p.sourceKeys)),
    computationIds: sortedUnique(used.flatMap((p) => p.computationIds)),
    poiIds: sortedUnique(used.flatMap((p) => p.poiIds)),
  };
}

/**
 * The content hash (sha256): values, confidence classes, conflict keys with their resolution, the expired keys and
 * the keys only gone documents support (ruling M5-E-R3 M-1: the "no longer confirmed" flag of a stored version stays
 * current) — not confidences, fact ids, `derivedFrom` or other provenance, so the same values and classes give the
 * same hash.
 */
export function profileContentHash(p: Pick<BuiltProfile, "attributes" | "provenance" | "conflicts">): string {
  const keys = Object.keys(p.provenance).sort();
  const payload = {
    attributes: p.attributes,
    classes: Object.fromEntries(keys.map((k) => [k, p.provenance[k].confidenceClass])),
    conflicts: p.conflicts.map((c) => ({ key: c.key, resolution: c.resolution })),
    expired: keys.filter((k) => p.provenance[k].expired),
    onlyGoneSources: keys.filter((k) => p.provenance[k].onlyGoneSources),
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/**
 * The profile of one geo object (spec 07, plan Task 10):
 * 1. inputs sorted by (attribute, observedAt, fact or POI id), then each attribute of the level through its schema rule;
 * 2. a value ≠ null goes to `attributes` with its provenance; a conflict to `conflicts` with the resolution of a decided
 *    task (`conflictResolution`: `context.resolutions`, or `decided` for a picked value);
 * 3. expiry of text/observation values last confirmed before `today − cycles × tileCycleDays`;
 * 4. identity (`gazetteer`, rule `identity`, confidence 1): `geo.name`, `geo.parent_id`, `geo.geometry_hash`; places
 *    `place.kind`, `place.status`, `place.position` (6 decimals), `exclude` in the contract's vocabulary
 *    (`exclude.ts`), citing the restricted area and the `prohibitions` entry that excluded the place;
 * 5. derived values (`derived`, the deciding inputs in `derivedFrom`): places `derived.quietness`, `derived.season`, and
 *    `berthable` when no fact gave one (spec 17);
 *    POIs `derived.importance`, `derived.radius_nm`, `derived.spot_ids`;
 * 6. gaps: level attributes without a value, except `gaps.ignore[place.kind]`, with the computation's reason or
 *    `no_facts`; then the missing derived values (`derived.quietness` `too_few_parts`, `derived.importance`
 *    `no_category`, ruling M5-E-R3 M-6);
 * 7. profile confidence and the counts of the context; 8. the content hash.
 */
export function buildProfile(input: BuildProfileInput): BuiltProfile {
  const { context, derived, today, cfg, schemaVersion, rulesVersion } = input;
  const defs = getFactSchema(schemaVersion).levels[context.level];
  const byAttribute = new Map<string, ConsolidationInput[]>();
  for (const i of [...input.inputs].sort(byAttributeDateId)) {
    const list = byAttribute.get(i.attribute);
    if (list) list.push(i);
    else byAttribute.set(i.attribute, [i]);
  }
  const place = context.place ? { kind: context.place.kind, status: context.place.status } : null;
  const cutoff = dateMinusDays(today, cfg.expiry.cycles * context.tileCycleDays);

  const attributes: Record<string, unknown> = {};
  const provenance: Record<string, AttributeProvenance> = {};
  const support: Record<string, AttributeSupport> = {};
  const conflicts: ConflictNote[] = [];
  const results: Record<string, RuleResult | null> = {};

  // 1–3: rules
  for (const def of defs) {
    const rule = def.rule as RuleName;
    const ctx: RuleContext = { attribute: def.key, level: context.level, place, today, cfg };
    const r = applyRule(rule, byAttribute.get(def.key) ?? [], ctx);
    results[def.key] = r;
    const removedEntries = r?.removedEntries && Object.keys(r.removedEntries).length > 0 ? r.removedEntries : null;
    if (r !== null && (r.value === null || r.value === undefined) && removedEntries) {
      // no value left, but the removals still tell change detection which entries the admin took out (GR-1)
      support[def.key] = { independent: 0, maxWeight: 0, factIds: [], confirmedAt: {}, confirmedByInput: {}, removedEntries };
    }
    if (r === null || r.value === null || r.value === undefined) continue;
    attributes[def.key] = r.value;
    provenance[def.key] = ruleProvenance(def.key, rule, r, cutoff, cfg);
    support[def.key] = {
      independent: independentCount(r.support),
      maxWeight: r.support.reduce((max, i) => Math.max(max, i.sourceWeight), 0),
      factIds: provenance[def.key].factIds,
      confirmedAt: confirmedAtByValue(byAttribute.get(def.key) ?? []),
      confirmedByInput: confirmedAtByInput(byAttribute.get(def.key) ?? []),
      ...(removedEntries ? { removedEntries } : {}),
    };
    if (r.conflict) conflicts.push({ ...r.conflict, resolution: conflictResolution(r.conflict.key, context) });
  }
  conflicts.sort((a, b) => cmp(a.attribute, b.attribute) || cmp(a.key, b.key));

  // 6: gaps (before identity and derived keys join the attributes)
  const ignore = context.place ? (cfg.gaps.ignore[context.place.kind] ?? []) : [];
  const gaps: ProfileGap[] = defs
    .filter((d) => !(d.key in attributes) && !attributeIn(d.key, ignore))
    .map((d) => ({ attribute: d.key, reason: context.computationGaps[d.key] ?? "no_facts" }));

  // 4: identity
  const identity = (key: string, value: unknown) => {
    if (value === null || value === undefined) return;
    attributes[key] = value;
    provenance[key] = fixedProvenance("gazetteer");
  };
  identity("geo.name", context.identity.name);
  identity("geo.parent_id", context.identity.parentId);
  identity("geo.geometry_hash", context.identity.geometryHash);
  if (context.place) {
    const p = context.place;
    identity("place.kind", p.kind);
    identity("place.status", p.status);
    identity("place.position", { lon: roundTo(p.position.lon, POSITION_DIGITS), lat: roundTo(p.position.lat, POSITION_DIGITS) });
    const exclude = excludeValue(p.status, p.statusReason);
    attributes["exclude"] = exclude;
    const restriction = exclude.excluded ? restrictionOf(p.statusReason) : null;
    const entryIds = restriction
      ? (provenance["prohibitions"]?.entryFactIds?.[`${restriction.kind}:${restriction.restrictedAreaId}`] ?? [])
      : [];
    provenance["exclude"] = fixedProvenance(
      "gazetteer",
      { factIds: entryIds.filter((id) => !id.includes(":")) },
      { statusReason: p.statusReason, restrictedAreaId: restriction?.restrictedAreaId ?? null },
    );
  }

  // 5: derived values
  const setDerived = (key: string, value: unknown, prov: AttributeProvenance) => {
    attributes[key] = value;
    provenance[key] = prov;
  };
  if (context.level === "place" && context.place) {
    const occupancy = attributes["occupancy"] as Record<string, OccupancyWord> | undefined;
    const text = (attributes["quietness"] as QuietnessWord | undefined) ?? null;
    const distances = derived.quietness;
    const { value, parts } = quietnessScore(
      {
        settlementDistanceM: distances?.settlementDistanceM ?? null,
        roadDistanceM: distances?.roadDistanceM ?? null,
        occupancy: occupancy ? cfg.quietness.occupancyMonths.map((m) => occupancy[String(m)] ?? "unknown") : [],
        text,
        ferry: distances?.ferry ?? null,
      },
      cfg,
    );
    if (value !== null) {
      const cited = cite(provenance, ["occupancy", "quietness"]);
      const computationIds = sortedUnique([...cited.computationIds, distances?.computationId ?? null]);
      const ferryBasis = parts.ferry === undefined ? null : (distances?.ferryBasis ?? null);
      const ferryFacts = ferryBasis?.kind === "parent" ? ferryBasis.inputIds.filter((id) => !id.includes(":")) : [];
      setDerived(
        "derived.quietness",
        value,
        fixedProvenance("derived", { ...cited, factIds: sortedUnique([...cited.factIds, ...ferryFacts]), computationIds }, { parts, ferryBasis }),
      );
    } else {
      gaps.push({ attribute: "derived.quietness", reason: "too_few_parts" });
    }
    const hints = seasonHints(results);
    if (hints.length > 0) setDerived("derived.season", hints, fixedProvenance("derived", cite(provenance, ["season_notes"])));
  }
  if (context.level === "poi" && derived.importance) {
    const d = derived.importance;
    const imp = importanceOf(d, cfg);
    const sourceKeys = sortedUnique(d.sources.map((s) => s.key));
    const sources = [...new Map([...d.sources].sort((a, b) => cmp(a.key, b.key) || a.weight - b.weight).map((s) => [s.key, s.weight]))]
      .map(([key, weight]) => ({ key, weight }));
    const decided = { score: imp.score, sources, sitelinks: d.sitelinks, category: d.category };
    setDerived("derived.importance", imp.importance, fixedProvenance("derived", { sourceKeys }, decided));
    setDerived("derived.radius_nm", imp.radiusNm, fixedProvenance("derived", { sourceKeys }, { importance: imp.importance, ...decided }));
    const spotIds = spotIdsWithin(d.spotCandidates, imp.radiusNm, cfg.importance.maxSpotIds);
    const distanceOf = new Map(d.spotCandidates.map((c) => [c.placeId, c.distanceNm]));
    setDerived(
      "derived.spot_ids",
      spotIds,
      fixedProvenance("derived", {}, {
        radiusNm: imp.radiusNm,
        spots: spotIds.map((placeId) => ({ placeId, distanceNm: distanceOf.get(placeId)! })),
        candidates: d.spotCandidates.filter((c) => c.distanceNm <= imp.radiusNm).length,
      }),
    );
  } else if (context.level === "poi") {
    gaps.push({ attribute: "derived.importance", reason: "no_category" });
  }

  // berthable without a fact: a derived value of the place (spec 17, "Ableitung ohne Fact"); a fact always wins
  if (context.level === "place" && context.place && !("berthable" in attributes) && defs.some((d) => d.key === "berthable")) {
    const berthable = derivedBerthable(context.place.kind, context.place.status);
    if (berthable !== null) {
      setDerived("berthable", berthable, fixedProvenance("derived", {}, { kind: context.place.kind, status: context.place.status }));
      const gap = gaps.findIndex((g) => g.attribute === "berthable");
      if (gap >= 0) gaps.splice(gap, 1);
    }
  }

  // 7–8
  const built = {
    attributes,
    provenance,
    conflicts,
    gaps,
    sourcesCount: context.sourcesCount,
    documentsCount: context.documentsCount,
    confidence: profileConfidence(provenance, cfg),
    rulesVersion,
    factSchemaVersion: schemaVersion,
    support,
  };
  return { ...built, contentHash: profileContentHash(built) };
}
