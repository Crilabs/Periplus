import { createHash } from "node:crypto";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { ChangeSeverity, ChangeType } from "@/lib/db/schema/profiles";
import { canonicalJson, getFactSchema } from "@/lib/domain/facts/schema";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { type AttributeSupport, type BuiltProfile, conflictResolution, profileContentHash } from "./build";
import { profileConfidence } from "./derived/confidence";
import type { ProfileContext } from "./inputs";
import { compareProhibitions, prohibitionEntryKey } from "./rules/prohibitions";
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
 * „Quelle beenden“, ruling M6-H-R1): it is withdrawn, not kept to expire, and a new value replaces it without support.
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

/** Severity of a value that is gone: a shelter sector without a value any more is `safety` (no Δ to measure). */
function removalSeverity(attribute: string, oldValue: unknown, cfg: ConsolidationConfig): ChangeSeverity {
  return attribute.startsWith("shelter.") ? "safety" : severityFor(attribute, oldValue, null, cfg);
}

/** The identity key of one entry of a safety list (`prohibitions` by kind or restricted area, else the union key). */
function listEntryKey(attribute: string, entry: unknown, ctx: DiffContext): string {
  if (attribute === "prohibitions") return prohibitionEntryKey(entry);
  return unionEntryKey(entry, { attribute, level: ctx.level, place: null, today: ctx.today, cfg: ctx.cfg });
}

/**
 * The old list with the entries the new one adds (ruling M5-F-R3 I-3): kept entries in their old form, added entries
 * in the new list's order, entries the new list lacks after them in the union rule's order for entries no current
 * source names, i.e. by entry key (ruling M5-F-R3 N-3; `prohibitions` sorted by kind); `null` when the new list adds
 * nothing.
 */
function withAdditions(attribute: string, oldList: unknown[], newList: unknown[], ctx: DiffContext): unknown[] | null {
  const oldByKey = new Map(oldList.map((e) => [listEntryKey(attribute, e, ctx), e]));
  const newKeys = new Set(newList.map((e) => listEntryKey(attribute, e, ctx)));
  if ([...newKeys].every((k) => oldByKey.has(k))) return null;
  const carried = [...oldByKey].filter(([k]) => !newKeys.has(k)).sort(([a], [b]) => cmp(a, b)).map(([, e]) => e);
  const merged = [...newList.map((e) => oldByKey.get(listEntryKey(attribute, e, ctx)) ?? e), ...carried];
  return attribute === "prohibitions" ? merged.sort(compareProhibitions) : merged;
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
 *   - no value before → `new_attribute`;
 *   - another value supported by `change.minIndependent` independent sources or a source weighing more than
 *     `change.strongWeight` (or set by the rule itself, origin `rule`) → `changed`;
 *   - otherwise uncertain: the old value, its provenance and its conflict note stay and, unless its key
 *     (`uncertainKey`) was decided, an `uncertain_change` task draft with an `uncertain` event. On a list of
 *     `change.additiveLists` (safety lists) the entries the new list adds are accepted anyway, per entry (`changed`);
 *     only the rest of the change (removed or changed entries) waits as uncertain;
 *   - a value without inputs any more stays (no event, expiry ages it) if it can expire (text or observation);
 *     a computed, rule, review or POI value goes, its gap stays, and `changed` → null is emitted (ruling M5-F-R3 I-1);
 *   - a text or observed value resting only on facts of rejected or ended sources (`withdrawn`, ruling M6-H-R1) goes
 *     like a computed one, and another value replaces it as `changed` without the support rule;
 * - A kept value still carried by a current input is confirmed again (`lastConfirmedAt`, ruling M5-F-R3 M-1).
 * - A value newly `expired` → `expired` (severity by attribute, `details.lastConfirmedAt`).
 * - Identity: name, parent, geometry, position → `geo_changed` (`info`); `place.kind` → `changed` (`info`); `exclude`
 *   → `changed` (`safety`); status newly `confirmed` from none or `candidate` → `place_new`, newly `abandoned` →
 *   `place_abandoned`.
 * - Every conflict without resolution (decided keys are marked `decided` by `buildProfile`) → a `conflict` task draft
 *   with both sides and the further value groups (`others`); priority 2 on a safety attribute, else 1; no event.
 * - `versionNeeded`: no previous profile, or another content hash after the old values came back (profile confidence
 *   and hash recomputed).
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
  const event = (type: ChangeType, attribute: string | null, oldValue: unknown, newValue: unknown, severity: ChangeSeverity, details: Record<string, unknown> = {}) =>
    events.push({ type, attribute, oldValue: oldValue ?? null, newValue: newValue ?? null, severity, details });

  if (prev !== null) {
    const cutoff = dateMinusDays(ctx.today, cfg.expiry.cycles * context.tileCycleDays);
    /** The old value with its provenance and its conflict note (re-resolved against the decided tasks). */
    const keep = (key: string) => {
      const support = next.support[key];
      const confirmedAt = support?.confirmedAt[canonicalJson(prev.attributes[key] ?? null)] ?? producedConfirmation(prev.provenance[key]!, support);
      profile.attributes[key] = prev.attributes[key];
      profile.provenance[key] = keptProvenance(prev.provenance[key]!, cutoff, cfg, confirmedAt);
      profile.gaps = profile.gaps.filter((g) => g.attribute !== key);
      profile.conflicts = [
        ...profile.conflicts.filter((c) => c.attribute !== key),
        ...(prev.conflicts ?? []).filter((c) => c.attribute === key).map((c) => ({ ...c, resolution: conflictResolution(c.key, context) })),
      ].sort((a, b) => cmp(a.attribute, b.attribute) || cmp(a.key, b.key));
    };

    for (const def of getFactSchema(next.factSchemaVersion).levels[ctx.level]) {
      const key = def.key;
      const had = key in prev.attributes && prev.provenance[key] !== undefined;
      const oldValue = prev.attributes[key];
      const newValue = next.attributes[key];
      if (!had) {
        if (newValue !== undefined) event("new_attribute", key, null, newValue, severityFor(key, undefined, newValue, cfg));
        continue;
      }
      const oldWithdrawn = withdrawn(prev.provenance[key]!, context.withdrawnFactIds);
      if (newValue === undefined) {
        if (canExpire(prev.provenance[key]!) && !oldWithdrawn) keep(key);
        else event("changed", key, oldValue, null, removalSeverity(key, oldValue, cfg));
      } else if (!same(oldValue, newValue)) {
        const support = next.support[key] ?? { independent: 0, maxWeight: 0, factIds: [], confirmedAt: {} };
        const severity = severityFor(key, oldValue, newValue, cfg);
        const supported =
          oldWithdrawn ||
          next.provenance[key]?.origin === "rule" ||
          support.independent >= cfg.change.minIndependent ||
          support.maxWeight > cfg.change.strongWeight;
        if (supported) {
          event("changed", key, oldValue, newValue, severity);
        } else {
          const merged =
            attributeIn(key, cfg.change.additiveLists) && Array.isArray(oldValue) && Array.isArray(newValue)
              ? withAdditions(key, oldValue, newValue, ctx)
              : null;
          if (merged !== null) {
            // added entries of a safety list hold at once (ruling M5-F-R3 I-3)
            profile.attributes[key] = merged;
            profile.provenance[key] = mergedListProvenance(prev.provenance[key]!, next.provenance[key]!, merged, key, ctx);
            profile.conflicts = profile.conflicts.filter((c) => c.attribute !== key);
            event("changed", key, oldValue, merged, severity);
          } else {
            keep(key);
          }
          if (merged === null || !same(merged, newValue)) {
            const factIds = [...support.factIds].sort();
            const taskKey = uncertainKey(key, newValue, factIds);
            if (!context.decidedUncertainKeys.has(taskKey)) {
              tasks.push({
                kind: "uncertain_change",
                attribute: key,
                key: taskKey,
                // the profile's value while the change waits: the merged list after accepted additions (ruling M5-F-R3 N-1)
                context: { key: taskKey, attribute: key, oldValue: merged ?? oldValue, newValue, factIds, sources: next.provenance[key]?.sourceKeys ?? [] },
                priority: priorityOf(severity),
                event: { type: "uncertain", attribute: key, oldValue: merged ?? oldValue, newValue, severity, details: { key: taskKey } },
              });
            }
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
  return { profile, events, tasks, versionNeeded: prev === null || prev.contentHash !== profile.contentHash };
}
