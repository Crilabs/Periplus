import type { SpotBody } from "@/contract";
import type { DeliveryConfig } from "@/lib/config/schemas";
import type { PlaceKind } from "@/lib/db/schema/geo";
import { excludeValue, type ExcludeValue } from "@/lib/domain/consolidation/exclude";
import type { AttributeProvenance, ProvenanceOrigin } from "@/lib/domain/consolidation/types";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { isForbiddenUrl } from "@/lib/domain/sources/forbidden-domains";
import { round5 } from "./geo";
import type { SourceRefRow, SpotSource } from "./types";
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
  SOURCE_KIND,
  SPOT_KIND,
  type ContractHazardKind,
  type SeasonKind,
} from "./vocab";

/*
 * Profile → contract spot (spec 08 "Feldzuordnung Profil → Spot: eine Tabelle … mit einem Test je Feld"). `SPOT_FIELDS`
 * names, per contract field, the profile attributes that feed it (also the basis of event severities, ruling M6-P2);
 * `mapSpot` applies the rules. Pure: no database, no quotes (sources are URLs, texts are vocabulary or summaries).
 */

const SHELTER_ATTRIBUTES = [...SECTORS.map((s) => `shelter.${s}`), "swell_protection"];
const DEPTH_ATTRIBUTES = ["depth.min", "depth.max", "depth.anchoring_min", "depth.anchoring_max"];
const LIMIT_ATTRIBUTES = ["max_draft", "max_length", "capacity"];
const MOORING_ATTRIBUTES = ["mooring.types", "mooring.buoys", "mooring.line_ashore_required"];

/** Contract service → profile attribute; `shop` and `taverna` come from the highlights nearby. */
const SERVICE_ATTRIBUTE = {
  water: "services.water",
  electricity: "services.electricity",
  fuel: "services.fuel",
  showers: "services.showers",
  shop: "highlight.supply",
  taverna: "highlight.food",
  wifi: "services.wifi",
  dinghyLanding: "services.dinghy_landing",
} as const;
type Service = keyof typeof SERVICE_ATTRIBUTE;
/** Services that close out of season: `yes` becomes `seasonal` when the place has an `open` season hint. */
const SEASONAL_SERVICES: Service[] = ["shop", "taverna"];

type FieldRule = { attributes: string[]; note: string };

export const SPOT_FIELDS: Record<keyof SpotBody, FieldRule> = {
  id: { attributes: [], note: "places.public_id" },
  kind: { attributes: ["place.kind"], note: "SPOT_KIND; without the identity key the place's kind" },
  name: {
    attributes: ["geo.name"],
    note: "display name (de, en, any); without a valid name the spot is omitted (no_name), an excluded one is delivered with spots.excludedFallbackName (ruling M6-C-R1)",
  },
  names: { attributes: ["geo.name"], note: "valid names without transliterations and fallbacks; omitted when none" },
  position: { attributes: ["place.position"], note: "places.position, round5" },
  anchorPosition: {
    attributes: ["anchor_position"],
    note: "omitted for port and marina; confidence and source (ORIGIN) from its provenance; without provenance omitted (warning missing_provenance)",
  },
  shelter: {
    attributes: SHELTER_ATTRIBUTES,
    note:
      "a sector missing or without provenance omits the spot (shelter_incomplete); an excluded spot is delivered with a missing sector (or no profile) as 0 and 'ausgeschlossen – keine Schutzwerte' in exclude.detail; swell = swell_protection, else the sectors' minimum; source = combineSource, without any provenance ORIGIN.rule (computed, ruling M6-B-R3)",
  },
  depth: {
    attributes: DEPTH_ATTRIBUTES,
    note: "omitted without any depth, or when a depth has no provenance (warning missing_provenance); confidence = minimum, source = combineSource; depth.approach is not delivered (no Teil-B field)",
  },
  seabed: { attributes: ["seabed"], note: "types and shares as in the profile" },
  holding: { attributes: ["holding"], note: "HOLDING; missing → unknown" },
  limits: { attributes: LIMIT_ATTRIBUTES, note: "missing → null" },
  mooring: {
    attributes: MOORING_ATTRIBUTES,
    note: "MOORING_TYPE deduplicated and sorted; buoys present false → 0, else count; omitted without any mooring value",
  },
  services: {
    attributes: [...Object.values(SERVICE_ATTRIBUTE), "derived.season"],
    note: "true → yes, false → no, missing → unknown; shop/taverna yes → seasonal with an 'open' season hint",
  },
  berth: {
    attributes: ["occupancy"],
    note: "port/marina: full months → seasonFull, only empty/moderate → usuallySpace, else unknown; anchorages unknown",
  },
  occupancy: { attributes: ["occupancy"], note: "known months ascending; omitted without occupancy" },
  exclude: {
    attributes: ["exclude", "prohibitions"],
    note: "excluded = profile exclude, place status no_anchoring or a year-round text anchoring ban (months null or all 12); reason from the profile, else the status, else anchoringProhibited (rulings M6-P4, M6-B-R2); detail = EXCLUDE_REASON_DE; the text kinds swimming, fishing, fire, jet_ski and other are not delivered (no Teil-B field)",
  },
  hazards: {
    attributes: ["hazards", "prohibitions"],
    note: "HAZARD_KIND (unknown kind → other) with HAZARD_DE text and proper name; a computed ferry lane adds ferryTraffic (ruling M6-P11), a computed cable area cable; the other computed restrictions (military, protected area, aquaculture, firing area) show in coast.geojson only",
  },
  seasonNote: {
    attributes: ["derived.season", "prohibitions"],
    note: "SEASON_DE per season hint; a seasonal anchoring ban adds 'Ankerverbot'",
  },
  score: {
    attributes: ["derived.quietness"],
    note: "profile confidence ?? 0, popularity ?? 0, quietness, profile sources count, newest text/observed date; 3 decimals",
  },
  highlightIds: { attributes: [], note: "context (highlights counting the spot)" },
  externalRefs: { attributes: [], note: "osm_id, wikidata_id; googlePlaceIds {} until M8" },
  summary: {
    attributes: [],
    note: "the ok summary; below validation.lowConfidence the note is appended, without summary 'Wenig belegt.'",
  },
  sources: {
    attributes: [],
    note: "http(s) documents outside forbiddenDomains (those are reported to the validation, which blocks), newest first, at most spots.maxSources; kind = SOURCE_KIND",
  },
  provenance: { attributes: [], note: "aggregateProvenance per contract field group" },
  regionId: { attributes: [], note: "context (assigned region)" },
  mergedInto: { attributes: [], note: "null; merged spots are carried by the build" },
};

/**
 * A profile value delivered without its provenance (ruling M6-B-R2 M-6): `anchorPosition` and `depth`, whose contract
 * values name their own source and confidence, are dropped; `shelter` (only on an excluded spot, any other is omitted)
 * keeps its values. An excluded spot without a valid name carries `spots.excludedFallbackName` (`fallback_name`). The
 * build reports them as validation warnings (Task 9).
 */
export type SpotWarning =
  | { code: "missing_provenance"; field: "anchorPosition" | "depth" | "shelter" }
  | { code: "fallback_name" };

/**
 * An excluded spot is always delivered (Teil B "Ausgeschlossene Spots werden mit `exclude.excluded = true` und Grund
 * geliefert", ruling M6-B-R2 I-2); any other spot without a profile or without all eight sectors (each with its
 * provenance) is omitted, which the build reports as a warning (`no_profile`, `shelter_incomplete`, ruling M6-P31).
 * A spot without a valid name is omitted (`no_name`, ruling M6-B-R1): the contract has no spot without a name. An
 * excluded one is delivered with the fallback name `spots.excludedFallbackName` instead, so the app learns it is
 * excluded (ruling M6-C-R1).
 */
export type MappedSpot =
  | { spot: SpotBody; warnings: SpotWarning[]; forbiddenSources: string[] }
  | { omitted: "no_name" | "no_profile" | "shelter_incomplete" };

const round3 = (n: number) => Number(n.toFixed(3));
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const HARBOUR_KINDS: PlaceKind[] = ["port", "marina"];

type Prohibition = { kind?: unknown; months?: unknown; restrictedAreaId?: unknown };

/** A text ban without months, or one naming every month, holds all year (ruling M6-B-R2 M-2). */
const allYear = (months: unknown) =>
  months === null || (Array.isArray(months) && Array.from({ length: 12 }, (_, i) => i + 1).every((m) => months.includes(m)));
/** A computed prohibition: a restricted area over the place (fact schema v1 entry). */
const isComputed = (e: Prohibition) => typeof e.restrictedAreaId === "string";

export function mapSpot(
  src: SpotSource,
  ctx: { regionId: string | null; highlightIds: string[]; cfg: DeliveryConfig },
): MappedSpot {
  const profile = src.profile;
  const a: Record<string, unknown> = profile?.attributes ?? {};
  const p: Record<string, AttributeProvenance> = profile?.provenance ?? {};
  const has = (key: string) => a[key] !== undefined && a[key] !== null;
  const provenanceOf = (keys: string[]) => keys.filter(has).map((k) => p[k]).filter((e): e is AttributeProvenance => e !== undefined);
  const originsOf = (keys: string[]): ProvenanceOrigin[] => provenanceOf(keys).map((e) => e.origin);
  const warnings: SpotWarning[] = [];

  const prohibitions = (Array.isArray(a["prohibitions"]) ? a["prohibitions"] : []) as Prohibition[];
  const anchoringBans = prohibitions.filter((e) => e.kind === "anchoring" && !isComputed(e));
  const yearRoundBan = anchoringBans.some((e) => allYear(e.months));
  const seasonalBans = anchoringBans.filter((e) => !allYear(e.months) && Array.isArray(e.months) && e.months.length > 0);
  const ferryLane = prohibitions.some((e) => e.kind === "ferry_lane");
  const cable = prohibitions.some((e) => e.kind === "cable" && isComputed(e));

  // exclude (rulings M6-P4, M6-B-R2 I-1): the profile's exclude, the place status (a no_anchoring decision may be
  // newer than the last consolidation) or a year-round text ban; the reason in that order.
  const profileExclude = isRecord(a["exclude"]) ? (a["exclude"] as ExcludeValue) : null;
  const statusExclude = excludeValue(src.status, src.statusReason);
  const reason = profileExclude?.excluded
    ? (profileExclude.reason ?? "anchoringProhibited")
    : statusExclude.excluded
      ? statusExclude.reason
      : yearRoundBan
        ? "anchoringProhibited"
        : null;
  const excluded = reason !== null;
  const banExcludes = excluded && !profileExclude?.excluded && !statusExclude.excluded;

  const nameless = src.name.trim() === "";
  if (nameless && !excluded) return { omitted: "no_name" };
  if (nameless) warnings.push({ code: "fallback_name" });
  if (!profile && !excluded) return { omitted: "no_profile" };

  // shelter: all eight sectors, each with its provenance, or no spot; an excluded spot is delivered anyway, a missing
  // sector as 0 (the worst value) with the note in `exclude.detail`
  const sectorValues = SECTORS.map((s) => num(a[`shelter.${s}`]));
  const unproven = SECTORS.some((s, i) => sectorValues[i] !== null && !p[`shelter.${s}`]);
  const missingSector = sectorValues.some((v) => v === null);
  if ((missingSector || unproven) && !excluded) return { omitted: "shelter_incomplete" };
  if (unproven) warnings.push({ code: "missing_provenance", field: "shelter" });
  const filled = sectorValues.map((v) => v ?? 0);
  const shelterOrigins = originsOf(SHELTER_ATTRIBUTES);
  const shelter: SpotBody["shelter"] = {
    sectors: Object.fromEntries(SECTORS.map((s, i) => [s, filled[i]!])) as SpotBody["shelter"]["sectors"],
    swell: num(a["swell_protection"]) ?? Math.min(...filled),
    // no sector with provenance (a zero-filled excluded spot): the source of the rule that filled it (ruling M6-B-R3)
    source: shelterOrigins.length > 0 ? combineSource(shelterOrigins) : ORIGIN.rule,
  };

  const exclude: SpotBody["exclude"] = {
    excluded,
    reason,
    detail: reason ? (missingSector ? `${EXCLUDE_REASON_DE[reason]} (${NO_SHELTER_NOTE_DE})` : EXCLUDE_REASON_DE[reason]) : null,
  };

  const placeKind = (typeof a["place.kind"] === "string" ? a["place.kind"] : src.kind) as PlaceKind;
  const isHarbour = HARBOUR_KINDS.includes(placeKind);
  const seasonHints = (Array.isArray(a["derived.season"]) ? a["derived.season"] : []) as Array<{ kind: string; months: number[] }>;
  const anchor = isHarbour ? undefined : anchorPosition(a["anchor_position"], p["anchor_position"], warnings);
  const depthValue = depth(a, p, warnings);

  const sources = mapSources(src.sources, ctx.cfg);
  const spot: SpotBody = {
    id: src.publicId,
    kind: SPOT_KIND[placeKind],
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
    services: services(a, seasonHints.some((h) => h.kind === "open")),
    berth: berth(a["occupancy"], isHarbour, p["occupancy"]),
    occupancy: occupancy(a["occupancy"]),
    exclude,
    hazards: hazards(a["hazards"], { ferryLane, cable }),
    seasonNote: seasonNotes(seasonHints, seasonalBans),
    score: {
      confidence: round3(profile?.confidence ?? 0),
      popularity: round3(src.popularity ?? 0),
      quietness: num(a["derived.quietness"]) === null ? null : round3(num(a["derived.quietness"])!),
      sourcesCount: profile?.sourcesCount ?? 0,
      lastObserved: lastObserved(Object.values(p)),
    },
    highlightIds: ctx.highlightIds,
    externalRefs: { googlePlaceIds: {}, osmId: src.osmId, wikidataId: src.wikidataId },
    summary: mapSummary(src.summary, profile?.confidence ?? null, ctx.cfg),
    sources: sources.sources,
    provenance: provenance(p, has, {
      anchorPosition: anchor !== undefined,
      depth: depthValue !== undefined,
      banExcludes,
      prohibitionHazard: ferryLane || cable,
      seasonalBan: seasonalBans.length > 0,
    }),
    regionId: ctx.regionId,
    mergedInto: null,
  };
  return { spot: withoutUndefined(spot), warnings, forbiddenSources: sources.forbidden };
}

function anchorPosition(
  value: unknown,
  prov: AttributeProvenance | undefined,
  warnings: SpotWarning[],
): SpotBody["anchorPosition"] {
  if (!isRecord(value) || num(value.lon) === null || num(value.lat) === null) return undefined;
  if (!prov) {
    warnings.push({ code: "missing_provenance", field: "anchorPosition" });
    return undefined;
  }
  return {
    lat: round5(value.lat as number),
    lon: round5(value.lon as number),
    confidence: round3(prov.confidence),
    source: ORIGIN[prov.origin],
  };
}

/** Depths; a present depth without provenance drops the field with a warning (ruling M6-B-R2 M-6). */
function depth(a: Record<string, unknown>, p: Record<string, AttributeProvenance>, warnings: SpotWarning[]): SpotBody["depth"] {
  const present = DEPTH_ATTRIBUTES.filter((k) => num(a[k]) !== null);
  if (present.length === 0) return undefined;
  const entries = present.map((k) => p[k]);
  if (entries.some((e) => e === undefined)) {
    warnings.push({ code: "missing_provenance", field: "depth" });
    return undefined;
  }
  const [min, max, anchoringMin, anchoringMax] = DEPTH_ATTRIBUTES.map((k) => num(a[k]));
  const proven = entries as AttributeProvenance[];
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

function services(a: Record<string, unknown>, openSeason: boolean): SpotBody["services"] {
  const state = (service: Service): "yes" | "no" | "seasonal" | "unknown" => {
    const raw = a[SERVICE_ATTRIBUTE[service]];
    const value = isRecord(raw) ? raw.present : raw;
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

function berth(value: unknown, isHarbour: boolean, prov: AttributeProvenance | undefined): SpotBody["berth"] {
  if (!isHarbour) return { status: "unknown", months: [], sourcesCount: 0, bookable: null };
  const months = knownOccupancy(value);
  const full = months.filter((e) => e.level === "full").map((e) => e.month);
  const status = full.length > 0 ? "seasonFull" : months.length > 0 ? "usuallySpace" : "unknown";
  return { status, months: full, sourcesCount: months.length > 0 ? (prov?.sourceKeys.length ?? 0) : 0, bookable: null };
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

/** The newest observation date of a text or observed value (Teil B `score.lastObserved`; spot and highlight). */
export function lastObserved(entries: AttributeProvenance[]): string | null {
  const dates = entries
    .filter((e) => e.origin === "text" || e.origin === "observed")
    .map((e) => e.observedAt?.slice(0, 10) ?? null)
    .filter((d): d is string => d !== null);
  return dates.length === 0 ? null : dates.reduce((x, y) => (y > x ? y : x));
}

/**
 * Teil B "score.confidence unter 0,3 … summary.de mit dem Hinweis 'wenig belegt'": below `validation.lowConfidence`
 * (a profile without confidence counts as low, ruling M6-P9) the note is appended unless the text has it; without a
 * summary a low-confidence spot gets the note as its summary, any other spot none. Highlights use the same rule.
 */
export function mapSummary(text: string | null, confidence: number | null, cfg: DeliveryConfig): SpotBody["summary"] {
  const note = cfg.validation.lowConfidenceNote;
  const low = round3(confidence ?? 0) < cfg.validation.lowConfidence;
  if (text === null || text.trim() === "") return low ? { de: `${note.charAt(0).toUpperCase()}${note.slice(1)}.` } : undefined;
  if (!low || text.toLowerCase().includes(note.toLowerCase())) return { de: text };
  return { de: `${text} (${note})` };
}

/**
 * Contract `sources` (spot and highlight): public http(s) links only (an uploaded document's `upload://` URL never
 * leaves Periplus, ruling M6-A-R2), none of `forbiddenDomains`, newest observation first, at most `spots.maxSources`;
 * omitted when none is left. The links of forbidden domains come back as `forbidden`: values drawn from such a
 * document must not be delivered, so the validation blocks the package (`foreign_content`, ruling M6-D-R2).
 */
export function mapSources(rows: SourceRefRow[], cfg: DeliveryConfig): { sources: SpotBody["sources"]; forbidden: string[] } {
  const web = rows.filter((r) => /^https?:\/\//.test(r.url));
  const forbidden = [...new Set(web.filter((r) => isForbiddenUrl(r.url, cfg.forbiddenDomains)).map((r) => r.url))].sort();
  const kept = web
    .filter((r) => !isForbiddenUrl(r.url, cfg.forbiddenDomains))
    .sort((x, y) => (x.observedAt !== y.observedAt ? (x.observedAt < y.observedAt ? 1 : -1) : x.url < y.url ? -1 : x.url > y.url ? 1 : 0))
    .slice(0, cfg.spots.maxSources)
    .map((r) => ({ url: r.url, kind: SOURCE_KIND[r.docType], observedAt: r.observedAt }));
  return { sources: kept.length > 0 ? kept : undefined, forbidden };
}

/** Flat contract provenance per field group (`shelter`, `services.taverna` …), each `aggregateProvenance`. */
function provenance(
  p: Record<string, AttributeProvenance>,
  has: (key: string) => boolean,
  o: { anchorPosition: boolean; depth: boolean; banExcludes: boolean; prohibitionHazard: boolean; seasonalBan: boolean },
): SpotBody["provenance"] {
  const groups: Record<string, string[]> = {
    shelter: SHELTER_ATTRIBUTES,
    depth: o.depth ? DEPTH_ATTRIBUTES : [],
    seabed: ["seabed"],
    holding: ["holding"],
    limits: LIMIT_ATTRIBUTES,
    mooring: MOORING_ATTRIBUTES,
    ...Object.fromEntries((Object.keys(SERVICE_ATTRIBUTE) as Service[]).map((s) => [`services.${s}`, [SERVICE_ATTRIBUTE[s]]])),
    occupancy: ["occupancy"],
    exclude: o.banExcludes ? ["exclude", "prohibitions"] : ["exclude"],
    hazards: o.prohibitionHazard ? ["hazards", "prohibitions"] : ["hazards"],
    anchorPosition: o.anchorPosition ? ["anchor_position"] : [],
    seasonNote: o.seasonalBan ? ["derived.season", "prohibitions"] : ["derived.season"],
  };
  const out: SpotBody["provenance"] = {};
  for (const [key, attributes] of Object.entries(groups)) {
    const entries = attributes.filter(has).map((k) => p[k]).filter((e): e is AttributeProvenance => e !== undefined);
    if (entries.length > 0) out[key] = aggregateProvenance(entries);
  }
  return out;
}

/** Drops keys whose value is undefined, so the serialized object has only the fields it delivers. */
function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
