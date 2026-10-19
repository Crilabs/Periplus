import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getConsolidationConfig } from "@/lib/config";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { computations, profiles, profileSummaries, type SummaryStatus } from "@/lib/db/schema";
import { popularityForArea } from "@/lib/domain/consolidation/derived/popularity";
import { formatProfileValue, profileAttributeLabel, ruleLabel } from "@/lib/domain/consolidation/format";
import { prohibitionEntryKey } from "@/lib/domain/consolidation/rules/prohibitions";
import { unionEntryKey } from "@/lib/domain/consolidation/rules/union";
import type {
  AttributeProvenance,
  ConfidenceClass,
  ConflictNote,
  ProfileSnapshot,
  ProvenanceOrigin,
  RuleContext,
} from "@/lib/domain/consolidation/types";
import { attributeIn } from "@/lib/domain/consolidation/weights";
import { getFactSchema } from "@/lib/domain/facts/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { factViewsByIds, type FactView } from "@/lib/domain/geo-facts";
import { latestProfile, profileAsOf, profileVersion } from "@/lib/domain/timeline";

/*
 * The consolidated profile of a geo object for the admin pages (spec 09 "Reiter Profil", spec 07): one row per
 * attribute with its provenance (origin, rule, confidence class, dates, conflict, expiry), a change under review read
 * from the open `uncertain_change` task (ruling M5-P8: never stored in the profile), the per-entry provenance of list
 * values, the gaps with their reason, and on click exactly the facts, computations and POIs the value cites.
 */

/** A change of the attribute waiting in an open `uncertain_change` task („Änderung in Prüfung“, ruling M5-P8). */
export type PendingChange = { taskId: string; key: string; newValue: unknown; display: string };

/**
 * One entry of a list value with the input ids naming it (`entryFactIds`: fact ids, `computation:<id>`, `poi:<id>`);
 * `removable` for the text entries of a safety list (`change.additiveLists`) in the newest version („Eintrag
 * entfernen“).
 */
export type ProfileEntry = { key: string; entry: unknown; display: string; inputIds: string[]; removable: boolean };

export type ProfileRow = {
  attribute: string;
  label: string;
  value: unknown;
  display: string;
  origin: ProvenanceOrigin;
  rule: AttributeProvenance["rule"];
  ruleLabel: string;
  confidence: number;
  confidenceClass: ConfidenceClass;
  observedAt: string | null;
  lastConfirmedAt: string | null;
  expired: boolean;
  /** Every supporting document is gone: no longer „aktuell bestätigt“. */
  onlyGoneSources: boolean;
  conflict: ConflictNote | null;
  /** The conflict's review task (the open one, else the newest with the conflict's key). */
  conflictTaskId: string | null;
  pending: PendingChange | null;
  factCount: number;
  sourceKeys: string[];
  /** List values with per-entry provenance; null for other values. */
  entries: ProfileEntry[] | null;
  derivedFrom: Record<string, unknown> | null;
};

export type ProfileView = {
  snapshot: ProfileSnapshot;
  /** The newest version is shown (pending changes and „Eintrag entfernen“ only there). */
  latest: boolean;
  createdAt: Date;
  runId: string | null;
  identity: Array<{ attribute: string; label: string; display: string }>;
  rows: ProfileRow[];
  derived: Array<{ attribute: string; label: string; display: string }>;
  gaps: Array<{ attribute: string; label: string; reason: string }>;
  popularity: number | null;
  summary: { text: string | null; status: SummaryStatus } | null;
  /** Number of versions of the object's profile (the newest version number). */
  versions: number;
};

/** A date `YYYY-MM-DD` that exists in the calendar (validated before `profileAsOf`, ruling M5-A-R2 note). */
export const asOfDate = z.iso.date();

const isUuid = (id: string) => z.uuid().safeParse(id).success;

/** Rank of fact attributes in fact-schema order (all levels, first occurrence). */
function schemaOrder(factSchemaVersion: string): Map<string, number> {
  const order = new Map<string, number>();
  for (const defs of Object.values(getFactSchema(factSchemaVersion).levels)) {
    for (const d of defs) if (!order.has(d.key)) order.set(d.key, order.size);
  }
  return order;
}

/** A rule context for the entry keys of `attribute` (only `attribute` and `cfg` are read). */
const keyContext = (attribute: string, cfg: ConsolidationConfig): RuleContext => ({
  attribute,
  level: "place",
  place: null,
  today: "1970-01-01",
  cfg,
});

/** A text entry of `prohibitions` (`{ kind, months }`); computed entries carry a restricted area. */
export const isTextProhibition = (entry: unknown): boolean =>
  entry !== null && typeof entry === "object" && "months" in entry && !("restrictedAreaId" in entry);

/** The identity key of a list entry: `prohibitionEntryKey` for `prohibitions`, the union key otherwise. */
export function profileEntryKey(attribute: string, entry: unknown, cfg: ConsolidationConfig): string {
  return attribute === "prohibitions" ? prohibitionEntryKey(entry) : unionEntryKey(entry, keyContext(attribute, cfg));
}

/** Whether „Eintrag entfernen“ applies to an entry: a safety list (`change.additiveLists`); of `prohibitions` only text entries. */
export function isRemovableEntry(attribute: string, entry: unknown, cfg: ConsolidationConfig): boolean {
  if (!attributeIn(attribute, cfg.change.additiveLists)) return false;
  return attribute !== "prohibitions" || isTextProhibition(entry);
}

function entriesOf(attribute: string, value: unknown, p: AttributeProvenance, cfg: ConsolidationConfig, latest: boolean): ProfileEntry[] | null {
  if (!p.entryFactIds || !Array.isArray(value)) return null;
  return value.map((entry) => {
    const key = profileEntryKey(attribute, entry, cfg);
    return {
      key,
      entry,
      display: formatProfileValue(attribute, [entry]),
      inputIds: p.entryFactIds?.[key] ?? [],
      removable: latest && isRemovableEntry(attribute, entry, cfg),
    };
  });
}

type TaskRow = { id: string; kind: "conflict" | "uncertain_change"; status: string; attribute: string; key: string | null; new_value: unknown };

/** The `conflict` / `uncertain_change` tasks of the object (subject `<geoObjectId>:<attribute>`), newest first. */
async function profileTasks(db: Db, geoObjectId: string): Promise<TaskRow[]> {
  const prefix = `${geoObjectId}:`;
  const { rows } = await db.execute<TaskRow>(sql`
    select id, kind::text as kind, status::text as status, substr(subject_id, ${prefix.length + 1}) as attribute,
           context->>'key' as key, context->'newValue' as new_value
    from review_tasks
    where kind in ('conflict', 'uncertain_change') and subject_type = 'profile_attribute'
      and left(subject_id, ${prefix.length}) = ${prefix}
    order by created_at desc, id desc
  `);
  return rows;
}

function buildRow(
  attribute: string,
  snapshot: ProfileSnapshot,
  cfg: ConsolidationConfig,
  tasks: TaskRow[],
  latest: boolean,
): ProfileRow {
  const p = snapshot.provenance[attribute]!;
  const value = snapshot.attributes[attribute];
  const conflict = snapshot.conflicts.find((c) => c.attribute === attribute) ?? null;
  const conflictTask = conflict
    ? (tasks.find((t) => t.kind === "conflict" && t.attribute === attribute && t.status === "open") ??
      tasks.find((t) => t.kind === "conflict" && t.attribute === attribute && t.key === conflict.key) ??
      null)
    : null;
  const open = latest ? tasks.find((t) => t.kind === "uncertain_change" && t.attribute === attribute && t.status === "open" && t.key !== null) : undefined;
  return {
    attribute,
    label: profileAttributeLabel(attribute),
    value,
    display: formatProfileValue(attribute, value),
    origin: p.origin,
    rule: p.rule,
    ruleLabel: ruleLabel(p.rule, cfg),
    confidence: p.confidence,
    confidenceClass: p.confidenceClass,
    observedAt: p.observedAt,
    lastConfirmedAt: p.lastConfirmedAt,
    expired: p.expired,
    onlyGoneSources: p.onlyGoneSources,
    conflict,
    conflictTaskId: conflictTask?.id ?? null,
    pending: open ? { taskId: open.id, key: open.key!, newValue: open.new_value, display: formatProfileValue(attribute, open.new_value) } : null,
    factCount: p.factIds.length,
    sourceKeys: p.sourceKeys,
    entries: entriesOf(attribute, value, p, cfg, latest),
    derivedFrom: p.derivedFrom ?? null,
  };
}

/** The snapshot asked for: `version`, else the profile as of `asOf` (validated), else the newest. */
async function chosenSnapshot(db: Db, geoObjectId: string, opts: { version?: number; asOf?: string }): Promise<ProfileSnapshot | null> {
  if (opts.version !== undefined) return profileVersion(db, geoObjectId, opts.version);
  if (opts.asOf !== undefined) return profileAsOf(db, geoObjectId, asOfDate.parse(opts.asOf));
  return latestProfile(db, geoObjectId);
}

/** The area of the object: its place's tile, else the tile of its centroid (as `loadContext`). */
async function areaOf(db: Db, geoObjectId: string, today: string): Promise<string | null> {
  const { rows } = await db.execute<{ area_id: string | null }>(sql`
    select t.area_id
    from geo_objects o
    left join places p on p.geo_object_id = o.id and p.valid_to is null and p.merged_into_id is null
    left join tiles t on t.id = coalesce(p.tile_id, tile_id_for(o.centroid))
      and t.valid_from <= ${today}::date and (t.valid_to is null or t.valid_to > ${today}::date)
    where o.id = ${geoObjectId}
    limit 1
  `);
  return rows[0]?.area_id ?? null;
}

const isIdentity = (p: AttributeProvenance) => p.rule === "identity" && p.origin === "gazetteer";

/**
 * The profile of a geo object for the admin pages: `version`, or the profile as of `asOf` (`YYYY-MM-DD`, validated:
 * an impossible date throws), else the newest version; null without a profile (or none on that date). Rows in fact
 * schema order (unknown keys and `exclude` after them, by name); identity fields (`geo.*`, `place.*`) go to the head,
 * derived values (`derived.*`) to their own list. `popularity` is read now (it depends on the area, ruling M5-E-R2
 * NOTE M6); `today` defaults to the UTC date.
 */
export async function profileView(
  db: Db,
  geoObjectId: string,
  opts: { version?: number; asOf?: string; today?: string } = {},
): Promise<ProfileView | null> {
  const snapshot = await chosenSnapshot(db, geoObjectId, opts);
  if (!snapshot) return null;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const cfg = getConsolidationConfig(snapshot.rulesVersion);
  const [meta] = await db
    .select({ createdAt: profiles.createdAt, runId: profiles.runId })
    .from(profiles)
    .where(and(eq(profiles.geoObjectId, geoObjectId), eq(profiles.version, snapshot.version)));
  const [{ versions }] = (await db
    .select({ versions: sql<number>`max(${profiles.version})::int` })
    .from(profiles)
    .where(eq(profiles.geoObjectId, geoObjectId))) as [{ versions: number }];
  const latest = snapshot.version === Number(versions);
  const tasks = await profileTasks(db, geoObjectId);

  const order = schemaOrder(snapshot.factSchemaVersion);
  const rank = (key: string) => order.get(key) ?? Number.MAX_SAFE_INTEGER;
  const keys = Object.keys(snapshot.provenance).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const identity = keys
    .filter((k) => isIdentity(snapshot.provenance[k]!) && k !== "exclude")
    .map((k) => ({ attribute: k, label: profileAttributeLabel(k), display: formatProfileValue(k, snapshot.attributes[k]) }));
  const derived = keys
    .filter((k) => snapshot.provenance[k]!.rule === "derived")
    .map((k) => ({ attribute: k, label: profileAttributeLabel(k), display: formatProfileValue(k, snapshot.attributes[k]) }));
  const rows = keys
    .filter((k) => k === "exclude" || (!isIdentity(snapshot.provenance[k]!) && snapshot.provenance[k]!.rule !== "derived"))
    .map((k) => buildRow(k, snapshot, cfg, tasks, latest));

  const areaId = await areaOf(db, geoObjectId, today);
  const popularity = areaId ? ((await popularityForArea(db, areaId, today)).get(geoObjectId) ?? null) : null;
  const [summary] = await db
    .select({ text: profileSummaries.text, status: profileSummaries.status })
    .from(profileSummaries)
    .where(and(eq(profileSummaries.geoObjectId, geoObjectId), eq(profileSummaries.profileVersion, snapshot.version)))
    .orderBy(sql`(${profileSummaries.status} = 'ok') desc`, desc(profileSummaries.createdAt), desc(profileSummaries.id))
    .limit(1);

  return {
    snapshot,
    latest,
    createdAt: meta!.createdAt,
    runId: meta!.runId,
    identity,
    rows,
    derived,
    gaps: snapshot.gaps.map((g) => ({ attribute: g.attribute, label: profileAttributeLabel(g.attribute), reason: g.reason })),
    popularity,
    summary: summary ?? null,
    versions: Number(versions),
  };
}

/** An entry's input that is no fact: a computation (`computation:<id>`) or a POI (`poi:<id>`), resolved when it still exists. */
export type EntryInput =
  | { type: "computation"; id: string; kind: string | null; createdAt: Date | null }
  | { type: "poi"; id: string; name: string | null };

/** One entry of a list value with the facts naming it (uuid input ids) and its other inputs (`computation:`, `poi:`). */
export type EntryFacts = ProfileEntry & { facts: FactView[]; otherInputs: EntryInput[] };

const REF = /^(computation|poi):(.+)$/;

export type AttributeFactsView = {
  row: ProfileRow;
  /** Exactly the facts of `provenance.factIds`, newest observation first. */
  facts: FactView[];
  computations: Array<{ id: string; kind: string; createdAt: Date }>;
  pois: Array<{ id: string; name: string }>;
  entries: EntryFacts[] | null;
};

/**
 * What one attribute of profile `version` cites (click on a row): exactly the facts of `provenance.factIds` with their
 * quote in context (`FactView`), the computations and the POIs; list values per entry with the facts naming it.
 * Null when the version or the attribute does not exist.
 */
export async function profileAttributeFacts(
  db: Db,
  geoObjectId: string,
  version: number,
  attribute: string,
): Promise<AttributeFactsView | null> {
  const snapshot = await profileVersion(db, geoObjectId, version);
  const p = snapshot?.provenance[attribute];
  if (!snapshot || !p) return null;
  const cfg = getConsolidationConfig(snapshot.rulesVersion);
  const [{ versions }] = (await db
    .select({ versions: sql<number>`max(${profiles.version})::int` })
    .from(profiles)
    .where(eq(profiles.geoObjectId, geoObjectId))) as [{ versions: number }];
  const latest = snapshot.version === Number(versions);
  const row = buildRow(attribute, snapshot, cfg, await profileTasks(db, geoObjectId), latest);

  const entryIds = (row.entries ?? []).flatMap((e) => e.inputIds).filter(isUuid);
  const views = await factViewsByIds(db, [...new Set([...p.factIds.filter(isUuid), ...entryIds])]);
  const byObservation = (a: FactView, b: FactView) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : a.id.localeCompare(b.id));
  const facts = p.factIds.flatMap((id) => views.get(id) ?? []).sort(byObservation);

  const computationRows = await computationsByIds(db, p.computationIds);
  const poiRows = await poisByIds(db, p.poiIds);

  // the entries' own computation / POI inputs, identified per entry (they may differ from the attribute's lists)
  const refs = (row.entries ?? []).flatMap((e) => e.inputIds.flatMap((id) => (REF.exec(id) ? [REF.exec(id)!] : [])));
  const refIds = (type: string) => [...new Set(refs.filter((m) => m[1] === type).map((m) => m[2]!))];
  const refComputations = new Map((await computationsByIds(db, refIds("computation"))).map((c) => [c.id, c]));
  const refPois = new Map((await poisByIds(db, refIds("poi"))).map((q) => [q.id, q]));

  const entries =
    row.entries?.map((e) => ({
      ...e,
      facts: e.inputIds.flatMap((id) => views.get(id) ?? []).sort(byObservation),
      otherInputs: e.inputIds.flatMap((id): EntryInput[] => {
        const m = REF.exec(id);
        if (!m) return [];
        if (m[1] === "poi") return [{ type: "poi", id: m[2]!, name: refPois.get(m[2]!)?.name ?? null }];
        const c = refComputations.get(m[2]!);
        return [{ type: "computation", id: m[2]!, kind: c?.kind ?? null, createdAt: c?.createdAt ?? null }];
      }),
    })) ?? null;
  return { row, facts, computations: computationRows, pois: poiRows, entries };
}

/** The computations among `ids` (non-uuid ids dropped); no query without a uuid. */
async function computationsByIds(db: Db, ids: string[]): Promise<Array<{ id: string; kind: string; createdAt: Date }>> {
  const uuids = ids.filter(isUuid);
  if (uuids.length === 0) return [];
  return db
    .select({ id: computations.id, kind: computations.kind, createdAt: computations.createdAt })
    .from(computations)
    .where(inArray(computations.id, uuids))
    .orderBy(desc(computations.createdAt), computations.id);
}

/** The geo objects among `ids` (non-uuid ids dropped) with their display name; no query without a uuid. */
async function poisByIds(db: Db, ids: string[]): Promise<Array<{ id: string; name: string }>> {
  const uuids = ids.filter(isUuid);
  if (uuids.length === 0) return [];
  const { rows } = await db.execute<{ id: string; name: string | null }>(sql`
    select o.id, ${displayNameSql(sql`o.id`)} as name from geo_objects o
    where o.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(uuids)}::jsonb))
    order by o.id
  `);
  return rows.map((r) => ({ id: r.id, name: r.name ?? r.id }));
}
