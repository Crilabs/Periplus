import { httpUrl } from "@/contract/v2/common";
import type { SpotBody } from "@/contract/v2";
import type { DeliveryConfig } from "@/lib/config/schemas";
import type { PlaceKind } from "@/lib/db/schema/geo";
import { excludeValue, type ExcludeReason } from "@/lib/domain/consolidation/exclude";
import { registrableDomain } from "@/lib/domain/sources/urls";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { round5 } from "./geo";
import { mapImages } from "./map-image";
import { mapFacts, mapLandingPoints, mapNearby, type DeliveredNearby } from "./map-facts";
import type { SpotSource } from "./types";
import {
  aggregateProvenance,
  combineSource,
  EXCLUDE_REASON_DE,
  HAZARD_DE,
  NO_SHELTER_NOTE_DE,
  HAZARD_KIND,
  HOLDING,
  MOORING_TYPE,
  ORIGIN,
  SEASON_DE,
  SPOT_KIND,
  type ContractHazardKind,
  type ProvenanceInfo,
  type SeasonKind,
} from "./vocab";

/*
 * Berth state → contract spot (spec 08 "Feldzuordnung … eine Tabelle … mit einem Test je Feld", design 7.3). `SPOT_FIELDS`
 * names, per contract field, the core values of the state (fact schema v4 keys) that feed it (also the basis of event
 * severities, ruling M6-P2); `mapSpot` applies the rules. Pure: no database, no quotes, no sources (a fact is its
 * statement and a date).
 */

const SHELTER_ATTRIBUTES = [...SECTORS.map((s) => `shelter.${s}`), "swell_protection"];
const DEPTH_ATTRIBUTES = ["depth.min", "depth.max", "depth.anchoring_min", "depth.anchoring_max"];
const LIMIT_ATTRIBUTES = ["max_draft", "max_length", "capacity"];
const MOORING_ATTRIBUTES = ["mooring.types", "mooring.buoys", "mooring.line_ashore_required"];

/** Contract service → core value key; `shop` and `taverna` come from the things on land (`nearby`), the rest has no key in fact schema v4. */
const SERVICE_ATTRIBUTE = {
  water: "services.water",
  electricity: "services.electricity",
  fuel: "services.fuel",
  showers: "services.showers",
  shop: null,
  taverna: null,
  wifi: "services.wifi",
  dinghyLanding: "services.dinghy_landing",
} as const;
type Service = keyof typeof SERVICE_ATTRIBUTE;
/** Services that close out of season: `yes` becomes `seasonal` when the state has an `open` season note. */
const SEASONAL_SERVICES: Service[] = ["shop", "taverna"];
/** The `nearby` categories (reached on foot) that stand for a shop, and for a taverna (E5). */
const SHOP_CATEGORIES = ["supply", "bakery"];
const TAVERNA_CATEGORIES = ["food"];

type FieldRule = { attributes: string[]; note: string };

export const SPOT_FIELDS: Record<keyof SpotBody, FieldRule> = {
  id: { attributes: [], note: "places.public_id" },
  kind: { attributes: [], note: "SPOT_KIND of the place's kind" },
  berthable: {
    attributes: ["berthable"],
    note: "the berthable value of the state (a fact, else derived from kind and status, spec 17); null when it has none",
  },
  contact: {
    attributes: ["contact"],
    note: "vhf, phone and url of the contact value (the url only of the place\'s own bound website, else null with a warning); null when it is missing or all three are empty",
  },
  name: {
    attributes: [],
    note: "display name (de, en, any); without a valid name the spot is omitted (no_name), an excluded one is delivered with spots.excludedFallbackName (ruling M6-C-R1)",
  },
  names: { attributes: [], note: "valid names without fallbacks, the transliteration as el-Latn; omitted when none" },
  position: { attributes: [], note: "places.position, round5" },
  anchorPosition: {
    attributes: [],
    note: "places.anchor_position with the configured position confidence, source computed; omitted for port and marina (their position is the harbour position); an anchorage or mooring field without one is omitted (incomplete_core)",
  },
  shelter: {
    attributes: SHELTER_ATTRIBUTES,
    note:
      "a sector missing omits the spot (incomplete_core); an excluded spot is delivered with a missing sector (or no state) as 0 and 'ausgeschlossen – keine Schutzwerte' in exclude.detail; swell = swell_protection, else the sectors' minimum; source = combineSource, without any state ORIGIN.rule (computed, ruling M6-B-R3)",
  },
  depth: {
    attributes: DEPTH_ATTRIBUTES,
    note: "omitted without any depth; confidence = minimum, source = combineSource; depth.approach is not delivered (no Teil-B field)",
  },
  seabed: { attributes: ["seabed"], note: "types and shares as in the state" },
  holding: { attributes: ["holding"], note: "HOLDING; missing → unknown" },
  limits: { attributes: LIMIT_ATTRIBUTES, note: "missing → null" },
  mooring: {
    attributes: MOORING_ATTRIBUTES,
    note: "MOORING_TYPE deduplicated and sorted; buoys present false → 0, else count; omitted without any mooring value",
  },
  services: {
    attributes: ["services.water", "services.electricity", "services.fuel", "season_notes"],
    note: "true → yes, false → no, missing → unknown; water, electricity and fuel from the state, shop (supply, bakery) and taverna (food) from the things on land reached on foot (E5); wifi, showers and dinghyLanding have no value in the state (unknown); shop/taverna yes → seasonal with an 'open' season note",
  },
  berth: {
    attributes: ["occupancy"],
    note: "sourcesCount = the same independent-source count; port/marina: full months → seasonFull, only empty/moderate → usuallySpace, else unknown; anchorages unknown",
  },
  occupancy: { attributes: ["occupancy"], note: "known months ascending; omitted without occupancy" },
  exclude: {
    attributes: ["prohibitions"],
    note: "excluded = place status no_anchoring or a year-round text anchoring ban in the state (months null or all 12); reason from the status, else anchoringProhibited (rulings M6-P4, M6-B-R2); detail = EXCLUDE_REASON_DE; the text kinds swimming, fishing, fire, jet_ski and other are not delivered (no Teil-B field)",
  },
  hazards: {
    attributes: ["hazards", "prohibitions"],
    note: "HAZARD_KIND (unknown kind → other) with HAZARD_DE text and proper name; a computed ferry lane adds ferryTraffic (ruling M6-P11), a computed cable area cable; the other computed restrictions (military, protected area, aquaculture, firing area) show in coast.geojson only",
  },
  seasonNote: {
    attributes: ["season_notes", "prohibitions"],
    note: "SEASON_DE per season note; a seasonal anchoring ban adds 'Ankerverbot'",
  },
  score: {
    attributes: [],
    note: "confidence = mean of the confidences of the state's core values (rule values aside), 0 without; popularity ?? 0; quietness null (no value in the state); sourcesCount = the independent sources behind the confirmation (decideBerth), 0 without a state; newest text date; 3 decimals",
  },
  externalRefs: { attributes: [], note: "osm_id, wikidata_id; googlePlaceIds {} until M8" },
  images: {
    attributes: [],
    note: "the current images of the place (rank, sort order, slot) whose render sources are all switched on for delivery (images.delivery); file images/<public id>-<slot>.jpg, camera from the camera columns",
  },
  provenance: { attributes: [], note: "aggregateProvenance per contract field group, from the core values' origin, confidence and date" },
  regionId: { attributes: [], note: "context (assigned region)" },
  mergedInto: { attributes: [], note: "null; merged spots are carried by the build" },
  gaps: { attributes: [], note: "berth_states.gaps, sorted (core value keys without a value)" },
  facts: { attributes: [], note: "mapFacts: the state's facts, statement and date, safety marked; a landside fact assigned to its nearby entry by name (E3)" },
  landingPoints: { attributes: [], note: "mapLandingPoints: the state's landing points (position with kind, or description)" },
  nearby: { attributes: [], note: "mapNearby: the state's things on land with a public hl_ id (E1), nearest first" },
};

/**
 * Not delivered, but reported (the build turns them into validation warnings, Task 3): an excluded spot without a valid
 * name carries `spots.excludedFallbackName` (`fallback_name`); a thing on land without a public id is left out of
 * `nearby` (`nearby_without_id`); a landside fact without a subject name is left out (`fact_without_subject`).
 */
export type SpotWarning =
  | { code: "fallback_name" }
  | { code: "nearby_without_id"; geoObjectId: string }
  | { code: "fact_without_subject"; factId: string }
  | { code: "safety_fact_without_subject"; factId: string }
  | { code: "contact_url_foreign" }
  | { code: "fact_dropped"; factId: string }
  | { code: "safety_fact_dropped"; factId: string }
  | { code: "landing_description_dropped" };

/**
 * An excluded spot is always delivered (Teil B "Ausgeschlossene Spots werden mit `exclude.excluded = true` und Grund
 * geliefert", ruling M6-B-R2 I-2), also without a state; any other spot without a state is omitted (`no_state`), and
 * one whose state lacks a shelter sector, or the anchor position of an anchorage or mooring field, is omitted
 * (`incomplete_core`); the build reports both as warnings. A spot without a valid name is omitted (`no_name`,
 * ruling M6-B-R1): the contract has no spot without a name. An excluded one is delivered with the fallback name
 * `spots.excludedFallbackName` instead, so the app learns it is excluded (ruling M6-C-R1).
 */
export type MappedSpot =
  | { spot: SpotBody; asOf: string | null; warnings: SpotWarning[] }
  | { omitted: "no_name" | "no_state" | "incomplete_core" };

const round3 = (n: number) => Number(n.toFixed(3));
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const HARBOUR_KINDS: PlaceKind[] = ["port", "marina"];

type Prohibition = { kind?: unknown; months?: unknown; restrictedAreaId?: unknown };

/** A text ban without months, or one naming every month, holds all year (ruling M6-B-R2 M-2). */
const allYear = (months: unknown) =>
  months === null || (Array.isArray(months) && Array.from({ length: 12 }, (_, i) => i + 1).every((m) => months.includes(m)));
/** A computed prohibition: a restricted area over the place (fact schema entry). */
const isComputed = (e: Prohibition) => typeof e.restrictedAreaId === "string";

export function mapSpot(src: SpotSource, ctx: { regionId: string | null; cfg: DeliveryConfig }): MappedSpot {
  const state = src.state;
  // the core values as the profile's attributes and provenance were read before: value, and origin/confidence/date
  const a: Record<string, unknown> = Object.fromEntries(Object.entries(state?.core ?? {}).map(([k, v]) => [k, v.value]));
  const p: Record<string, ProvenanceInfo> = Object.fromEntries(Object.entries(state?.core ?? {}).map(([k, v]) => [k, v]));
  const has = (key: string) => a[key] !== undefined && a[key] !== null;
  const provenanceOf = (keys: string[]) => keys.filter(has).map((k) => p[k]).filter((e): e is ProvenanceInfo => e !== undefined);
  const warnings: SpotWarning[] = [];

  const prohibitions = (Array.isArray(a["prohibitions"]) ? a["prohibitions"] : []) as Prohibition[];
  const anchoringBans = prohibitions.filter((e) => e.kind === "anchoring" && !isComputed(e));
  const yearRoundBan = anchoringBans.some((e) => allYear(e.months));
  const seasonalBans = anchoringBans.filter((e) => !allYear(e.months) && Array.isArray(e.months) && e.months.length > 0);
  const ferryLane = prohibitions.some((e) => e.kind === "ferry_lane");
  const cable = prohibitions.some((e) => e.kind === "cable" && isComputed(e));

  // exclude (rulings M6-P4, M6-B-R2 I-1): the place status or a year-round text ban; the reason in that order
  const statusExclude = excludeValue(src.status, src.statusReason);
  const reason: ExcludeReason | null = statusExclude.excluded ? statusExclude.reason : yearRoundBan ? "anchoringProhibited" : null;
  const excluded = reason !== null;
  const banExcludes = excluded && !statusExclude.excluded;

  const nameless = src.name.trim() === "";
  if (nameless && !excluded) return { omitted: "no_name" };
  if (nameless) warnings.push({ code: "fallback_name" });
  if (!state && !excluded) return { omitted: "no_state" };

  const placeKind = src.kind;
  const isHarbour = HARBOUR_KINDS.includes(placeKind);

  // shelter: all eight sectors, or no spot; an excluded spot is delivered anyway, a missing sector as 0 (the worst
  // value) with the note in `exclude.detail`
  const sectorValues = SECTORS.map((s) => num(a[`shelter.${s}`]));
  const missingSector = sectorValues.some((v) => v === null);
  // the anchor position of an anchorage or mooring field (a harbour's position is its position)
  const anchor = isHarbour ? undefined : anchorPosition(src.anchor);
  if (!excluded && (missingSector || (!isHarbour && anchor === undefined))) return { omitted: "incomplete_core" };
  const filled = sectorValues.map((v) => v ?? 0);
  const shelterOrigins = provenanceOf(SHELTER_ATTRIBUTES).map((e) => e.origin);
  const shelter: SpotBody["shelter"] = {
    sectors: Object.fromEntries(SECTORS.map((s, i) => [s, filled[i]!])) as SpotBody["shelter"]["sectors"],
    swell: num(a["swell_protection"]) ?? Math.min(...filled),
    // no sector with a value (a zero-filled excluded spot): the source of the rule that filled it (ruling M6-B-R3)
    source: shelterOrigins.length > 0 ? combineSource(shelterOrigins) : ORIGIN.rule,
  };

  const exclude: SpotBody["exclude"] = {
    excluded,
    reason,
    detail: reason ? (missingSector ? `${EXCLUDE_REASON_DE[reason]} (${NO_SHELTER_NOTE_DE})` : EXCLUDE_REASON_DE[reason]) : null,
  };

  const seasonHints = (Array.isArray(a["season_notes"]) ? a["season_notes"] : []) as Array<{ kind: string; months: number[] }>;
  const depthValue = depth(a, p);

  const nearby = mapNearby(state?.nearby ?? [], src.nearbyObjects);
  const mappedFacts = mapFacts(state?.facts ?? [], nearby.delivered);
  for (const w of nearby.warnings) warnings.push(w);
  for (const w of mappedFacts.warnings) warnings.push(w);

  const spot: SpotBody = {
    id: src.publicId,
    kind: SPOT_KIND[placeKind],
    berthable: typeof a["berthable"] === "boolean" ? (a["berthable"] as boolean) : null,
    contact: contact(a["contact"], src.ownWebsiteDomain, warnings),
    name: nameless ? ctx.cfg.spots.excludedFallbackName : src.name,
    names: src.names.length > 0 ? src.names : undefined,
    position: { lat: round5(src.position.lat), lon: round5(src.position.lon) },
    anchorPosition: anchor,
    shelter,
    depth: depthValue,
    seabed: Array.isArray(a["seabed"]) ? (a["seabed"] as NonNullable<SpotBody["seabed"]>).map(({ type, share }) => ({ type, share })) : undefined,
    holding: HOLDING[a["holding"] as keyof typeof HOLDING] ?? "unknown",
    limits: { maxDraft: num(a["max_draft"]), maxLength: num(a["max_length"]), capacity: num(a["capacity"]) },
    mooring: mooring(a),
    services: services(a, nearby.delivered, seasonHints.some((h) => h.kind === "open")),
    berth: berth(a["occupancy"], isHarbour, state ? src.independentSources : 0),
    occupancy: occupancy(a["occupancy"]),
    exclude,
    hazards: hazards(a["hazards"], { ferryLane, cable }),
    seasonNote: seasonNotes(seasonHints, seasonalBans),
    score: score(state, src.popularity, state ? src.independentSources : 0),
    externalRefs: { googlePlaceIds: {}, osmId: src.osmId, wikidataId: src.wikidataId },
    images: mapImages(src.publicId, src.images),
    provenance: provenance(p, has, {
      anchorPosition: anchor !== undefined,
      depth: depthValue !== undefined,
      banExcludes,
      prohibitionHazard: ferryLane || cable,
      seasonalBan: seasonalBans.length > 0,
      nearby: nearby.delivered,
      anchorConfidence: src.anchor?.confidence ?? 1,
    }),
    regionId: ctx.regionId,
    mergedInto: null,
    gaps: [...(state?.gaps ?? [])].sort(),
    facts: mappedFacts.facts,
    landingPoints: mapLandingPoints(state?.landing ?? []),
    nearby: nearby.delivered.map((n) => n.entry),
  };
  return { spot: withoutUndefined(spot), asOf: state ? state.updatedAt.toISOString().slice(0, 10) : null, warnings };
}

/** The anchor position of the place as the contract's `anchorPosition`: the computed point with its configured confidence. */
function anchorPosition(anchor: SpotSource["anchor"]): SpotBody["anchorPosition"] {
  if (anchor === null) return undefined;
  return { lat: round5(anchor.lat), lon: round5(anchor.lon), confidence: round3(anchor.confidence), source: ORIGIN.computed };
}

/** The `score` block: confidence from the core values, evidence count and newest date from the state. */
function score(state: SpotSource["state"], popularity: number | null, sourcesCount: number): SpotBody["score"] {
  const core = Object.values(state?.core ?? {});
  const rated = core.filter((v) => v.origin !== "rule");
  const dates = [...core.filter((v) => v.origin === "text").map((v) => v.observedAt), ...(state?.facts ?? []).map((f) => f.observedAt)]
    .map((d) => d?.slice(0, 10) ?? null)
    .filter((d): d is string => d !== null);
  return {
    confidence: rated.length === 0 ? 0 : round3(rated.reduce((sum, v) => sum + v.confidence, 0) / rated.length),
    popularity: round3(popularity ?? 0),
    quietness: null,
    sourcesCount,
    lastObserved: dates.length === 0 ? null : dates.reduce((x, y) => (y > x ? y : x)),
  };
}

/**
 * The contact value as the contract's `contact`; null when it is missing or all three parts are empty. The url is
 * delivered only when its registrable domain is the one of the place's own bound website (`place_websites`): a link
 * from any other page is a third-party source and is dropped with a warning (final review F1).
 */
function contact(value: unknown, ownDomain: string | null, warnings: SpotWarning[]): SpotBody["contact"] {
  if (!isRecord(value)) return null;
  const part = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
  // only http(s) links are delivered (a javascript: or ftp: url is dropped)
  const raw = part(value.url);
  let url = raw !== null && httpUrl.safeParse(raw).success ? raw : null;
  if (url !== null && !isOwnUrl(url, ownDomain)) {
    warnings.push({ code: "contact_url_foreign" });
    url = null;
  }
  const out = { vhf: part(value.vhf), phone: part(value.phone), url };
  return out.vhf === null && out.phone === null && out.url === null ? null : out;
}

function isOwnUrl(url: string, ownDomain: string | null): boolean {
  if (ownDomain === null) return false;
  try {
    return registrableDomain(url).toLowerCase() === ownDomain.toLowerCase();
  } catch {
    return false;
  }
}

/** Depths; confidence is the lowest of the present ones, the source their combination. */
function depth(a: Record<string, unknown>, p: Record<string, ProvenanceInfo>): SpotBody["depth"] {
  const present = DEPTH_ATTRIBUTES.filter((k) => num(a[k]) !== null);
  if (present.length === 0) return undefined;
  const [min, max, anchoringMin, anchoringMax] = DEPTH_ATTRIBUTES.map((k) => num(a[k]));
  const proven = present.map((k) => p[k]!);
  return {
    min,
    max,
    anchoring: { min: anchoringMin, max: anchoringMax },
    confidence: round3(Math.min(...proven.map((e) => e.confidence))),
    source: combineSource(proven.map((e) => e.origin)),
  };
}

function mooring(a: Record<string, unknown>): SpotBody["mooring"] {
  if (MOORING_ATTRIBUTES.every((k) => a[k] === undefined || a[k] === null)) return undefined;
  const types = Array.isArray(a["mooring.types"]) ? (a["mooring.types"] as Array<keyof typeof MOORING_TYPE>) : [];
  const buoys = a["mooring.buoys"];
  return {
    types: [...new Set(types.map((t) => MOORING_TYPE[t]).filter((t) => t !== undefined))].sort(),
    buoys: isRecord(buoys) ? (buoys.present === false ? 0 : num(buoys.count)) : null,
    lineAshoreRequired: typeof a["mooring.line_ashore_required"] === "boolean" ? (a["mooring.line_ashore_required"] as boolean) : null,
  };
}

/** Whether a thing of one of `categories` is reached on foot (E5). */
const reachedOnFoot = (nearby: DeliveredNearby[], categories: string[]) =>
  nearby.some((n) => n.entry.access === "foot" && categories.includes(n.entry.category));

function services(a: Record<string, unknown>, nearby: DeliveredNearby[], openSeason: boolean): SpotBody["services"] {
  const state = (service: Service): "yes" | "no" | "seasonal" | "unknown" => {
    const key = SERVICE_ATTRIBUTE[service];
    const raw = key === null ? undefined : a[key];
    const own = isRecord(raw) ? raw.present : raw;
    const value =
      service === "shop" ? (reachedOnFoot(nearby, SHOP_CATEGORIES) ? true : undefined) : service === "taverna" ? (reachedOnFoot(nearby, TAVERNA_CATEGORIES) ? true : undefined) : own;
    if (value === true) return openSeason && SEASONAL_SERVICES.includes(service) ? "seasonal" : "yes";
    return value === false ? "no" : "unknown";
  };
  return Object.fromEntries((Object.keys(SERVICE_ATTRIBUTE) as Service[]).map((s) => [s, state(s)])) as NonNullable<SpotBody["services"]>;
}

const knownOccupancy = (value: unknown): Array<{ month: number; level: "empty" | "moderate" | "full" }> =>
  isRecord(value)
    ? Object.entries(value)
        .map(([m, level]) => ({ month: Number(m), level: level as "empty" | "moderate" | "full" }))
        .filter((e) => Number.isInteger(e.month) && e.month >= 1 && e.month <= 12 && ["empty", "moderate", "full"].includes(e.level))
        .sort((x, y) => x.month - y.month)
    : [];

function berth(value: unknown, isHarbour: boolean, sourcesCount: number): SpotBody["berth"] {
  if (!isHarbour) return { status: "unknown", months: [], sourcesCount: 0, bookable: null };
  const months = knownOccupancy(value);
  const full = months.filter((e) => e.level === "full").map((e) => e.month);
  const status = full.length > 0 ? "seasonFull" : months.length > 0 ? "usuallySpace" : "unknown";
  return { status, months: full, sourcesCount: months.length > 0 ? sourcesCount : 0, bookable: null };
}

function occupancy(value: unknown): SpotBody["occupancy"] {
  const months = knownOccupancy(value);
  return months.length > 0 ? months : undefined;
}

/**
 * Hazards: an unknown internal kind is `other`, never dropped (ruling M6-B-R2 M-3); a computed ferry lane adds
 * `ferryTraffic` (ruling M6-P11), a computed cable area `cable` (ruling M6-B-R2 M-1).
 */
function hazards(value: unknown, computed: { ferryLane: boolean; cable: boolean }): SpotBody["hazards"] {
  const list: Array<{ kind: ContractHazardKind; text: string }> = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (!isRecord(entry)) continue;
    const kind = Object.hasOwn(HAZARD_KIND, String(entry.kind)) ? HAZARD_KIND[entry.kind as keyof typeof HAZARD_KIND] : "other";
    const name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : null;
    list.push({ kind, text: name ? `${HAZARD_DE[kind]}: ${name}` : HAZARD_DE[kind] });
  }
  if (computed.ferryLane) list.push({ kind: "ferryTraffic", text: HAZARD_DE.ferryTraffic });
  if (computed.cable) list.push({ kind: "cable", text: HAZARD_DE.cable });
  const unique = [...new Map(list.map((h) => [`${h.kind}\u0000${h.text}`, h])).values()];
  unique.sort((x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.text < y.text ? -1 : x.text > y.text ? 1 : 0));
  return unique.length > 0 ? unique : undefined;
}

function seasonNotes(hints: Array<{ kind: string; months: number[] }>, seasonalBans: Prohibition[]): SpotBody["seasonNote"] {
  const notes = hints
    .filter((h) => Array.isArray(h.months) && h.months.length > 0)
    .map((h) => ({ months: [...h.months].sort((x, y) => x - y), text: SEASON_DE[h.kind as SeasonKind] ?? SEASON_DE.other }));
  for (const ban of seasonalBans) {
    notes.push({ months: [...(ban.months as number[])].sort((x, y) => x - y), text: EXCLUDE_REASON_DE.anchoringProhibited });
  }
  return notes.length > 0 ? notes : undefined;
}

/** Flat contract provenance per field group (`shelter`, `services.taverna` …), each `aggregateProvenance`. */
function provenance(
  p: Record<string, ProvenanceInfo>,
  has: (key: string) => boolean,
  o: { anchorPosition: boolean; depth: boolean; banExcludes: boolean; prohibitionHazard: boolean; seasonalBan: boolean; nearby: DeliveredNearby[]; anchorConfidence: number },
): SpotBody["provenance"] {
  const groups: Record<string, string[]> = {
    shelter: SHELTER_ATTRIBUTES,
    depth: o.depth ? DEPTH_ATTRIBUTES : [],
    seabed: ["seabed"],
    holding: ["holding"],
    limits: LIMIT_ATTRIBUTES,
    mooring: MOORING_ATTRIBUTES,
    ...Object.fromEntries(
      (Object.keys(SERVICE_ATTRIBUTE) as Service[]).flatMap((s) => (SERVICE_ATTRIBUTE[s] === null ? [] : [[`services.${s}`, [SERVICE_ATTRIBUTE[s]]]])),
    ),
    berthable: ["berthable"],
    contact: ["contact"],
    occupancy: ["occupancy"],
    exclude: o.banExcludes ? ["prohibitions"] : [],
    hazards: o.prohibitionHazard ? ["hazards", "prohibitions"] : ["hazards"],
    seasonNote: o.seasonalBan ? ["season_notes", "prohibitions"] : ["season_notes"],
  };
  const out: SpotBody["provenance"] = {};
  for (const [key, attributes] of Object.entries(groups)) {
    const entries = attributes.filter(has).map((k) => p[k]).filter((e): e is ProvenanceInfo => e !== undefined);
    if (entries.length > 0) out[key] = aggregateProvenance(entries);
  }
  // the places's anchor position and the services drawn from the things on land are computed values
  const computed: ProvenanceInfo = { origin: "computed", confidence: 1, observedAt: null };
  if (o.anchorPosition) out["anchorPosition"] = aggregateProvenance([{ ...computed, confidence: o.anchorConfidence }]);
  if (reachedOnFoot(o.nearby, SHOP_CATEGORIES)) out["services.shop"] = aggregateProvenance([computed]);
  if (reachedOnFoot(o.nearby, TAVERNA_CATEGORIES)) out["services.taverna"] = aggregateProvenance([computed]);
  return out;
}

/** Drops keys whose value is undefined, so the serialized object has only the fields it delivers. */
function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
