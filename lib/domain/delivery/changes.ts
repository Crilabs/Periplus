import { and, gte, inArray, lt, sql } from "drizzle-orm";
import type { ChangeEntry, HighlightBody, RegionBody, SpotBody } from "@/contract";
import type { DeliveryConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { changeEvents, type ChangeSeverity, type ChangeType } from "@/lib/db/schema";
import type { DeliveredObjectType } from "@/lib/db/schema/deliveries";
import { visibleChangeEventsFilter } from "@/lib/domain/change-feed";
import { canonicalJson } from "@/lib/domain/facts/schema";
import { SPOT_FIELDS } from "./map-spot";
import type { RemovedObject, VersionedObject } from "./versioning";
import { EXCLUDE_REASON_DE, type ContractExcludeReason } from "./vocab";

/*
 * `changes.json` (spec 08, Teil B "Versionierung und Change-Feed"): the entries come from the contract diff of two
 * packages (ruling M6-P26), the change events of the window between them only raise the severity (rulings M6-P1,
 * M6-P2). Pure apart from `eventSeverities`.
 */

const SEVERITY_RANK: Record<ChangeSeverity, number> = { info: 0, notable: 1, safety: 2 };
const maxSeverity = (...s: ChangeSeverity[]): ChangeSeverity =>
  s.reduce((a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a), "info");

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const VERSION_FIELDS = new Set(["profileVersion", "validFrom"]);
const MAX_DEPTH = 3;

/**
 * The changed leaf paths between two contract objects, dot-joined down to depth 3 (`shelter.sectors.N`,
 * `services.taverna`, `limits.maxDraft`); arrays are leaves, the version fields are ignored; sorted.
 */
export function changedFields(before: object, after: object): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if (path.length < MAX_DEPTH && isRecord(a) && isRecord(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (path.length === 0 && VERSION_FIELDS.has(key)) continue;
        walk(a[key], b[key], [...path, key]);
      }
      return;
    }
    if (canonicalJson(a ?? null) !== canonicalJson(b ?? null)) out.push(path.join("."));
  };
  walk(before, after, []);
  return out.sort(cmp);
}

const SAFETY_PREFIXES = ["exclude", "limits", "hazards"];
const NOTABLE_PREFIXES = ["services", "highlightIds", "occupancy", "berth", "seasonNote"];
const hasPrefix = (field: string, prefixes: string[]) => prefixes.some((p) => field === p || field.startsWith(`${p}.`));
const SECTOR_FIELD = /^shelter\.sectors\.([A-Z]{1,2})$/;

function sectorValue(body: object | null, sector: string): number | null {
  const shelter = body && (body as { shelter?: unknown }).shelter;
  const sectors = isRecord(shelter) ? shelter.sectors : undefined;
  const v = isRecord(sectors) ? sectors[sector] : undefined;
  return typeof v === "number" ? v : null;
}

/**
 * Severity of a contract change (Teil B "safety ist gesetzt, wenn sich exclude, shelter um mehr als 0,2 in einem
 * Sektor, limits oder hazards geändert haben"): `safety` for `exclude`, `limits`, `hazards` or a sector moving by more
 * than `shelterDelta` (an unknown side counts as such a move); `notable` for services, highlights, occupancy, berth and
 * season notes; else `info`.
 */
export function contractSeverity(
  fields: string[],
  before: object | null,
  after: object | null,
  cfg: DeliveryConfig["severity"],
): ChangeSeverity {
  let severity: ChangeSeverity = "info";
  for (const field of fields) {
    if (hasPrefix(field, SAFETY_PREFIXES)) return "safety";
    const sector = SECTOR_FIELD.exec(field)?.[1];
    if (sector !== undefined) {
      const a = sectorValue(before, sector);
      const b = sectorValue(after, sector);
      if (a === null || b === null || Math.abs(a - b) > cfg.shelterDelta + 1e-9) return "safety";
    }
    if (hasPrefix(field, NOTABLE_PREFIXES)) severity = "notable";
  }
  return severity;
}

/** Event types that change a delivered value (ruling M6-P2); `uncertain` and `expired` keep the value. */
const APPLIED_TYPES: ChangeType[] = ["new_attribute", "changed", "place_new", "place_abandoned", "geo_changed"];
const OBJECT_TYPES: ChangeType[] = ["place_new", "place_abandoned", "geo_changed"];

/**
 * The applied change events of one object in a package window: the highest severity of its object events (`place_*`,
 * `geo_changed`) and of each attribute's events.
 */
export type ObjectEvents = { object: ChangeSeverity | null; attributes: Map<string, ChangeSeverity> };

/**
 * The change events of the objects in the package window (ruling M6-P1): `fromXmin <= xact_id < toXmin`, read only
 * through `visibleChangeEventsFilter` (every row below the snapshot's xmin is settled). `fromXmin` null = the first
 * package of the area, which uses no events. Only applied event types count (ruling M6-P2).
 */
export async function eventSeverities(
  db: Db,
  geoObjectIds: string[],
  window: { fromXmin: string | null; toXmin: string },
): Promise<Map<string, ObjectEvents>> {
  const out = new Map<string, ObjectEvents>();
  if (window.fromXmin === null || geoObjectIds.length === 0) return out;
  const rows = await db
    .select({ geoObjectId: changeEvents.geoObjectId, type: changeEvents.type, attribute: changeEvents.attribute, severity: changeEvents.severity })
    .from(changeEvents)
    .where(
      and(
        inArray(changeEvents.geoObjectId, [...new Set(geoObjectIds)]),
        inArray(changeEvents.type, APPLIED_TYPES),
        gte(changeEvents.xactId, sql`${window.fromXmin}::xid8`),
        lt(changeEvents.xactId, sql`${window.toXmin}::xid8`),
        visibleChangeEventsFilter(),
      ),
    );
  for (const r of rows) {
    const e = out.get(r.geoObjectId) ?? { object: null, attributes: new Map<string, ChangeSeverity>() };
    if (OBJECT_TYPES.includes(r.type) || r.attribute === null) {
      e.object = maxSeverity(e.object ?? "info", r.severity);
    } else {
      e.attributes.set(r.attribute, maxSeverity(e.attributes.get(r.attribute) ?? "info", r.severity));
    }
    out.set(r.geoObjectId, e);
  }
  return out;
}

/**
 * Profile attributes behind each contract field of a highlight and a region (as `SPOT_FIELDS[field].attributes`):
 * an attribute event raises only a change of a field it feeds (ruling M6-P2).
 */
export const HIGHLIGHT_FIELD_ATTRIBUTES: Record<keyof HighlightBody, string[]> = {
  id: [],
  name: ["geo.name"],
  category: [],
  importance: ["derived.importance"],
  position: ["place.position"],
  spotIds: ["derived.spot_ids"],
  regionId: [],
  season: ["season_notes"],
  summary: [],
  sources: [],
  externalRefs: [],
  score: ["exists"],
};

const REGION_FACT_ATTRIBUTES = ["meltemi_exposure", "ferry_traffic", "charter_bases", "supply_ports"];
export const REGION_FIELD_ATTRIBUTES: Record<keyof RegionBody, string[]> = {
  id: [],
  name: ["geo.name"],
  names: ["geo.name"],
  type: [],
  center: [],
  radiusNm: [],
  polygon: [],
  parentId: ["geo.parent_id"],
  spotIds: [],
  character: REGION_FACT_ATTRIBUTES,
  facts: REGION_FACT_ATTRIBUTES,
};

function fieldAttributes(type: DeliveredObjectType, field: string): string[] {
  const top = field.split(".")[0]!;
  const table: Record<string, { attributes: string[] } | string[]> =
    type === "spot" ? SPOT_FIELDS : type === "highlight" ? HIGHLIGHT_FIELD_ATTRIBUTES : REGION_FIELD_ATTRIBUTES;
  const rule = table[top];
  return rule === undefined ? [] : Array.isArray(rule) ? rule : rule.attributes;
}

/** Object events always count; an attribute event only for a changed field it feeds. */
function eventSeverity(type: DeliveredObjectType, fields: string[], events: ObjectEvents | undefined): ChangeSeverity {
  if (!events) return "info";
  let severity = events.object ?? "info";
  const fed = new Set(fields.flatMap((f) => fieldAttributes(type, f)));
  for (const [attribute, s] of events.attributes) if (fed.has(attribute)) severity = maxSeverity(severity, s);
  return severity;
}

/** German labels of the first-level contract fields for `summary.de` ("Geändert: Schutz, Versorgung."). */
export const FIELD_LABELS_DE: Record<keyof SpotBody | keyof HighlightBody | keyof RegionBody, string> = {
  id: "Kennung",
  kind: "Art",
  name: "Name",
  names: "Namen",
  position: "Position",
  anchorPosition: "Ankerposition",
  shelter: "Schutz",
  depth: "Tiefe",
  seabed: "Grund",
  holding: "Halt",
  limits: "Grenzen",
  mooring: "Festmachen",
  services: "Versorgung",
  berth: "Liegeplatz",
  occupancy: "Belegung",
  exclude: "Ausschluss",
  hazards: "Gefahren",
  seasonNote: "Saisonhinweise",
  score: "Bewertung",
  highlightIds: "Highlights",
  externalRefs: "Externe Kennungen",
  summary: "Zusammenfassung",
  sources: "Quellen",
  provenance: "Herkunft",
  regionId: "Region",
  mergedInto: "Zusammenlegung",
  category: "Kategorie",
  importance: "Bedeutung",
  spotIds: "Spots",
  season: "Saison",
  type: "Typ",
  center: "Mittelpunkt",
  radiusNm: "Radius",
  polygon: "Umriss",
  parentId: "Übergeordnete Region",
  character: "Charakter",
  facts: "Fakten",
};

const SUMMARY = {
  created: "Neu im Paket.",
  removed: "Nicht mehr im Paket.",
  merged: (into: string) => `Zusammengelegt mit ${into}.`,
  excluded: (reason: string | null) =>
    reason !== null && Object.hasOwn(EXCLUDE_REASON_DE, reason)
      ? `Ausgeschlossen: ${EXCLUDE_REASON_DE[reason as ContractExcludeReason]}.`
      : "Ausgeschlossen.",
  updated: (fields: string[]) => {
    const labels = [...new Set(fields.map((f) => f.split(".")[0]!))].map((top) => FIELD_LABELS_DE[top as keyof typeof FIELD_LABELS_DE] ?? top);
    return `Geändert: ${labels.join(", ")}.`;
  },
};

type Contract = { mergedInto?: unknown; exclude?: { excluded?: unknown; reason?: unknown } };

/**
 * The entries of `changes.json`: one per `created`, `updated` and removed object (an unchanged one has none). Event:
 * `created`; `removed`; `merged` when `mergedInto` is newly set; `excluded` when `exclude.excluded` turns true; else
 * `updated` with its `fields`. Severity = the highest of the contract severity and the applied events of the window
 * (`removed`, `merged`, `excluded` at least `notable`); `summary.de` from fixed phrases. Sorted by type and id.
 */
export function buildChanges(input: {
  objects: VersionedObject[];
  removed: RemovedObject[];
  previousBodies: Map<string, object>;
  eventSeverity: Map<string, ObjectEvents>;
  cfg: DeliveryConfig["severity"];
}): ChangeEntry[] {
  const events = (geoObjectId: string | null) => (geoObjectId === null ? undefined : input.eventSeverity.get(geoObjectId));
  const entries: ChangeEntry[] = [];
  for (const o of input.objects) {
    if (o.status === "same") continue;
    const base = { objectType: o.type, objectId: o.id, profileVersion: o.profileVersion };
    if (o.status === "created") {
      entries.push({ ...base, event: "created", fields: [], severity: eventSeverity(o.type, [], events(o.geoObjectId)), summary: { de: SUMMARY.created } });
      continue;
    }
    const before = input.previousBodies.get(o.id);
    if (before === undefined) throw new Error(`no previous body for the updated object ${o.id}`);
    const fields = changedFields(before, o.body);
    const severity = maxSeverity(contractSeverity(fields, before, o.body, input.cfg), eventSeverity(o.type, fields, events(o.geoObjectId)));
    const b = before as Contract;
    const a = o.body as Contract;
    if (typeof a.mergedInto === "string" && a.mergedInto !== b.mergedInto) {
      entries.push({ ...base, event: "merged", fields: [], severity: maxSeverity(severity, "notable"), summary: { de: SUMMARY.merged(a.mergedInto) } });
    } else if (a.exclude?.excluded === true && b.exclude?.excluded !== true) {
      const reason = typeof a.exclude.reason === "string" ? a.exclude.reason : null;
      entries.push({ ...base, event: "excluded", fields: [], severity: maxSeverity(severity, "notable"), summary: { de: SUMMARY.excluded(reason) } });
    } else {
      entries.push({ ...base, event: "updated", fields, severity, summary: { de: SUMMARY.updated(fields) } });
    }
  }
  for (const r of input.removed) {
    entries.push({
      objectType: r.type,
      objectId: r.id,
      event: "removed",
      fields: [],
      severity: maxSeverity("notable", eventSeverity(r.type, [], events(r.geoObjectId))),
      summary: { de: SUMMARY.removed },
      profileVersion: r.profileVersion,
    });
  }
  return sortEntries(entries);
}

function sortEntries(entries: ChangeEntry[]): ChangeEntry[] {
  return entries.sort((a, b) => cmp(a.objectType, b.objectType) || cmp(a.objectId, b.objectId));
}

/**
 * The changes of several packages as one list (`/changes?since=`, lists in ascending `dataVersion`), per object: first
 * `created` and last not `removed` → `created`; `created` … `removed` → no entry; else the last event. `fields` united
 * (only for `updated`), severity the highest, `profileVersion` of the last entry; `summary` of the last entry, of the
 * first for a `created` result (whose last entry may be an update).
 */
export function mergeChanges(lists: ChangeEntry[][]): ChangeEntry[] {
  const byObject = new Map<string, ChangeEntry[]>();
  for (const list of lists) {
    for (const e of list) {
      const key = `${e.objectType}:${e.objectId}`;
      byObject.set(key, [...(byObject.get(key) ?? []), e]);
    }
  }
  const out: ChangeEntry[] = [];
  for (const history of byObject.values()) {
    const first = history[0]!;
    const last = history[history.length - 1]!;
    const severity = maxSeverity(...history.map((e) => e.severity));
    if (first.event === "created") {
      if (last.event === "removed") continue;
      out.push({ ...last, event: "created", fields: [], severity, summary: first.summary });
      continue;
    }
    const fields = last.event === "updated" ? [...new Set(history.flatMap((e) => (e.event === "updated" ? e.fields : [])))].sort(cmp) : [];
    out.push({ ...last, fields, severity });
  }
  return sortEntries(out);
}
