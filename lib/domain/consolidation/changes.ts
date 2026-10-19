import { createHash } from "node:crypto";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { ChangeSeverity, ChangeType } from "@/lib/db/schema/profiles";
import { canonicalJson, getFactSchema } from "@/lib/domain/facts/schema";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { type BuiltProfile, profileContentHash } from "./build";
import { profileConfidence } from "./derived/confidence";
import type { ProfileContext } from "./inputs";
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
 * The provenance of a value kept from the previous profile, with expiry applied on the run date like `buildProfile`
 * does: a text or observation value without computed, POI or review support, last confirmed before `cutoff`, drops
 * one class (its confidence never rises).
 */
function keptProvenance(p: AttributeProvenance, cutoff: string, cfg: ConsolidationConfig): AttributeProvenance {
  if (p.expired) return p;
  const canExpire =
    (p.origin === "text" || p.origin === "observed") &&
    p.computationIds.length === 0 &&
    p.poiIds.length === 0 &&
    !p.sourceKeys.includes("review");
  if (!canExpire || p.lastConfirmedAt === null || p.lastConfirmedAt >= cutoff) return p;
  const confidenceClass = lowerClass(p.confidenceClass);
  return { ...p, expired: true, confidenceClass, confidence: Math.min(p.confidence, classMidpoint(confidenceClass, cfg)) };
}

/**
 * The new profile against the valid one (`prev`, null before the first version), ruling M5-P7/P8/P9/P23:
 * - Without a previous profile: no attribute events; a confirmed place → `place_new`.
 * - Per attribute of the fact schema level: no value before → `new_attribute`; another value supported by
 *   `change.minIndependent` independent sources or a source weighing more than `change.strongWeight` (or set by the
 *   rule itself, origin `rule`) → `changed`; otherwise uncertain: the old value and its provenance stay (its conflict
 *   note goes) and, unless its key (`uncertainKey`) was decided, an `uncertain_change` task draft with an `uncertain`
 *   event. A value without inputs any more stays (no event); expiry ages it.
 * - A value newly `expired` → `expired` (severity by attribute, `details.lastConfirmedAt`).
 * - Identity: name, parent, geometry, position → `geo_changed` (`info`); `place.kind` → `changed` (`info`); `exclude`
 *   → `changed` (`safety`); status newly `confirmed` from none or `candidate` → `place_new`, newly `abandoned` →
 *   `place_abandoned`.
 * - Every conflict without resolution whose key no decided task holds → a `conflict` task draft (priority 2 on a
 *   safety attribute, else 1; no event).
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
    const keep = (key: string) => {
      profile.attributes[key] = prev.attributes[key];
      profile.provenance[key] = keptProvenance(prev.provenance[key]!, cutoff, cfg);
      profile.gaps = profile.gaps.filter((g) => g.attribute !== key);
      profile.conflicts = profile.conflicts.filter((c) => c.attribute !== key);
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
      if (newValue === undefined) {
        keep(key);
      } else if (!same(oldValue, newValue)) {
        const support = next.support[key] ?? { independent: 0, maxWeight: 0, factIds: [] };
        const severity = severityFor(key, oldValue, newValue, cfg);
        const supported =
          next.provenance[key]?.origin === "rule" ||
          support.independent >= cfg.change.minIndependent ||
          support.maxWeight > cfg.change.strongWeight;
        if (supported) {
          event("changed", key, oldValue, newValue, severity);
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
      context: { key: c.key, attribute: c.attribute, a: c.a, b: c.b },
      priority: priorityOf(severityFor(c.attribute, c.a.value, c.b.value, cfg)),
      event: null,
    });
  }

  profile.confidence = profileConfidence(profile.provenance, cfg);
  profile.contentHash = profileContentHash(profile);
  return { profile, events, tasks, versionNeeded: prev === null || prev.contentHash !== profile.contentHash };
}
