import { createHash } from "node:crypto";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { ChangeSeverity, ChangeType } from "@/lib/db/schema/profiles";
import { canonicalJson, getFactSchema } from "@/lib/domain/facts/schema";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { type AttributeSupport, type BuiltProfile, conflictResolution, profileContentHash } from "./build";
import { profileConfidence } from "./derived/confidence";
import type { ProfileContext } from "./inputs";
import { compareProhibitions, isComputedProhibition, prohibitionEntryKey } from "./rules/prohibitions";
import { unionEntryKey } from "./rules/union";
import type { AttributeProvenance, ProfileSnapshot } from "./types";
import { attributeIn, classMidpoint, lowerClass, roundTo } from "./weights";

/*
 * Change detection (spec 07 "Änderungserkennung"): the new profile against the valid one, attribute by attribute.
 * Pure: the writes (versions, events, review tasks) are in `store.ts`.
 */

/** A change event before it is written (`change_events` without version, run and seq). */
export type EventDraft = {
  type: ChangeType;
  attribute: string | null;
  oldValue: unknown;
  newValue: unknown;
  severity: ChangeSeverity;
  details: Record<string, unknown>;
};

/**
 * A review task before it is opened (subject `profile_attribute` `<geoObjectId>:<attribute>`); `event` is written only
 * when the task is new (an `uncertain` change), so an open task does not repeat its event on every run.
 */
export type TaskDraft = {
  kind: "conflict" | "uncertain_change";
  attribute: string;
  key: string;
  context: Record<string, unknown>;
  priority: number;
  event: EventDraft | null;
};

export type DiffContext = {
  cfg: ConsolidationConfig;
  level: FactLevel;
  context: ProfileContext;
  /** The run date `YYYY-MM-DD`: expiry of values kept from the previous profile. */
  today: string;
};

export type ProfileDiff = { profile: BuiltProfile; events: EventDraft[]; tasks: TaskDraft[]; versionNeeded: boolean };

/** Identity fields whose change is a `geo_changed` (spec 07: name, geometry or parent; the place position). */
const GEO_FIELDS = ["geo.name", "geo.parent_id", "geo.geometry_hash", "place.position"] as const;

const DAY_MS = 86_400_000;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/**
 * Severity of a change (spec 07): a shelter sector is `safety` when it moves by more than `severity.shelterDelta`,
 * otherwise `info`; any other attribute matching `severity.safety` is `safety`, matching `severity.notable` is
 * `notable` (patterns ending in `.*` are prefixes), else `info`.
 */
export function severityFor(attribute: string, oldValue: unknown, newValue: unknown, cfg: ConsolidationConfig): ChangeSeverity {
  if (attribute.startsWith("shelter.")) {
    if (typeof oldValue !== "number" || typeof newValue !== "number") return "info";
    return roundTo(Math.abs(newValue - oldValue), cfg.precision) > cfg.severity.shelterDelta ? "safety" : "info";
  }
  if (attributeIn(attribute, cfg.severity.safety)) return "safety";
  if (attributeIn(attribute, cfg.severity.notable)) return "notable";
  return "info";
}

/** First 16 hex of sha256 over the attribute, the proposed value and its sorted fact ids. */
export function uncertainKey(attribute: string, newValue: unknown, factIds: string[]): string {
  return createHash("sha256")
    .update(canonicalJson([attribute, newValue, [...factIds].sort()]))
    .digest("hex")
    .slice(0, 16);
}

const priorityOf = (severity: ChangeSeverity) => (severity === "safety" ? 2 : 1);

function dateMinusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Whether a value of this provenance ages (spec 07 "expired"): a text or observation value without computed, POI or
 * review support. Only such a value stays when its inputs vanish (ruling M5-F-R3 I-1).
 */
function canExpire(p: AttributeProvenance): boolean {
  return (
    (p.origin === "text" || p.origin === "observed") &&
    p.computationIds.length === 0 &&
    p.poiIds.length === 0 &&
    !p.sourceKeys.includes("review")
  );
}

/** The facts a value rests on: for a list attribute those of its entries, else `factIds`; computation ids left out. */
function valueFacts(p: AttributeProvenance): string[] {
  const ids = p.entryFactIds ? Object.values(p.entryFactIds).flat() : p.factIds;
  return ids.filter((id) => !id.includes(":"));
}

/**
 * A text or observed value whose every fact comes from a source that is rejected or ended now (`withdrawnFactIds`,
 * „Quelle beenden“, ruling M6-H-R1): it is withdrawn, not kept to expire. A new value of a non-safety attribute
 * replaces it without support; on a safety attribute it needs support like any change (ruling M6-FIN-R2).
 */
function withdrawn(p: AttributeProvenance, withdrawnFactIds: Set<string>): boolean {
  if (!canExpire(p)) return false;
  const facts = valueFacts(p);
  return facts.length > 0 && facts.every((id) => withdrawnFactIds.has(id));
}

/**
 * The provenance of a value kept from the previous profile, with expiry applied on the run date like `buildProfile`
 * does: a value that can expire, last confirmed before `cutoff`, drops one class (its confidence never rises).
 * `confirmedAt`, when later than the stored one, is a current input still carrying the kept value (ruling M5-F-R3
 * M-1): the value is confirmed again, so it does not expire by its old date. An already expired value stays expired.
 */
function keptProvenance(p: AttributeProvenance, cutoff: string, cfg: ConsolidationConfig, confirmedAt: string | undefined): AttributeProvenance {
  if (p.expired) return p;
  const refreshed = confirmedAt !== undefined && (p.lastConfirmedAt === null || confirmedAt > p.lastConfirmedAt) ? { ...p, lastConfirmedAt: confirmedAt } : p;
  if (!canExpire(refreshed) || refreshed.lastConfirmedAt === null || refreshed.lastConfirmedAt >= cutoff) return refreshed;
  const confidenceClass = lowerClass(refreshed.confidenceClass);
  return { ...refreshed, expired: true, confidenceClass, confidence: Math.min(refreshed.confidence, classMidpoint(confidenceClass, cfg)) };
}

/**
 * When the current inputs still make the kept value although no single input carries it (ruling M5-F-R3 N-2): a list
 * whose every entry is still named by a current input (`entryFactIds`), or another value whose every supporting fact is
 * still an input. Then the latest confirmation of those inputs, as `buildProfile` dates a value; otherwise undefined.
 */
function producedConfirmation(p: AttributeProvenance, support: AttributeSupport | undefined): string | undefined {
  if (!support) return undefined;
  const latest = (ids: string[]) => ids.map((id) => support.confirmedByInput[id]).filter((d): d is string => d !== undefined).sort().at(-1);
  if (p.entryFactIds) {
    const entries = Object.values(p.entryFactIds);
    if (entries.length === 0) return undefined;
    const dates = entries.map(latest);
    return dates.every((d) => d !== undefined) ? dates.sort().at(-1) : undefined;
  }
  if (p.factIds.length === 0 || !p.factIds.every((id) => support.confirmedByInput[id] !== undefined)) return undefined;
  return latest(p.factIds);
}

/**
 * A safety attribute (ruling M6-FIN-R2): a shelter sector or an attribute matching `severity.safety`. A weak text
 * never sets such a value in place of a withdrawn one, past an open `uncertain_change` task or past the profile's
 * `in_review` gap (rulings M6-FIN-R2/R3).
 */
function safetyAttribute(attribute: string, cfg: ConsolidationConfig): boolean {
  return attribute.startsWith("shelter.") || attributeIn(attribute, cfg.severity.safety);
}

/** Gap reason of a safety value held back until its `uncertain_change` task is decided (ruling M6-FIN-R2). */
export const IN_REVIEW_GAP = "in_review";

/**
 * A kept provenance without the facts and sources withdrawn now (ruling M6-FIN-R2): the value rests on its other
 * sources, and no package cites an ended or rejected source through it.
 */
function withoutWithdrawn(p: AttributeProvenance, context: ProfileContext): AttributeProvenance {
  const facts = (ids: string[]) => ids.filter((id) => !context.withdrawnFactIds.has(id));
  const sourceKeys = p.sourceKeys.filter((k) => !context.withdrawnSourceKeys.has(k));
  const factIds = facts(p.factIds);
  const entryFactIds = p.entryFactIds ? Object.fromEntries(Object.entries(p.entryFactIds).map(([k, ids]) => [k, facts(ids)])) : p.entryFactIds;
  if (factIds.length === p.factIds.length && sourceKeys.length === p.sourceKeys.length && same(entryFactIds, p.entryFactIds)) return p;
  return { ...p, factIds, sourceKeys, ...(entryFactIds ? { entryFactIds } : {}) };
}

/** What a provenance cites: facts, sources, the entries' inputs and their markers (not part of the content hash). */
const citations = (p: AttributeProvenance | undefined) =>
  canonicalJson(p ? [p.factIds, p.sourceKeys, p.entryFactIds ?? null, p.entryMarkers ?? null] : null);

/** A provenance without entry markers: a marker holds only for the run that drafts the entry's task. */
function withoutMarkers(p: AttributeProvenance): AttributeProvenance {
  if (p.entryMarkers === undefined) return p;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { entryMarkers, ...rest } = p;
  return rest;
}

/**
 * A kept safety list whose removal waits for review (ruling M6-FIN-R3): each entry citing no fact any more is marked
 * `in_review` (it stays, safe direction, until the task is decided).
 */
function markUncitedEntries(p: AttributeProvenance): AttributeProvenance {
  const uncited = Object.entries(p.entryFactIds ?? {}).filter(([, ids]) => ids.length === 0).map(([k]) => k);
  return uncited.length === 0 ? p : { ...p, entryMarkers: Object.fromEntries(uncited.map((k) => [k, IN_REVIEW_GAP] as const)) };
}

/** Severity of a value that is gone: a shelter sector without a value any more is `safety` (no Δ to measure). */
function removalSeverity(attribute: string, oldValue: unknown, cfg: ConsolidationConfig): ChangeSeverity {
  return attribute.startsWith("shelter.") ? "safety" : severityFor(attribute, oldValue, null, cfg);
}

/** The identity key of one entry of a safety list (`prohibitions` by kind or restricted area, else the union key). */
function listEntryKey(attribute: string, entry: unknown, ctx: DiffContext): string {
  if (attribute === "prohibitions") return prohibitionEntryKey(entry);
  return unionEntryKey(entry, { attribute, level: ctx.level, place: null, today: ctx.today, cfg: ctx.cfg });
}

const unique = (values: string[]) => [...new Set(values)].sort();

/** Provenance of a list with accepted additions: the new provenance, citing the kept entries of the old one too. */
function mergedListProvenance(prev: AttributeProvenance, next: AttributeProvenance, merged: unknown[], attribute: string, ctx: DiffContext): AttributeProvenance {
  const entryFactIds: Record<string, string[]> = {};
  for (const entry of merged) {
    const key = listEntryKey(attribute, entry, ctx);
    entryFactIds[key] = next.entryFactIds?.[key] ?? prev.entryFactIds?.[key] ?? [];
  }
  return {
    ...next,
    factIds: unique([...prev.factIds, ...next.factIds]),
    sourceKeys: unique([...prev.sourceKeys, ...next.sourceKeys]),
    computationIds: unique([...prev.computationIds, ...next.computationIds]),
    poiIds: unique([...prev.poiIds, ...next.poiIds]),
    conflictKey: null,
    entryFactIds,
  };
}

/**
 * The new profile against the valid one (`prev`, null before the first version), rulings M5-P7/P8/P9/P23, M5-F-R3:
 * - Without a previous profile: no attribute events; a confirmed place → `place_new`.
 * - Per attribute of the fact schema level:
 *   - no value before → `new_attribute`; but an unsupported value of a safety attribute (shelter sectors,
 *     `severity.safety`, not the additive lists) stays without a value (gap `in_review`) while the previous profile
 *     carries the gap `in_review` for it, its `uncertain_change` task is open, or its key was decided (rulings
 *     M6-FIN-R2/R3). Without an open task a task for the new key opens with its `uncertain` event (on the existing
 *     version when nothing else changed), unless that key was discarded. The gap ends only with a supported value
 *     (independent sources, a strong source, a computation, a review fact: an accepted change); a run without a value
 *     carries it over. A held task shows the attribute's conflict note (both weak values) in `context.conflict`;
 *   - another value supported by `change.minIndependent` independent sources or a source weighing more than
 *     `change.strongWeight` (or set by the rule itself, origin `rule`) → `changed`;
 *   - otherwise uncertain: the old value, its provenance and its conflict note stay and, unless its key
 *     (`uncertainKey`) was decided, an `uncertain_change` task draft with an `uncertain` event;
 *   - a list of `change.additiveLists` (safety lists) goes through `safetyListDiff` whatever its support: added
 *     entries hold at once (`changed`); a missing entry leaves only by a review removal, as a computed-only entry its
 *     newer computation dropped, or with every text fact of the list withdrawn; any other missing entry stays,
 *     marked `in_review`, and the change waits as uncertain (GR-1, rulings M5-C-R2 I-2, M5-F-R3 I-3, M6-FIN-R3);
 *   - a value without inputs any more stays (no event, expiry ages it) if it can expire (text or observation);
 *     a computed, rule, review or POI value goes, its gap stays, and `changed` → null is emitted (ruling M5-F-R3 I-1);
 *   - a text or observed value resting only on facts of rejected or ended sources (`withdrawn`, ruling M6-H-R1) goes
 *     like a computed one; another value replaces it as `changed` without the support rule, except on a safety
 *     attribute (ruling M6-FIN-R2): there an unsupported value is held for review (`changed` → null, severity by
 *     attribute, gap `in_review`, priority-2 `uncertain_change` task with old value null);
 * - A kept value still carried by a current input is confirmed again (`lastConfirmedAt`, ruling M5-F-R3 M-1); it no
 *   longer cites withdrawn facts or their sources (ruling M6-FIN-R2).
 * - A value newly `expired` → `expired` (severity by attribute, `details.lastConfirmedAt`).
 * - Identity: name, parent, geometry, position → `geo_changed` (`info`); `place.kind` → `changed` (`info`); `exclude`
 *   → `changed` (`safety`); status newly `confirmed` from none or `candidate` → `place_new`, newly `abandoned` →
 *   `place_abandoned`.
 * - Every conflict without resolution (decided keys are marked `decided` by `buildProfile`) → a `conflict` task draft
 *   with both sides and the further value groups (`others`); priority 2 on a safety attribute, else 1; no event.
 * - `versionNeeded`: no previous profile, or another content hash after the old values came back (profile confidence
 *   and hash recomputed), or a kept value whose citations changed (a withdrawn source no longer cited, an entry
 *   marker set or gone; rulings M6-FIN-R2/R3), without an event.
 */
export function diffProfiles(prev: ProfileSnapshot | null, next: BuiltProfile, ctx: DiffContext): ProfileDiff {
  const { cfg, context } = ctx;
  const profile: BuiltProfile = {
    ...next,
    attributes: { ...next.attributes },
    provenance: { ...next.provenance },
    conflicts: [...next.conflicts],
    gaps: [...next.gaps],
  };
  const events: EventDraft[] = [];
  const tasks: TaskDraft[] = [];
  /** Attributes whose old value stays (`keep`): a version is written when their citations changed. */
  const kept = new Set<string>();
  const event = (type: ChangeType, attribute: string | null, oldValue: unknown, newValue: unknown, severity: ChangeSeverity, details: Record<string, unknown> = {}) =>
    events.push({ type, attribute, oldValue: oldValue ?? null, newValue: newValue ?? null, severity, details });

  if (prev !== null) {
    const cutoff = dateMinusDays(ctx.today, cfg.expiry.cycles * context.tileCycleDays);
    /**
     * The old value with its provenance (without withdrawn facts and sources) and its conflict note (re-resolved
     * against the decided tasks).
     */
    const keep = (key: string) => {
      kept.add(key);
      const support = next.support[key];
      const confirmedAt = support?.confirmedAt[canonicalJson(prev.attributes[key] ?? null)] ?? producedConfirmation(prev.provenance[key]!, support);
      profile.attributes[key] = prev.attributes[key];
      profile.provenance[key] = withoutMarkers(withoutWithdrawn(keptProvenance(prev.provenance[key]!, cutoff, cfg, confirmedAt), context));
      profile.gaps = profile.gaps.filter((g) => g.attribute !== key);
      profile.conflicts = [
        ...profile.conflicts.filter((c) => c.attribute !== key),
        ...(prev.conflicts ?? []).filter((c) => c.attribute === key).map((c) => ({ ...c, resolution: conflictResolution(c.key, context) })),
      ].sort((a, b) => cmp(a.attribute, b.attribute) || cmp(a.key, b.key));
    };

    /** The attribute without a value, its gap `in_review`: the profile's marker of a held safety value. */
    const markInReview = (key: string) => {
      delete profile.attributes[key];
      delete profile.provenance[key];
      profile.conflicts = profile.conflicts.filter((c) => c.attribute !== key);
      profile.gaps = [...profile.gaps.filter((g) => g.attribute !== key), { attribute: key, reason: IN_REVIEW_GAP }];
    };

    /**
     * A safety value held back for review (rulings M6-FIN-R2/R3): the attribute stays without a value (gap
     * `in_review`) and, unless its key was decided, an `uncertain_change` task (priority 2, old value null) proposes
     * the value, with the attribute's conflict note (both weak values) in `context.conflict`; `withEvent` false when a
     * task already waits (the store keeps it and writes no event).
     */
    const holdForReview = (key: string, newValue: unknown, support: AttributeSupport, withEvent: boolean) => {
      const note = profile.conflicts.find((c) => c.attribute === key);
      markInReview(key);
      const factIds = [...support.factIds].sort();
      const taskKey = uncertainKey(key, newValue, factIds);
      if (context.decidedUncertainKeys.has(taskKey)) return;
      const conflict = note ? { conflict: { key: note.key, a: note.a, b: note.b, others: note.others ?? [] } } : {};
      tasks.push({
        kind: "uncertain_change",
        attribute: key,
        key: taskKey,
        context: { key: taskKey, attribute: key, oldValue: null, newValue, factIds, sources: next.provenance[key]?.sourceKeys ?? [], ...conflict },
        priority: priorityOf("safety"),
        event: withEvent ? { type: "uncertain", attribute: key, oldValue: null, newValue, severity: "safety", details: { key: taskKey } } : null,
      });
    };

    /**
     * A safety list (`change.additiveLists`) against its previous value (`newList` null: the rule has no value now),
     * rulings M5-F-R3 I-3, M6-FIN-R2/R3 and GR-1. Entries the new list adds hold at once (`changed`). An entry of the
     * old list the new one lacks leaves only when
     * - a review removal decision took it out (`support.removedEntries`, „Eintrag entfernen“ or an accepted
     *   `uncertain_change`) and no fact the previous profile cites for the entry is younger than that removal (GR-12:
     *   a younger source naming the entry again consumes the removal for it, also once that fact stops counting;
     *   a withdrawn fact does not count),
     * - it is a computed entry (a restricted area of `prohibitions`, or an entry cited by `computation:`/`poi:` inputs
     *   alone): the newer computation no longer has it, or
     * - every text fact of the old list is withdrawn now (a rejected or ended source, ruling M6-H-R1).
     * Support never lifts an entry by omission: a computed `[]` basis, a reprocess run that misses the entry or facts
     * that stop counting after a model or prompt switch leave it in place (GR-1). Such an entry is carried in its old
     * form with its old provenance, marked `in_review`, and an `uncertain_change` task proposes the new list (unless
     * its key was decided: then it stays without the marker). Without support, kept entries also keep their old form.
     */
    const safetyListDiff = (key: string, oldList: unknown[], newList: unknown[] | null, support: AttributeSupport, supported: boolean) => {
      const prevP = prev.provenance[key]!;
      const entryKey = (e: unknown) => listEntryKey(key, e, ctx);
      const idsOf = (k: string) => prevP.entryFactIds?.[k] ?? [];
      const removedAt = support.removedEntries ?? {};
      // the facts the previous profile cites for a removed entry that are younger than the removal (GR-12)
      const consuming = (k: string) =>
        k in removedAt ? idsOf(k).filter((id) => !context.withdrawnFactIds.has(id) && (context.factObservedAt.get(id) ?? "") > removedAt[k]!) : [];
      const removed = (k: string) => k in removedAt && consuming(k).length === 0;
      // a computed entry: a restricted area of `prohibitions`, or one cited by computation/POI inputs alone
      const computedEntry = (k: string, e: unknown) => {
        if (key === "prohibitions") return isComputedProhibition(e);
        const ids = idsOf(k);
        return ids.length > 0 && ids.every((id) => id.includes(":"));
      };
      const textIds = (k: string, e: unknown) => (computedEntry(k, e) ? [] : idsOf(k).filter((id) => !id.includes(":")));
      const allText = oldList.flatMap((e) => textIds(entryKey(e), e));
      const listWithdrawn = allText.length > 0 && allText.every((id) => context.withdrawnFactIds.has(id));
      const proposed = newList ?? [];
      const newKeys = new Set(proposed.map(entryKey));
      const mayGo = (k: string, e: unknown) => removed(k) || computedEntry(k, e) || (listWithdrawn && textIds(k, e).length > 0);
      const carried = oldList
        .map((e) => [entryKey(e), e] as const)
        .filter(([k, e]) => !newKeys.has(k) && !mayGo(k, e))
        .sort(([a], [b]) => cmp(a, b));
      const takesNew = supported || listWithdrawn;
      const severity = severityFor(key, oldList, newList, cfg);
      if (carried.length === 0 && (takesNew || newList === null)) {
        // an accepted change: the new list (or none) as the rule made it
        if (newList === null) event("changed", key, oldList, null, removalSeverity(key, oldList, cfg));
        else if (!same(oldList, newList)) event("changed", key, oldList, newList, severity);
        return;
      }
      const oldByKey = new Map(oldList.map((e) => [entryKey(e), e]));
      const base = takesNew ? proposed : proposed.map((e) => oldByKey.get(entryKey(e)) ?? e);
      const unsorted = [...base, ...carried.map(([, e]) => e)];
      const merged = key === "prohibitions" ? unsorted.sort(compareProhibitions) : unsorted;
      // the same entries in their old form: the old list stays as it was ordered (ruling M5-F-R3 N-3)
      const sameEntries = merged.length === oldList.length && merged.every((e) => oldByKey.has(entryKey(e)) && same(oldByKey.get(entryKey(e)), e));
      if (sameEntries) {
        keep(key);
      } else {
        profile.attributes[key] = merged;
        profile.provenance[key] = withoutWithdrawn(mergedListProvenance(prevP, next.provenance[key] ?? prevP, merged, key, ctx), context);
        profile.conflicts = profile.conflicts.filter((c) => c.attribute !== key);
        profile.gaps = profile.gaps.filter((g) => g.attribute !== key);
        event("changed", key, oldList, merged, severity);
      }
      if (same(merged, proposed)) return;
      // a consumed removal: the younger facts join the task, so the key the old accept decided does not hide it (GR-12)
      const factIds = [...new Set([...support.factIds, ...carried.flatMap(([k]) => consuming(k))])].sort();
      const taskKey = uncertainKey(key, proposed, factIds);
      if (context.decidedUncertainKeys.has(taskKey)) return;
      // the entries held back and those citing no fact any more stay, marked, while their removal waits (GR-1, M6-FIN-R3)
      const marked = markUncitedEntries(profile.provenance[key]!);
      const held = Object.fromEntries(carried.map(([k]) => [k, IN_REVIEW_GAP] as const));
      const entryMarkers = { ...(marked.entryMarkers ?? {}), ...held };
      profile.provenance[key] = Object.keys(entryMarkers).length > 0 ? { ...marked, entryMarkers } : marked;
      tasks.push({
        kind: "uncertain_change",
        attribute: key,
        key: taskKey,
        // the profile's value while the change waits: the merged list after accepted additions (ruling M5-F-R3 N-1)
        context: { key: taskKey, attribute: key, oldValue: merged, newValue: proposed, factIds, sources: next.provenance[key]?.sourceKeys ?? [] },
        priority: priorityOf("safety"),
        event: { type: "uncertain", attribute: key, oldValue: merged, newValue: proposed, severity: "safety", details: { key: taskKey } },
      });
    };
    for (const def of getFactSchema(next.factSchemaVersion).levels[ctx.level]) {
      const key = def.key;
      const had = key in prev.attributes && prev.provenance[key] !== undefined;
      const oldValue = prev.attributes[key];
      const newValue = next.attributes[key];
      const support = next.support[key] ?? { independent: 0, maxWeight: 0, factIds: [], confirmedAt: {} };
      const supported =
        next.provenance[key]?.origin === "rule" ||
        support.independent >= cfg.change.minIndependent ||
        support.maxWeight > cfg.change.strongWeight;
      const safety = safetyAttribute(key, cfg);
      const additive = attributeIn(key, cfg.change.additiveLists);
      if (!had) {
        // the profile's in_review gap holds the attribute until a supported value or a review decision (ruling M6-FIN-R3)
        const inReview = (prev.gaps ?? []).some((g) => g.attribute === key && g.reason === IN_REVIEW_GAP);
        if (newValue === undefined) {
          if (inReview) markInReview(key);
          continue;
        }
        const openTask = context.openTasks.has(`uncertain_change:${key}`);
        // an unsupported safety value waits: held by the gap, an open task or its discarded key (rulings M6-FIN-R2/R3)
        const held =
          safety &&
          !additive &&
          !supported &&
          (inReview || openTask || context.decidedUncertainKeys.has(uncertainKey(key, newValue, [...support.factIds].sort())));
        if (held) holdForReview(key, newValue, support, !openTask);
        else event("new_attribute", key, null, newValue, severityFor(key, undefined, newValue, cfg));
        continue;
      }
      const oldWithdrawn = withdrawn(prev.provenance[key]!, context.withdrawnFactIds);
      if (additive && Array.isArray(oldValue) && (newValue === undefined || Array.isArray(newValue))) {
        safetyListDiff(key, oldValue, (newValue as unknown[] | undefined) ?? null, support, supported);
      } else if (newValue === undefined) {
        if (canExpire(prev.provenance[key]!) && !oldWithdrawn) keep(key);
        else event("changed", key, oldValue, null, removalSeverity(key, oldValue, cfg));
      } else if (!same(oldValue, newValue)) {
        const severity = severityFor(key, oldValue, newValue, cfg);
        if (supported || (oldWithdrawn && !safety)) {
          event("changed", key, oldValue, newValue, severity);
        } else if (oldWithdrawn) {
          // a withdrawn safety value goes; the weak replacement waits for review (ruling M6-FIN-R2)
          event("changed", key, oldValue, null, removalSeverity(key, oldValue, cfg));
          holdForReview(key, newValue, support, true);
        } else {
          keep(key);
          const factIds = [...support.factIds].sort();
          const taskKey = uncertainKey(key, newValue, factIds);
          if (!context.decidedUncertainKeys.has(taskKey)) {
            tasks.push({
              kind: "uncertain_change",
              attribute: key,
              key: taskKey,
              context: { key: taskKey, attribute: key, oldValue, newValue, factIds, sources: next.provenance[key]?.sourceKeys ?? [] },
              priority: priorityOf(severity),
              event: { type: "uncertain", attribute: key, oldValue, newValue, severity, details: { key: taskKey } },
            });
          }
        }
      }
      const p = profile.provenance[key];
      if (p?.expired && !prev.provenance[key]!.expired) {
        const value = profile.attributes[key];
        event("expired", key, value, value, severityFor(key, value, value, cfg), { lastConfirmedAt: p.lastConfirmedAt });
      }
    }

    for (const key of GEO_FIELDS) {
      if (!same(prev.attributes[key], next.attributes[key])) event("geo_changed", key, prev.attributes[key], next.attributes[key], "info");
    }
    for (const [key, severity] of [["place.kind", "info"], ["exclude", "safety"]] as const) {
      if (prev.attributes[key] !== undefined && !same(prev.attributes[key], next.attributes[key])) {
        event("changed", key, prev.attributes[key], next.attributes[key], severity);
      }
    }
  }

  const oldStatus = (prev?.attributes["place.status"] as string | undefined) ?? null;
  const newStatus = (next.attributes["place.status"] as string | undefined) ?? null;
  if (newStatus === "confirmed" && (oldStatus === null || oldStatus === "candidate")) event("place_new", null, oldStatus, newStatus, "info");
  if (prev !== null && newStatus === "abandoned" && oldStatus !== "abandoned") event("place_abandoned", null, oldStatus, newStatus, "info");

  for (const c of profile.conflicts) {
    if (c.resolution !== null || context.resolutions.has(c.key) || context.decidedConflictKeys.has(c.key)) continue;
    tasks.push({
      kind: "conflict",
      attribute: c.attribute,
      key: c.key,
      context: { key: c.key, attribute: c.attribute, a: c.a, b: c.b, others: c.others ?? [] },
      priority: priorityOf(severityFor(c.attribute, c.a.value, c.b.value, cfg)),
      event: null,
    });
  }

  profile.confidence = profileConfidence(profile.provenance, cfg);
  profile.contentHash = profileContentHash(profile);
  // a kept value that stops citing a withdrawn source, or gains or loses an entry marker, is a new version without
  // an event (rulings M6-FIN-R2/R3): the package's sources follow the profile version (ruling M5-P25 allows versions
  // without events)
  const citationsChanged = prev !== null && [...kept].some((k) => citations(profile.provenance[k]) !== citations(prev.provenance[k]));
  return { profile, events, tasks, versionNeeded: prev === null || prev.contentHash !== profile.contentHash || citationsChanged };
}
