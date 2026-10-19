import type { PoiCategory, SeabedType } from "@/lib/db/schema";
import { SECTORS, type Sector } from "./schema-types";

/*
 * German labels of the fact attributes and the formatter of fact values (ruling M5-P13: moved here from
 * `app/(admin)/_components/labels.ts`, which re-exports them, so lib code such as the profile summary can use them).
 * Client components import this module through the app labels: it must stay free of server-only imports.
 */

export const POI_CATEGORY_LABELS: Record<PoiCategory, string> = {
  food: "Essen",
  supply: "Versorgung",
  beach: "Strand",
  nature: "Natur",
  active: "Aktiv",
  culture: "Kultur",
  town: "Ort",
};

export const SECTOR_LABELS: Record<Sector, string> = {
  N: "N",
  NE: "NO",
  E: "O",
  SE: "SO",
  S: "S",
  SW: "SW",
  W: "W",
  NW: "NW",
};

export const SEABED_TYPE_LABELS: Record<SeabedType, string> = {
  sand: "Sand",
  mud: "Schlamm",
  gravel: "Kies",
  rock: "Fels",
  mixed: "Gemischt",
  weed: "Seegras/Algen",
};

const SERVICE_LABELS: Record<string, string> = {
  water: "Wasser",
  electricity: "Strom",
  fuel: "Treibstoff",
  dinghy_landing: "Dingi-Anleger",
  waste: "Müll",
  showers: "Duschen",
  wifi: "WLAN",
};

/**
 * German labels of the fact attributes (every key of fact schema v1 and v2, all levels; ruling M4-P22): the sector
 * templates `shelter.<S>` and `fetch.<S>` via `SECTOR_LABELS`, `highlight.<category>` via `POI_CATEGORY_LABELS`, the
 * `services.*` keys.
 */
export const FACT_ATTRIBUTE_LABELS: Record<string, string> = {
  ...Object.fromEntries(SECTORS.map((s) => [`shelter.${s}`, `Schutz aus ${SECTOR_LABELS[s]}`])),
  ...Object.fromEntries(SECTORS.map((s) => [`fetch.${s}`, `Fetch nach ${SECTOR_LABELS[s]}`])),
  swell_protection: "Schwellschutz",
  opening_bearing: "Öffnung zur See",
  "depth.min": "Tiefe min.",
  "depth.max": "Tiefe max.",
  "depth.anchoring_min": "Ankertiefe min.",
  "depth.anchoring_max": "Ankertiefe max.",
  "depth.approach": "Tiefen in der Ansteuerung",
  seabed: "Grund",
  anchor_area: "Ankerfläche",
  anchor_position: "Ankerposition",
  prohibitions: "Verbote",
  holding: "Halt",
  "mooring.types": "Festmachen",
  "mooring.buoys": "Bojen",
  "mooring.line_ashore_required": "Landleine nötig",
  capacity: "Kapazität",
  max_draft: "Max. Tiefgang",
  max_length: "Max. Bootslänge",
  occupancy: "Belegung",
  ...Object.fromEntries(Object.entries(SERVICE_LABELS).map(([k, v]) => [`services.${k}`, `Service: ${v}`])),
  hazards: "Gefahren",
  ...Object.fromEntries(Object.entries(POI_CATEGORY_LABELS).map(([k, v]) => [`highlight.${k}`, `Highlight: ${v}`])),
  quietness: "Ruhe",
  season_notes: "Saison",
  prices: "Preise",
  contact: "Kontakt",
  meltemi_exposure: "Meltemi-Exposition",
  wind_systems: "Windsysteme",
  ferry_traffic: "Fährverkehr",
  restricted_zones: "Sperrgebiete",
  charter_bases: "Charterbasen",
  supply_ports: "Versorgungshäfen",
  passage_notes: "Passage",
  sea_state: "Seegang",
  exists: "Existiert",
  dinghy_access: "Mit dem Dingi erreichbar",
};

/** The label of a fact attribute; the key itself for an unknown one. */
export const factAttributeLabel = (key: string): string => FACT_ATTRIBUTE_LABELS[key] ?? key;

/** German words for the enum values of fact values (language-neutral in the data). */
const VALUE_WORDS: Record<string, string> = {
  good: "gut",
  moderate: "mäßig",
  poor: "schlecht",
  quiet: "ruhig",
  busy: "belebt",
  noisy: "laut",
  none: "keine",
  low: "gering",
  high: "hoch",
  calm: "ruhig",
  rough: "rau",
  easy: "leicht",
  difficult: "schwierig",
  empty: "leer",
  full: "voll",
  anchor: "Anker",
  buoy: "Boje",
  lines_ashore: "Landleinen",
  stern_to: "römisch-katholisch",
  alongside: "längsseits",
  pontoon: "Steg",
  shoal: "Untiefe",
  wreck: "Wrack",
  cable: "Kabel",
  current: "Strömung",
  swell: "Schwell",
  fish_farm: "Fischfarm",
  other: "sonstiges",
  open: "offen",
  closed: "geschlossen",
  crowded: "überfüllt",
  meltemi: "Meltemi",
  sirocco: "Schirokko",
  bora: "Bora",
  maestral: "Maestral",
  land_breeze: "Landwind",
  military: "militärisch",
  firing: "Schießgebiet",
  protected: "Schutzgebiet",
  anchoring: "Ankern",
  swimming: "Schwimmen",
  fishing: "Fischen",
  fire: "Feuer",
  jet_ski: "Jetski",
  acceleration: "Düseneffekt",
  traffic: "Verkehr",
  overfalls: "Kabbelwasser",
  shallow: "flach",
  night: "Nacht",
  meter_night: "Meter und Nacht",
  // Seabed types (rock: "Fels", also a hazard kind).
  ...SEABED_TYPE_LABELS,
};

/** Field names inside object values. */
const FIELD_WORDS: Record<string, string> = {
  present: "vorhanden",
  names: "Namen",
  count: "Anzahl",
  paid: "kostenpflichtig",
  months: "Monate",
  kind: "Art",
  name: "Name",
  amount: "Betrag",
  currency: "Währung",
  unit: "je",
  vhf: "UKW",
  phone: "Telefon",
  url: "Web",
  difficulty: "Schwierigkeit",
  notes: "Hinweise",
  bearingDeg: "Peilung °",
  widthDeg: "Breite °",
  areaM2: "Fläche m²",
  lon: "Länge",
  lat: "Breite",
  at50m: "50 m",
  at100m: "100 m",
  at200m: "200 m",
  share: "Anteil",
  anchoringBan: "Ankerverbot",
  restrictedAreaId: "Gebiet",
  sourceRef: "Quelle",
  type: "Art",
};

export const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const METRE_ATTRIBUTES = new Set(["depth.min", "depth.max", "depth.anchoring_min", "depth.anchoring_max", "max_draft", "max_length"]);
const de = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 2 });

function formatPart(value: unknown, field?: string): string {
  if (value === null || value === undefined) return "–";
  if (typeof value === "boolean") return value ? "ja" : "nein";
  if (typeof value === "number") {
    if (field === "months") return MONTHS[value - 1] ?? String(value);
    if (field === "share") return `${de(value * 100)} %`;
    return de(value);
  }
  if (typeof value === "string") return VALUE_WORDS[value] ?? value;
  if (Array.isArray(value)) return value.map((v) => formatPart(v, field)).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `${FIELD_WORDS[k] ?? k}: ${formatPart(v, k)}`)
      .join(" · ");
  }
  return String(value);
}

/** Enum words that read differently for one attribute (the generic word does not fit its noun). */
const ATTRIBUTE_VALUE_WORDS: Record<string, Record<string, string>> = {
  ferry_traffic: { none: "kein Fährverkehr", low: "wenig", moderate: "mäßig", high: "viel" },
  quietness: { moderate: "mittel" },
};

/**
 * The words of the text scales (fact schema v2 `TEXT_SCALE`, `EXPOSURE_SCALE`; spec 06 "gut/mäßig/kein Schutz" →
 * 0,9 / 0,5 / 0,1): a text fact stores the number, the page shows the word with it. Kept here, not imported, because
 * client components import this module; a test checks it against the fact schema.
 */
export const SHELTER_SCALE_WORDS: Record<string, string> = { "0.9": "gut geschützt", "0.5": "mäßig geschützt", "0.1": "kein Schutz" };
export const EXPOSURE_SCALE_WORDS: Record<string, string> = { "0.1": "gering", "0.5": "mäßig", "0.9": "stark" };

export function scaleWord(attribute: string, value: number): string | undefined {
  if (attribute.startsWith("shelter.") || attribute === "swell_protection") return SHELTER_SCALE_WORDS[String(value)];
  if (attribute === "meltemi_exposure") return EXPOSURE_SCALE_WORDS[String(value)];
  return undefined;
}

/** A fact value for display, in German (units for depths and lengths, month names, labelled fields). */
export function formatFactValue(attribute: string, value: unknown): string {
  if (typeof value === "number" && METRE_ATTRIBUTES.has(attribute)) return `${de(value)} m`;
  if (typeof value === "number") {
    const word = scaleWord(attribute, value);
    if (word) return `${word} (${de(value)})`;
  }
  if (typeof value === "string" && ATTRIBUTE_VALUE_WORDS[attribute]?.[value]) return ATTRIBUTE_VALUE_WORDS[attribute][value];
  if (attribute === "depth.approach" && value && typeof value === "object") {
    return Object.entries(value as Record<string, number | null>)
      .map(([k, v]) => `${FIELD_WORDS[k] ?? k}: ${v === null ? "–" : `${de(v)} m`}`)
      .join(" · ");
  }
  if (attribute === "seabed" && Array.isArray(value)) {
    return (value as Array<{ type: string; share: number }>).map((p) => `${VALUE_WORDS[p.type] ?? p.type} ${de(p.share * 100)} %`).join(", ");
  }
  if (attribute === "occupancy" && value && typeof value === "object") {
    return Object.entries(value as Record<string, string>)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([m, w]) => `${MONTHS[Number(m) - 1] ?? m}: ${VALUE_WORDS[w] ?? w}`)
      .join(", ");
  }
  return formatPart(value);
}

