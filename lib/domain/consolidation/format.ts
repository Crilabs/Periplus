import { FACT_ATTRIBUTE_LABELS, formatFactValue } from "@/lib/domain/facts/labels";
import type { ExcludeReason } from "./exclude";

/*
 * German display of consolidated profile values (ruling M5-P13): `formatFactValue` for every fact value, plus the
 * shapes only a profile has — united lists, occupancy of the known months, `exclude`, 0–1 values with two decimals,
 * highlights with their names, derived values. Where the plan's table differs from the fact formatter, the fact
 * formatter wins ("4 m", "Seegras/Algen 50 %"). Client-safe: no server-only imports.
 */

/** Labels of the profile keys that are no fact attributes (derived values, identity fields). */
const PROFILE_ONLY_LABELS: Record<string, string> = {
  exclude: "Ausschluss",
  "derived.quietness": "Ruhe-Index",
  "derived.season": "Saisonhinweise",
  "derived.importance": "Bedeutung",
  "derived.radius_nm": "Bedeutungsradius",
  "derived.spot_ids": "Orte im Bedeutungsradius",
  "geo.name": "Name",
  "geo.parent_id": "Übergeordnetes Objekt",
  "geo.geometry_hash": "Geometrie",
  "place.kind": "Art",
  "place.status": "Status",
  "place.position": "Position",
};

/** The German label of a profile key (fact attribute, derived value or identity field); the key itself when unknown. */
export const profileAttributeLabel = (key: string): string => FACT_ATTRIBUTE_LABELS[key] ?? PROFILE_ONLY_LABELS[key] ?? key;

export const EXCLUDE_REASON_LABELS: Record<ExcludeReason, string> = {
  anchoringProhibited: "Ankerverbot",
  military: "Militär",
  cable: "Kabel",
  protectedArea: "Schutzgebiet",
  ferryLane: "Fährkorridor",
  unsafe: "unsicher",
  aquaculture: "Aquakultur",
};

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

/** Values on the scale 0–1 (shelter, swell protection, exposure, the quietness index): two decimals, "0,62". */
function isUnitScale(attribute: string): boolean {
  return attribute.startsWith("shelter.") || ["swell_protection", "meltemi_exposure", "derived.quietness"].includes(attribute);
}

const twoDecimals = (n: number) => n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** "Jul, Aug" for a month list; "ganzjährig" for `null` (all year). */
function monthList(months: unknown): string | null {
  if (months === null) return "ganzjährig";
  if (!Array.isArray(months) || months.length === 0) return null;
  return months.map((m) => (typeof m === "number" ? (MONTHS[m - 1] ?? String(m)) : String(m))).join(", ");
}

/**
 * One entry of a united list in short form: the word of its kind or name with its proper name and months in brackets
 * ("Fels (Xera)", "Meltemi (Jul, Aug)"); a computed prohibition by its restricted-area kind.
 */
function listEntry(attribute: string, entry: unknown): string {
  if (!isRecord(entry)) return formatFactValue(attribute, entry);
  const head = entry.kind ?? entry.name;
  if (typeof head !== "string") return formatFactValue(attribute, entry);
  const word = formatFactValue(attribute, head);
  const extras = [typeof entry.name === "string" && entry.kind !== undefined ? entry.name : null, "months" in entry ? monthList(entry.months) : null]
    .filter((x): x is string => x !== null);
  return extras.length > 0 ? `${word} (${extras.join("; ")})` : word;
}

/** A profile value for display, in German (see the module comment); `null` / missing → "–". */
export function formatProfileValue(attribute: string, value: unknown): string {
  if (value === null || value === undefined) return "–";
  if (typeof value === "number" && isUnitScale(attribute)) return twoDecimals(value);
  if (attribute === "exclude" && isRecord(value)) {
    if (value.excluded !== true) return "nein";
    const reason = typeof value.reason === "string" ? EXCLUDE_REASON_LABELS[value.reason as ExcludeReason] : undefined;
    return reason ? `ausgeschlossen (${reason})` : "ausgeschlossen";
  }
  if (attribute === "occupancy" && isRecord(value)) {
    const known = Object.entries(value)
      .filter(([, word]) => word !== "unknown")
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([m, word]) => `${MONTHS[Number(m) - 1] ?? m} ${formatFactValue(attribute, word)}`);
    return known.length > 0 ? known.join(", ") : "unbekannt";
  }
  if (attribute.startsWith("highlight.") && isRecord(value) && "present" in value) {
    if (value.present !== true) return "nein";
    const names = Array.isArray(value.names) ? value.names.filter((n): n is string => typeof n === "string") : [];
    return names.length > 0 ? `ja: ${names.join(", ")}` : "ja";
  }
  if (attribute === "derived.season" && Array.isArray(value)) {
    return value.map((hint) => listEntry("season_notes", hint)).join(", ");
  }
  if (attribute === "derived.radius_nm" && typeof value === "number") return `${value} sm`;
  if (attribute === "derived.importance" && typeof value === "number") return `${value} von 5`;
  if (Array.isArray(value) && attribute !== "seabed") return value.map((entry) => listEntry(attribute, entry)).join(", ");
  return formatFactValue(attribute, value);
}
