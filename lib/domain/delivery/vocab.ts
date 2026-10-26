import type { z } from "zod";
import type {
  excludeReason,
  hazardKind,
  provenanceSource,
  restrictedAreaReason,
  spotKind,
} from "@/contract/v2";
import type { PlaceKind, RestrictedKind } from "@/lib/db/schema/geo";
import type { RuleOrigin } from "@/lib/domain/rules/types";

/*
 * Vocabulary of the delivery (spec 08 "Vokabular-Abbildungen intern → Vertrag stehen als Tabellen"): internal enum
 * values (fact schema v2, M5 profiles) → contract values (Teil B, camelCase), and the German display texts the
 * contract carries. Every table is a total `Record`, so a new internal value is a compile error here.
 */

export type ContractSpotKind = z.infer<typeof spotKind>;
export type ContractExcludeReason = z.infer<typeof excludeReason>;
export type ContractHazardKind = z.infer<typeof hazardKind>;
export type ContractSource = z.infer<typeof provenanceSource>;
export type ContractRestrictedReason = z.infer<typeof restrictedAreaReason>;

type MooringType = "anchor" | "buoy" | "lines_ashore" | "stern_to" | "alongside" | "pontoon";
type HazardKindInternal = "rock" | "shoal" | "wreck" | "cable" | "current" | "swell" | "fish_farm" | "other";
type Holding = "good" | "moderate" | "poor";
export type SeasonKind = "open" | "closed" | "crowded" | "meltemi" | "other";

export const SPOT_KIND: Record<PlaceKind, ContractSpotKind> = {
  anchorage: "anchorage",
  port: "port",
  marina: "marina",
  mooring_field: "mooringField",
};

/** A pontoon berth is moored stern-to in the contract's terms. */
export const MOORING_TYPE: Record<MooringType, "anchor" | "buoy" | "sternTo" | "alongside" | "lineAshore"> = {
  anchor: "anchor",
  buoy: "buoy",
  lines_ashore: "lineAshore",
  stern_to: "sternTo",
  alongside: "alongside",
  pontoon: "sternTo",
};

export const HAZARD_KIND: Record<HazardKindInternal, ContractHazardKind> = {
  rock: "rock",
  shoal: "shoal",
  wreck: "wreck",
  cable: "cable",
  current: "current",
  swell: "swellEntry",
  fish_farm: "fishFarm",
  other: "other",
};

/** Restricted area kind → `coast.geojson` reason; a firing area is `military`, as in `spot.exclude` (M6-A-R2). */
export const RESTRICTED_REASON: Record<RestrictedKind, ContractRestrictedReason> = {
  military: "military",
  cable: "cable",
  protected_area: "protectedArea",
  aquaculture: "aquaculture",
  ferry_lane: "ferryLane",
  firing_area: "military",
};

export const HOLDING: Record<Holding, "good" | "fair" | "poor"> = { good: "good", moderate: "fair", poor: "poor" };

/** Where a value comes from: a rule origin, the gazetteer (identity fields) or a derived value. */
export type ProvenanceOrigin = RuleOrigin | "gazetteer" | "derived";

/** Origin → contract source (ruling M6-P3): rule, gazetteer and derived values are computed ones. */
export const ORIGIN: Record<ProvenanceOrigin, ContractSource> = {
  computed: "computed",
  rule: "computed",
  gazetteer: "computed",
  derived: "computed",
  text: "text",
  observed: "observed",
  review: "review",
};

/** `exclude.detail`: the German text of an exclusion reason (ruling M6-P4). */
export const EXCLUDE_REASON_DE: Record<ContractExcludeReason, string> = {
  anchoringProhibited: "Ankerverbot",
  military: "Militärisches Sperrgebiet",
  cable: "Unterwasserkabel",
  protectedArea: "Schutzgebiet",
  ferryLane: "Fährkorridor",
  unsafe: "Unsicherer Liegeplatz",
  aquaculture: "Aquakultur",
};

/** Appended to `exclude.detail` of an excluded spot whose shelter values are missing (ruling M6-B-R2 I-2). */
export const NO_SHELTER_NOTE_DE = "ausgeschlossen – keine Schutzwerte";

/** `hazards[].text`: the German word of a hazard kind (a proper name follows after a colon). */
export const HAZARD_DE: Record<ContractHazardKind, string> = {
  rock: "Fels",
  shoal: "Untiefe",
  wreck: "Wrack",
  cable: "Kabel",
  current: "Strömung",
  swellEntry: "Schwell läuft ein",
  fishFarm: "Fischfarm",
  ferryTraffic: "Fährkorridor in der Nähe",
  gusts: "Fallböen",
  other: "Gefahr",
};

/** `seasonNote[].text` of a season hint kind. */
export const SEASON_DE: Record<SeasonKind, string> = {
  open: "Geöffnet",
  closed: "Geschlossen",
  crowded: "Stark besucht",
  meltemi: "Meltemi",
  other: "Saisonhinweis",
};

/** What the contract's provenance needs of a value: a berth state's core value has it. */
export type ProvenanceInfo = { origin: ProvenanceOrigin; confidence: number; observedAt: string | null };

/** Contract order of combined sources (`computed+text`). */
const COMBINE_ORDER: ContractSource[] = ["computed", "text", "observed", "review"];
/** Which source an aggregated provenance names: the strongest evidence (review > observed > text > computed). */
const AGGREGATE_RANK: Record<ContractSource, number> = { computed: 0, text: 1, observed: 2, review: 3 };

/** The distinct contract sources of the origins, `+`-joined in contract order; at least one origin. */
export function combineSource(origins: ProvenanceOrigin[]): string {
  if (origins.length === 0) throw new Error("combineSource needs at least one origin");
  const sources = new Set(origins.map((o) => ORIGIN[o]));
  return COMBINE_ORDER.filter((s) => sources.has(s)).join("+");
}

const round3 = (n: number) => Number(n.toFixed(3));

/**
 * One contract provenance entry for several profile values: the strongest source, the lowest confidence and the
 * latest observation date (null when none has one); at least one entry.
 */
export function aggregateProvenance(entries: ProvenanceInfo[]): {
  source: ContractSource;
  confidence: number;
  observedAt: string | null;
} {
  if (entries.length === 0) throw new Error("aggregateProvenance needs at least one entry");
  const source = entries
    .map((e) => ORIGIN[e.origin])
    .reduce((best, s) => (AGGREGATE_RANK[s] > AGGREGATE_RANK[best] ? s : best));
  const dates = entries.map((e) => e.observedAt?.slice(0, 10) ?? null).filter((d): d is string => d !== null);
  return {
    source,
    confidence: round3(Math.min(...entries.map((e) => e.confidence))),
    observedAt: dates.length === 0 ? null : dates.reduce((a, b) => (b > a ? b : a)),
  };
}
