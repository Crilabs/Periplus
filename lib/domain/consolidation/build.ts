import { createHash } from "node:crypto";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import { canonicalJson, getFactSchema } from "@/lib/domain/facts/schema";
import { profileConfidence } from "./derived/confidence";
import { importanceOf, spotIdsWithin } from "./derived/importance";
import { type OccupancyWord, quietnessScore, type QuietnessWord } from "./derived/quietness";
import { hasObservedMonths, observedMonths, seasonHints } from "./derived/season";
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

/** What a change needs to count as `changed` (ruling M5-P7): independent sources, the largest source weight, fact ids. */
export type AttributeSupport = { independent: number; maxWeight: number; factIds: string[] };

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
function fixedProvenance(
  origin: "gazetteer" | "derived",
  cites: Partial<Pick<AttributeProvenance, "factIds" | "sourceKeys" | "computationIds" | "poiIds">> = {},
): AttributeProvenance {
  return {
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
}

/**
 * Provenance of a rule result. `lastConfirmedAt` = the latest of the supporting inputs. Expiry (spec 07): a value from
 * text or observation whose supporting inputs all can expire (text/observation with a known date, ruling M5-D-R2 —
 * computations, reviews and POIs never do) and were last confirmed before `cutoff` keeps its value, its confidence
 * drops to the middle of the next lower class.
 */
function ruleProvenance(attribute: string, rule: RuleName, r: RuleResult, cutoff: string, cfg: ConsolidationConfig): AttributeProvenance {
  const support = r.support;
  const lastConfirmedAt = support.reduce<string | null>((max, i) => (max === null || i.lastConfirmedAt > max ? i.lastConfirmedAt : max), null);
  const documents = support.filter((i) => i.documentId !== null);
  const textual = r.origin === "text" || r.origin === "observed";
  const canExpire = support.length > 0 && support.every((i) => (i.origin === "text" || i.origin === "observed") && i.dateKnown);
  const expired = textual && canExpire && lastConfirmedAt !== null && lastConfirmedAt < cutoff;
  let confidence = r.confidence;
  let klass = confidenceClass(confidence, cfg);
  if (expired) {
    klass = lowerClass(klass);
    confidence = classMidpoint(klass, cfg);
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
    onlyGoneSources: documents.length > 0 && documents.every((i) => i.gone),
    conflictKey: r.conflict?.key ?? null,
    observedMonths: hasObservedMonths(attribute) ? observedMonths(r) : [],
  };
  if (r.entryFactIds) provenance.entryFactIds = r.entryFactIds;
  return provenance;
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
 * The content hash (sha256): values, confidence classes, conflict keys with their resolution and the expired keys —
 * not confidences, fact ids or other provenance, so the same values and classes give the same hash.
 */
export function profileContentHash(p: Pick<BuiltProfile, "attributes" | "provenance" | "conflicts">): string {
  const keys = Object.keys(p.provenance).sort();
  const payload = {
    attributes: p.attributes,
    classes: Object.fromEntries(keys.map((k) => [k, p.provenance[k].confidenceClass])),
    conflicts: p.conflicts.map((c) => ({ key: c.key, resolution: c.resolution })),
    expired: keys.filter((k) => p.provenance[k].expired),
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/**
 * The profile of one geo object (spec 07, plan Task 10):
 * 1. inputs sorted by (attribute, observedAt, fact or POI id), then each attribute of the level through its schema rule;
 * 2. a value ≠ null goes to `attributes` with its provenance; a conflict to `conflicts` with the resolution of a decided
 *    task (`context.resolutions`);
 * 3. expiry of text/observation values last confirmed before `today − cycles × tileCycleDays`;
 * 4. identity (`gazetteer`, rule `identity`, confidence 1): `geo.name`, `geo.parent_id`, `geo.geometry_hash`; places
 *    `place.kind`, `place.status`, `place.position` (6 decimals), `exclude`;
 * 5. derived values (`derived`): places `derived.quietness`, `derived.season`; POIs `derived.importance`,
 *    `derived.radius_nm`, `derived.spot_ids`;
 * 6. gaps: level attributes without a value, except `gaps.ignore[place.kind]`, with the computation's reason or
 *    `no_facts`;
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
    if (r === null || r.value === null || r.value === undefined) continue;
    attributes[def.key] = r.value;
    provenance[def.key] = ruleProvenance(def.key, rule, r, cutoff, cfg);
    support[def.key] = {
      independent: independentCount(r.support),
      maxWeight: r.support.reduce((max, i) => Math.max(max, i.sourceWeight), 0),
      factIds: provenance[def.key].factIds,
    };
    if (r.conflict) conflicts.push({ ...r.conflict, resolution: context.resolutions.get(r.conflict.key) ?? null });
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
    identity("exclude", { excluded: p.status === "no_anchoring", reason: p.statusReason });
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
    const { value } = quietnessScore(
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
      setDerived("derived.quietness", value, fixedProvenance("derived", { ...cited, computationIds }));
    }
    const hints = seasonHints(results);
    if (hints.length > 0) setDerived("derived.season", hints, fixedProvenance("derived", cite(provenance, ["season_notes"])));
  }
  if (context.level === "poi" && derived.importance) {
    const imp = importanceOf(derived.importance, cfg);
    const sourceKeys = sortedUnique(derived.importance.sources.map((s) => s.key));
    setDerived("derived.importance", imp.importance, fixedProvenance("derived", { sourceKeys }));
    setDerived("derived.radius_nm", imp.radiusNm, fixedProvenance("derived", { sourceKeys }));
    setDerived(
      "derived.spot_ids",
      spotIdsWithin(derived.importance.spotCandidates, imp.radiusNm, cfg.importance.maxSpotIds),
      fixedProvenance("derived"),
    );
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
