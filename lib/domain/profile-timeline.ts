import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { changeEvents, profiles, type ChangeSeverity, type ChangeType } from "@/lib/db/schema";
import type { ProfileSnapshot } from "@/lib/domain/consolidation/types";
import type { ConfidenceClass } from "@/lib/domain/rules/types";
import { canonicalJson } from "@/lib/domain/facts/schema";
import { asOfDate, profileView, type ProfileView } from "@/lib/domain/profile-view";
import { profileVersion } from "@/lib/domain/timeline";

/*
 * The timeline of a geo object's profile (spec 09 „Zeitachse“, spec 07 `profile_as_of`): its versions, the diff
 * between two of them and the change events. The version as of a date is read by `profileAsOf` (lib/domain/timeline.ts),
 * the only place of that rule.
 */

export type VersionDiff = {
  attribute: string;
  /** `class`: the same value with another confidence class. */
  kind: "added" | "removed" | "changed" | "class";
  before: unknown;
  after: unknown;
  classBefore: ConfidenceClass | null;
  classAfter: ConfidenceClass | null;
};

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/**
 * What changed from version `a` to version `b` (`a` the older one), attribute by attribute, sorted by attribute: a
 * value only in `b` is `added`, only in `a` `removed`, a different value `changed`, the same value with another
 * confidence class `class`; unchanged attributes are left out.
 */
export function diffVersions(a: ProfileSnapshot, b: ProfileSnapshot): VersionDiff[] {
  const keys = [...new Set([...Object.keys(a.attributes), ...Object.keys(b.attributes)])].sort();
  const diffs: VersionDiff[] = [];
  for (const attribute of keys) {
    const inA = Object.hasOwn(a.attributes, attribute);
    const inB = Object.hasOwn(b.attributes, attribute);
    const classBefore = a.provenance[attribute]?.confidenceClass ?? null;
    const classAfter = b.provenance[attribute]?.confidenceClass ?? null;
    const before = inA ? a.attributes[attribute] : null;
    const after = inB ? b.attributes[attribute] : null;
    const kind: VersionDiff["kind"] | null = !inA
      ? "added"
      : !inB
        ? "removed"
        : !same(before, after)
          ? "changed"
          : classBefore !== classAfter
            ? "class"
            : null;
    if (kind) diffs.push({ attribute, kind, before, after, classBefore, classAfter });
  }
  return diffs;
}

/** Why a version differs from its predecessor although no value or class changed (`diffVersions` is empty). */
export type VersionNote = "expired" | "gone_sources" | "conflict" | "other";

/**
 * What else changed from `a` to `b`: attributes that became expired or only-gone-sources (or stopped being), a conflict
 * decision or a new or resolved conflict; `other` when none of these (e.g. other provenance). Values and classes are
 * `diffVersions`' business.
 */
export function versionNotes(a: ProfileSnapshot, b: ProfileSnapshot): VersionNote[] {
  const flag = (s: ProfileSnapshot, key: "expired" | "onlyGoneSources") =>
    Object.keys(s.provenance)
      .filter((k) => s.provenance[k]![key])
      .sort()
      .join("\n");
  const notes: VersionNote[] = [];
  if (flag(a, "expired") !== flag(b, "expired")) notes.push("expired");
  if (flag(a, "onlyGoneSources") !== flag(b, "onlyGoneSources")) notes.push("gone_sources");
  if (canonicalJson(a.conflicts) !== canonicalJson(b.conflicts)) notes.push("conflict");
  return notes.length > 0 ? notes : ["other"];
}

export type TimelineVersion = { version: number; validFrom: string; createdAt: Date; runId: string | null; events: number };

export type TimelineEvent = {
  seq: number;
  type: ChangeType;
  attribute: string | null;
  oldValue: unknown;
  newValue: unknown;
  severity: ChangeSeverity;
  profileVersion: number | null;
  createdAt: Date;
};

/**
 * The versions of the object's profile (by `valid_from`, then version) with the number of change events each carries,
 * and the object's change events, newest first (`seq` descending).
 */
export async function profileTimeline(db: Db, geoObjectId: string): Promise<{ versions: TimelineVersion[]; events: TimelineEvent[] }> {
  const versions = await db
    .select({
      version: profiles.version,
      validFrom: profiles.validFrom,
      createdAt: profiles.createdAt,
      runId: profiles.runId,
      // qualified by hand: drizzle renders a column of the outer table unqualified inside the subquery
      events: sql<number>`(select count(*)::int from change_events e where e.geo_object_id = profiles.geo_object_id and e.profile_version = profiles.version)`,
    })
    .from(profiles)
    .where(eq(profiles.geoObjectId, geoObjectId))
    .orderBy(asc(profiles.validFrom), asc(profiles.version));
  const events = await db
    .select({
      seq: changeEvents.seq,
      type: changeEvents.type,
      attribute: changeEvents.attribute,
      oldValue: changeEvents.oldValue,
      newValue: changeEvents.newValue,
      severity: changeEvents.severity,
      profileVersion: changeEvents.profileVersion,
      createdAt: changeEvents.createdAt,
    })
    .from(changeEvents)
    .where(eq(changeEvents.geoObjectId, geoObjectId))
    .orderBy(desc(changeEvents.seq));
  return { versions: versions.map((v) => ({ ...v, events: Number(v.events) })), events: events.map((e) => ({ ...e, seq: Number(e.seq) })) };
}

export type TimelineView = {
  versions: TimelineVersion[];
  events: TimelineEvent[];
  /** The chosen state: the profile as of `asOf`, else version `version`, else the newest; null when there is none. */
  view: ProfileView | null;
  /** From the version before the shown one (timeline order) to the shown one; null for the first or none shown. */
  diff: VersionDiff[] | null;
  /** Why the shown version exists although `diff` is empty (`versionNotes`); empty otherwise. */
  diffNotes: VersionNote[];
  /** The `asOf` that chose the state (a valid date), else null. */
  asOf: string | null;
  /** `asOf` was given but is no valid date (`YYYY-MM-DD` in the calendar): it is ignored, never passed to `profileAsOf`. */
  asOfInvalid: boolean;
};

/**
 * The timeline tab's state (`?tab=timeline&v=<n>&asOf=YYYY-MM-DD`): `asOf` is validated first (ruling M5-A-R2 note)
 * and, when valid, wins over `version` (`profileAsOf`: an `asOf` before the first version shows no profile).
 */
export async function timelineView(
  db: Db,
  geoObjectId: string,
  opts: { version?: number; asOf?: string; today?: string } = {},
): Promise<TimelineView> {
  const { versions, events } = await profileTimeline(db, geoObjectId);
  const parsed = opts.asOf === undefined ? null : asOfDate.safeParse(opts.asOf);
  const asOf = parsed?.success ? parsed.data : null;
  const view = asOf
    ? await profileView(db, geoObjectId, { asOf, today: opts.today })
    : await profileView(db, geoObjectId, { version: opts.version, today: opts.today });
  let diff: VersionDiff[] | null = null;
  let diffNotes: VersionNote[] = [];
  if (view) {
    const index = versions.findIndex((v) => v.version === view.snapshot.version);
    const previous = index > 0 ? await profileVersion(db, geoObjectId, versions[index - 1]!.version) : null;
    diff = previous ? diffVersions(previous, view.snapshot) : null;
    if (previous && diff!.length === 0) diffNotes = versionNotes(previous, view.snapshot);
  }
  return { versions, events, view, diff, diffNotes, asOf, asOfInvalid: parsed !== null && !parsed.success };
}
