import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Point } from "geojson";
import type { QualityConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import {
  comparisonSet,
  evaluationProfiles,
  geoNames,
  places,
  COMPARISON_ATTRIBUTES,
  type ComparisonAttribute,
  type PlaceKind,
  type PlaceStatus,
  type SeabedType,
} from "@/lib/db/schema";
import { asGeoJson } from "@/lib/db/geometry";
import { SEABED_TYPE_LABELS } from "@/lib/domain/facts/labels";
import { canonicalJson } from "@/lib/domain/facts/schema";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import type { LonLat } from "@/lib/domain/geometry/water";
import type { BerthStateNearby, BerthStateValue } from "@/lib/db/schema/research-state";
import { latestProfiles } from "@/lib/domain/timeline";
import { validAt } from "@/lib/db/valid-at";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";

export { COMPARISON_ATTRIBUTES, type ComparisonAttribute };

/*
 * The own values of a place as compared against Navily (spec 10). Only Periplus values live here: the normalised
 * value is what an outcome in `comparison_results` stays valid for (its `hash`), so float noise, seabed order or a
 * shift of a few metres keep an earlier outcome; a change of class (protected → open, another depth step) asks for a
 * new check.
 */

/** A place of the comparison set with the profile attributes it is compared on. */
export type ComparisonSubject = {
  placeId: string;
  publicId: string | null;
  name: string | null;
  /** All valid names of the place's geo object (all languages). */
  names: string[];
  kind: PlaceKind;
  status: PlaceStatus;
  /** Profile attribute `place.position` (else `places.position`). */
  position: LonLat;
  /** Profile attribute `anchor_position` (consolidated, incl. the admin's anchor); null without one. Ignored for ports and marinas. */
  anchorPosition: LonLat | null;
  attributes: Record<string, unknown>;
  /** The profile version compared; null for an evaluation profile or without a profile. */
  profileVersion: number | null;
};

/** `value` is the normalised value (null = no own value), `display` the own value for people, `hash` its fingerprint. */
export type ComparisonValue = { value: unknown; display: string; hash: string };

type NavilyConfig = QualityConfig["navily"];

const NONE = "–";
/** Kinds compared (and delivered) on the place point, never on an anchor position (ruling M7-P17). */
const HARBOUR_KINDS: ReadonlySet<PlaceKind> = new Set(["port", "marina"]);
const POSITION_DIGITS = 4;

/** First 16 hex characters of the SHA-256 of the canonical JSON of attribute and value (recipe of `valueFingerprint`). */
function valueHash(attribute: ComparisonAttribute, value: unknown): string {
  return createHash("sha256").update(canonicalJson({ attribute, value })).digest("hex").slice(0, 16);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const round = (v: number, digits: number) => {
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  return r === 0 ? 0 : r; // no -0 in the canonical JSON
};
const decimal = (v: number, digits = 2) => v.toLocaleString("de-DE", { maximumFractionDigits: digits });
const fixed = (v: number, digits: number) =>
  v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const yesNo = (present: boolean, detail: string[] = []) =>
  present ? (detail.length > 0 ? `ja (${detail.join(", ")})` : "ja") : "nein";

/** A `{ lon, lat }` profile value (`place.position`, `anchor_position`); null for anything else. */
export function lonLatOf(v: unknown): LonLat | null {
  if (!isRecord(v)) return null;
  const lon = num(v.lon);
  const lat = num(v.lat);
  return lon === null || lat === null ? null : { lon, lat };
}

function seabedShares(v: unknown): Array<{ type: SeabedType; share: number }> | null {
  if (!Array.isArray(v)) return null;
  const shares = v.filter(
    (e): e is { type: SeabedType; share: number } =>
      isRecord(e) && typeof e.type === "string" && Object.hasOwn(SEABED_TYPE_LABELS, e.type) && num(e.share) !== null,
  );
  return shares.length === v.length ? shares : null;
}

/** `{ present }` of a buoy or highlight attribute; the details (count, names) are shown, not compared. */
function presence(v: unknown): { present: boolean; detail: string[] } | null {
  if (!isRecord(v) || bool(v.present) === null) return null;
  const detail: string[] = [];
  if (num(v.count) !== null) detail.push(String(v.count));
  if (v.paid === true) detail.push("kostenpflichtig");
  if (Array.isArray(v.names)) detail.push(...v.names.filter((n): n is string => typeof n === "string"));
  return { present: v.present as boolean, detail };
}

/**
 * The position a place is compared on: the point the contract delivers (`mapSpot`), i.e. the anchor position, else the
 * place point; a harbour has no anchor position, only its place point.
 */
export function comparedPosition(s: Pick<ComparisonSubject, "kind" | "position" | "anchorPosition">): LonLat {
  return (HARBOUR_KINDS.has(s.kind) ? null : s.anchorPosition) ?? s.position;
}

/** The normalised value and its display of one attribute; `[null, "–"]` without an own value. */
function normalise(attribute: ComparisonAttribute, s: ComparisonSubject, cfg: NavilyConfig): [unknown, string] {
  const a = s.attributes;
  switch (attribute) {
    case "existence":
      return [s.status === "confirmed", s.status === "confirmed" ? "bestätigter Ort" : "kein bestätigter Ort"];
    case "position": {
      const p = comparedPosition(s);
      return [
        { lon: round(p.lon, POSITION_DIGITS), lat: round(p.lat, POSITION_DIGITS) },
        `${fixed(p.lat, 5)}° N, ${fixed(p.lon, 5)}° O`,
      ];
    }
    case "depth": {
      const d = num(a["depth.anchoring_min"]) ?? num(a["depth.min"]);
      if (d === null) return [null, NONE];
      return [round(Math.round(d / cfg.depthStepM) * cfg.depthStepM, 6), `${decimal(d, 1)} m`];
    }
    case "seabed": {
      const shares = seabedShares(a["seabed"]);
      if (shares === null) return [null, NONE];
      const types = shares.filter((x) => x.share >= cfg.seabedShareMin).map((x) => x.type);
      const display = [...shares]
        .sort((x, y) => y.share - x.share || x.type.localeCompare(y.type))
        .map((x) => `${SEABED_TYPE_LABELS[x.type]} ${Math.round(x.share * 100)} %`)
        .join(", ");
      return [[...new Set(types)].sort(), display || NONE];
    }
    case "services.water": {
      const water = bool(a["services.water"]);
      return water === null ? [null, NONE] : [water, yesNo(water)];
    }
    case "mooring.buoys":
    case "highlight.supply":
    case "highlight.food": {
      const p = presence(a[attribute]);
      return p === null ? [null, NONE] : [p.present, yesNo(p.present, p.detail)];
    }
    default: {
      // shelter.<sector>
      const v = num(a[attribute]);
      if (v === null) return [null, NONE];
      const isProtected = v >= cfg.protectedThreshold;
      return [{ protected: isProtected }, `${decimal(v)} (${isProtected ? "geschützt" : "offen"})`];
    }
  }
}

/** The core attributes a berth state carries into the comparison (position, existence, depth and food stay out: see the gate). */
const STATE_CORE_KEYS: readonly string[] = COMPARISON_ATTRIBUTES.filter((a) => a.startsWith("shelter.") || ["seabed", "mooring.buoys", "services.water"].includes(a));

/**
 * The attributes map `comparisonValues` reads, from a berth state (pure): the core values under their fact keys, and
 * `highlight.supply` from `nearby` (a `supply` or `bakery` reachable on foot, as the contract's `services.shop`). A
 * key without a core value is absent (no own value).
 */
export function attributesFromState(core: Record<string, BerthStateValue>, nearby: BerthStateNearby[]): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const key of STATE_CORE_KEYS) if (core[key] !== undefined) attributes[key] = core[key]!.value;
  attributes["highlight.supply"] = { present: nearby.some((n) => n.access === "foot" && (n.category === "supply" || n.category === "bakery")) };
  return attributes;
}

/** The compared values of a place, one per attribute of `COMPARISON_ATTRIBUTES` (pure). */
export function comparisonValues(s: ComparisonSubject, cfg: NavilyConfig): Record<ComparisonAttribute, ComparisonValue> {
  return Object.fromEntries(
    COMPARISON_ATTRIBUTES.map((attribute) => {
      const [value, display] = normalise(attribute, s, cfg);
      return [attribute, { value, display, hash: valueHash(attribute, value) }];
    }),
  ) as Record<ComparisonAttribute, ComparisonValue>;
}

/**
 * The places of the subdivision's comparison set (any status: existence compares it), sorted by name. Attributes from the
 * newest profile, or with `evaluationRunId` from that run's `evaluation_profiles` (then `profileVersion` null);
 * without a profile the attributes are empty. An unknown subdivision has no set: empty list.
 */
export async function loadComparisonSubjects(
  db: Db,
  subdivisionKey: string,
  opts: { evaluationRunId?: string } = {},
): Promise<ComparisonSubject[]> {
  const sub = await subdivisionByKey(db, subdivisionKey);
  if (!sub) return [];
  const rows = await db
    .select({
      placeId: places.id,
      publicId: places.publicId,
      geoObjectId: places.geoObjectId,
      name: displayNameSql(places.geoObjectId),
      kind: places.kind,
      status: places.status,
      position: asGeoJson(places.position),
    })
    .from(comparisonSet)
    .innerJoin(places, eq(places.id, comparisonSet.placeId))
    .where(eq(comparisonSet.subdivisionId, sub.id));
  if (rows.length === 0) return [];
  const objectIds = rows.map((r) => r.geoObjectId);

  const nameRows = await db
    .selectDistinct({ geoObjectId: geoNames.geoObjectId, name: geoNames.name })
    .from(geoNames)
    .where(and(inArray(geoNames.geoObjectId, objectIds), validAt(geoNames)))
    .orderBy(asc(geoNames.geoObjectId), asc(geoNames.name));
  const namesOf = new Map<string, string[]>();
  for (const n of nameRows) namesOf.set(n.geoObjectId, [...(namesOf.get(n.geoObjectId) ?? []), n.name]);

  const profileOf = new Map<string, { attributes: Record<string, unknown>; version: number | null }>();
  if (opts.evaluationRunId) {
    const evaluated = await db
      .select({ geoObjectId: evaluationProfiles.geoObjectId, attributes: evaluationProfiles.attributes })
      .from(evaluationProfiles)
      .where(and(eq(evaluationProfiles.runId, opts.evaluationRunId), inArray(evaluationProfiles.geoObjectId, objectIds)));
    for (const e of evaluated) profileOf.set(e.geoObjectId, { attributes: e.attributes, version: null });
  } else {
    for (const [id, p] of await latestProfiles(db, objectIds)) profileOf.set(id, { attributes: p.attributes, version: p.version });
  }

  const subjects = rows.map((r): ComparisonSubject => {
    const profile = profileOf.get(r.geoObjectId);
    const attributes = profile?.attributes ?? {};
    const [lon, lat] = (r.position as Point).coordinates as [number, number];
    return {
      placeId: r.placeId,
      publicId: r.publicId,
      name: r.name,
      names: namesOf.get(r.geoObjectId) ?? [],
      kind: r.kind,
      status: r.status,
      position: lonLatOf(attributes["place.position"]) ?? { lon, lat },
      anchorPosition: lonLatOf(attributes["anchor_position"]),
      attributes,
      profileVersion: profile?.version ?? null,
    };
  });
  return subjects.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.placeId.localeCompare(b.placeId));
}
