import type {
  ChangeRate,
  ComparisonVerdict,
  ComputationKind,
  DocType,
  ExtractionPurpose,
  ExtractionRunBlockReason,
  ExtractionRunStatus,
  ExtractionStatus,
  MatchKind,
  DocumentStatus,
  ObservedAtBasis,
  FrontierStatus,
  GeoObjectType,
  GeoOrigin,
  NameOrigin,
  NameCandidateStatus,
  PlaceKind,
  PlaceStatus,
  PoiCategory,
  ReviewKind,
  RunKind,
  RunScopeType,
  RunStageStatus,
  RestrictedKind,
  RunStatus,
  SeabedType,
  SourceOrigin,
  SourceStatus,
} from "@/lib/db/schema";
import { SECTORS, type Sector } from "@/lib/domain/facts/schema-types";
import type { GapReason } from "@/lib/domain/geometry/gaps";
import type { CrawlRules } from "@/lib/domain/sources/crawl-rules";
import type { NAME_AFFIX_HINTS } from "@/lib/config/schemas";
import type { OriginSource } from "@/lib/domain/geometry/water";
import type { RunScopeReason } from "@/lib/pipeline/tile-scope";

/** German display labels for English enum values. Typed as complete records, so a new enum value fails typecheck. */

export const RUN_KIND_LABELS: Record<RunKind, string> = {
  full: "Vollständig",
  stage: "Einzelne Stufe",
  revisit: "Wiederbesuch",
  event: "Ereignis",
  reprocess: "Neuverarbeitung",
  system: "System",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Wartend",
  running: "Läuft",
  finished: "Abgeschlossen",
  failed: "Fehlgeschlagen",
};

export const STAGE_STATUS_LABELS: Record<RunStageStatus, string> = {
  pending: "Ausstehend",
  running: "Läuft",
  finished: "Abgeschlossen",
};

export const SCOPE_TYPE_LABELS: Record<RunScopeType, string> = {
  tile: "Kachel",
  area: "Gebiet",
  place: "Ort",
  source: "Quelle",
  system: "System",
};

export const REVIEW_KIND_LABELS: Record<ReviewKind, string> = {
  source_approval: "Quellenfreigabe",
  place_candidate: "Ortskandidat",
  conflict: "Widerspruch",
  failed_job: "Fehlgeschlagener Job",
  coast_tile_without_area: "Küstenkachel ohne Revier",
  uncertain_change: "Unsichere Änderung",
  comparison_deviation: "Vergleichsabweichung",
};

export const PLACE_KIND_LABELS: Record<PlaceKind, string> = {
  anchorage: "Ankerplatz",
  port: "Hafen",
  marina: "Marina",
  mooring_field: "Bojenfeld",
};

export const PLACE_STATUS_LABELS: Record<PlaceStatus, string> = {
  candidate: "Kandidat",
  confirmed: "Bestätigt",
  rejected: "Verworfen",
  abandoned: "Aufgegeben",
  no_anchoring: "Kein Ankerplatz",
};

export const GEO_OBJECT_TYPE_LABELS: Record<GeoObjectType, string> = {
  sea: "Meer",
  area: "Revier",
  gulf: "Golf",
  island: "Insel",
  islet: "Eiland",
  archipelago: "Archipel",
  coast_section: "Küstenabschnitt",
  cape: "Kap",
  strait: "Meerenge",
  channel: "Kanal",
  bay: "Bucht",
  harbour: "Hafen",
  settlement: "Siedlung",
  poi: "Highlight",
};

export const POI_CATEGORY_LABELS: Record<PoiCategory, string> = {
  food: "Essen",
  supply: "Versorgung",
  beach: "Strand",
  nature: "Natur",
  active: "Aktiv",
  culture: "Kultur",
  town: "Ort",
};

/** The type hint of a name in a text ("Ormos …", "… Bay"). */
export const NAME_HINT_LABELS: Record<(typeof NAME_AFFIX_HINTS)[number], string> = {
  bay: "Bucht",
  harbour: "Hafen",
  anchorage: "Ankerplatz",
  cape: "Kap",
  island: "Insel",
  marina: "Marina",
};

export const NAME_CANDIDATE_STATUS_LABELS: Record<NameCandidateStatus, string> = {
  collecting: "Wird gesammelt",
  geocoded: "Geokodiert",
  review: "Im Review",
  decided: "Entschieden",
};

export const GEO_ORIGIN_LABELS: Record<GeoOrigin, string> = {
  osm: "OpenStreetMap",
  geonames: "GeoNames",
  wikidata: "Wikidata",
  text: "Text",
  review: "Review",
  computed: "Berechnet",
  manual: "Manuell",
};

export const NAME_ORIGIN_LABELS: Record<NameOrigin, string> = {
  osm: "OpenStreetMap",
  geonames: "GeoNames",
  wikidata: "Wikidata",
  text: "Text",
  review: "Review",
  manual: "Manuell",
  transliteration: "Transliteration",
  fallback: "Ersatz",
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

export const GAP_REASON_LABELS: Record<GapReason, string> = {
  no_water: "Keine Wasserfläche",
  origin_unresolved: "Kein Ausgangspunkt im Wasser",
  no_bathymetry: "Keine Bathymetrie",
  no_anchor_area: "Keine Fläche mit 3–12 m",
  no_seabed_coverage: "Grund nicht abgedeckt",
};

export const COMPUTATION_KIND_LABELS: Record<ComputationKind, string> = {
  shelter: "Schutz",
  fetch: "Fetch",
  depth: "Tiefe",
  seabed: "Grund",
  anchor_area: "Ankerfläche",
  quietness: "Ruhe",
  restriction: "Ausschluss",
};

export const RESTRICTED_KIND_LABELS: Record<RestrictedKind, string> = {
  military: "Militärgebiet",
  cable: "Kabel",
  protected_area: "Schutzgebiet",
  aquaculture: "Aquakultur",
  ferry_lane: "Fährkorridor",
  firing_area: "Schießgebiet",
};

/** Where the rays and depth samples of a place start. */
export const ORIGIN_SOURCE_LABELS: Record<OriginSource, string> = {
  position: "Position des Orts",
  review_anchor: "Ankerposition (Review)",
  computed_anchor: "Ankerposition (berechnet)",
  moved_off_land: "Position, vom Land ins Wasser verschoben",
};

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  pilot_guide: "Revierführer",
  trip_report: "Törnbericht",
  forum: "Forum",
  marina: "Marina",
  authority: "Behörde",
  dataset: "Datensatz",
  travel_guide: "Reiseführer",
  other: "Sonstiges",
};

export const SOURCE_STATUS_LABELS: Record<SourceStatus, string> = {
  proposed: "Vorgeschlagen",
  approved: "Freigegeben",
  rejected: "Abgelehnt",
  paused: "Pausiert",
};

export const SOURCE_ORIGIN_LABELS: Record<SourceOrigin, string> = {
  serp: "Suchtreffer",
  linkgraph: "Linkgraph",
  whitelist: "Whitelist",
  manual: "Manuell",
};

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  active: "Aktiv",
  gone: "Verschwunden",
};

/** Where the observation date of a version comes from. */
export const OBSERVED_AT_BASIS_LABELS: Record<ObservedAtBasis, string> = {
  explicit: "Im Text genannt",
  published: "Veröffentlichungsdatum",
  fetched: "Abrufdatum",
};

export const CHANGE_RATE_LABELS: Record<ChangeRate, string> = {
  high: "Hoch (täglich)",
  normal: "Normal",
  static: "Statisch",
};

export const FRONTIER_STATUS_LABELS: Record<FrontierStatus, string> = {
  queued: "Offen",
  fetched: "Abgerufen",
  skipped: "Übersprungen",
  failed: "Fehlgeschlagen",
};

/** Field names of the crawl rules (spec 05). */
export const CRAWL_RULE_LABELS: Record<keyof CrawlRules, string> = {
  startUrls: "Start-URLs",
  allow: "Erlaubte Pfade",
  deny: "Gesperrte Pfade",
  maxDepth: "Maximale Tiefe",
  maxPages: "Maximale Seiten",
  ratePerMinute: "Abrufe pro Minute",
  render: "Rendern",
  converter: "Konverter",
  pdf: "PDFs abrufen",
  boilerplateSelectors: "Boilerplate-Selektoren",
};

export const RENDER_MODE_LABELS: Record<CrawlRules["render"], string> = {
  auto: "Automatisch",
  never: "Nie",
  always: "Immer",
};

export const CONVERTER_LABELS: Record<CrawlRules["converter"], string> = {
  auto: "Automatisch",
  jina: "Jina",
  firecrawl: "Firecrawl",
  local: "Lokal",
};

/** Why a run did not start (`RunScopeNotReady`). */
export const RUN_SCOPE_REASON_LABELS: Record<RunScopeReason, string> = {
  area_without_geo_object: "Revier hat noch kein Geo-Objekt – zuerst „Gazetteer aufbauen“",
  area_without_coast_tiles: "Revier hat noch keine Küstenkacheln – zuerst „Gazetteer aufbauen“",
  bathymetry_missing: "Bathymetrie fehlt – zuerst „Datensätze laden“",
  land_missing: "Landpolygone fehlen – zuerst die Landpolygone importieren",
  place_not_computable: "Ort wird nicht berechnet (beendet, zusammengeführt, verworfen oder ohne Kachel)",
  tile_without_area: "Kachel gehört zu keinem konfigurierten Revier – Suchsprachen unbekannt",
  no_approved_sources: "Keine freigegebene Quelle",
  source_not_approved: "Quelle ist nicht freigegeben",
  source_run_active: "Für die Quelle läuft bereits ein Abruf",
  wikivoyage_source_ended: "Die Wikivoyage-Quelle ist beendet",
  document_not_upload: "Dokument ist keine hochgeladene Datei",
  no_converter_samples: "Keine Seiten für den Vergleich – zuerst Quellen freigeben und crawlen",
  converter_samples_done: "Alle Seiten der Stichprobe sind bereits mit allen drei Konvertern umgewandelt",
  comparison_run_active: "Ein Konverter-Vergleich läuft bereits",
  embed_backfill_active: "„Einbettungen nachholen“ läuft bereits",
  unknown_tile: "Kachel ist unbekannt oder beendet",
  unknown_area: "Revier ist nicht konfiguriert",
  area_without_tiles: "Revier hat noch keine Kacheln – zuerst „Gazetteer aufbauen“",
  versions_not_current: "Eine Dokumentversion gibt es nicht oder sie ist nicht mehr aktuell",
  unknown_comparison: "Diesen Modellvergleich gibt es nicht",
  comparison_without_units: "Der Modellvergleich hat keine Einheiten – zuerst Texte auswerten",
  comparison_started: "Für diesen Modellvergleich gibt es bereits einen Lauf",
  comparison_over_budget: "Die Kostenschätzung passt heute nicht mehr ins Anthropic-Budget (config/budgets.json) – morgen erneut starten",
};

/** The German text of a `?error=<reason>` a run action redirected with; null for none or an unknown reason. */
export function runScopeError(param: string | string[] | undefined): string | null {
  return typeof param === "string" && Object.hasOwn(RUN_SCOPE_REASON_LABELS, param)
    ? RUN_SCOPE_REASON_LABELS[param as RunScopeReason]
    : null;
}

/** Errors of the source pages besides refused runs (`?error=<code>`). */
export const SOURCE_ERROR_LABELS = {
  not_pdf: "Die Datei ist kein PDF",
  too_large: "Die Datei ist größer als 100 MB",
  no_file: "Keine Datei ausgewählt",
  domain_known: "Für diese Domain gibt es bereits eine Quelle",
  invalid_domain: "Das ist keine gültige Domain",
  invalid_source: "Domain, Name und Typ angeben",
  not_approved: "Nur eine freigegebene Quelle kann pausiert werden",
  not_paused: "Nur eine pausierte Quelle kann fortgesetzt werden",
  source_ended: "Die Quelle ist beendet",
  upload_not_allowed: "PDFs lassen sich nur bei freigegebenen, vorgeschlagenen oder pausierten Quellen hochladen",
} as const;

export type SourceErrorCode = keyof typeof SOURCE_ERROR_LABELS;

/** The German text of a `?error=` on the source pages: a refused run or a `SOURCE_ERROR_LABELS` code. */
export function sourcePageError(param: string | string[] | undefined): string | null {
  if (typeof param !== "string") return null;
  return runScopeError(param) ?? (Object.hasOwn(SOURCE_ERROR_LABELS, param) ? SOURCE_ERROR_LABELS[param as SourceErrorCode] : null);
}

/** Errors of the converter comparison page besides refused runs (`?error=<code>`). */
export const COMPARE_ERROR_LABELS = {
  invalid_rating: "Die Bewertung war unvollständig",
  not_rateable: "Diese Umwandlung ist fehlgeschlagen und lässt sich nicht bewerten",
} as const;

/** The German text of a `?error=` on the converter comparison page; null for none or an unknown code. */
export function comparePageError(param: string | string[] | undefined): string | null {
  if (typeof param !== "string") return null;
  return runScopeError(param) ?? (Object.hasOwn(COMPARE_ERROR_LABELS, param) ? COMPARE_ERROR_LABELS[param as keyof typeof COMPARE_ERROR_LABELS] : null);
}

export const queueStateLabel = (paused: boolean): string => (paused ? "Pausiert" : "Läuft");

/* ---- M4: mentions, extraction runs, facts ---- */

/** The extraction state of a mention (`failed`: its unit failed for good; only a reprocess extracts it again). */
export const MENTION_EXTRACTION_STATUS_LABELS: Record<ExtractionStatus, string> = {
  pending: "Offen",
  done: "Ausgewertet",
  skipped: "Übersprungen (keine Fact-Ebene)",
  failed: "Fehlgeschlagen",
};

export const MATCH_KIND_LABELS: Record<MatchKind, string> = {
  deterministic: "Namensabgleich",
  model: "Modell",
  review: "Prüfung",
};

export const EXTRACTION_RUN_STATUS_LABELS: Record<ExtractionRunStatus, string> = {
  running: "Läuft",
  finished: "Abgeschlossen",
  blocked: "Gesperrt",
  failed: "Fehlgeschlagen",
};

/** Why an extraction run is blocked (it is then never consolidated). */
export const EXTRACTION_BLOCK_REASON_LABELS: Record<ExtractionRunBlockReason, string> = {
  quote_fidelity: "Belegtreue unter 100 %",
  late_results: "Ergebnisse nach der Prüfung eingetroffen – Belegtreue neu prüfen",
  run_ended: "Lauf von Hand beendet, vor der Prüfung",
  run_failed: "Lauf fehlgeschlagen, vor der Prüfung – Belegtreue neu prüfen",
};

export const EXTRACTION_PURPOSE_LABELS: Record<ExtractionPurpose, string> = {
  regular: "Regulär",
  reprocess: "Reprozessierung",
  comparison: "Modellvergleich",
};

/** Why a quote did not hold up in the quote check (`FidelityFailure.reason`, `QuoteCheck` reasons). */
export const QUOTE_FAILURE_LABELS: Record<string, string> = {
  not_verified: "nicht als geprüft gespeichert",
  no_chunk: "Chunk fehlt",
  offset_mismatch: "Fundstelle weicht ab",
  not_found: "nicht im Text",
  too_long: "zu lang",
  too_short: "zu kurz",
  ellipsis: "mit Auslassung",
  empty: "leer",
};

/** Where a fact comes from (`FactView.origin`). */
export const FACT_ORIGIN_LABELS = {
  text: "Text",
  computed: "Berechnung",
  review: "Prüfung",
  observed: "Beobachtung",
} as const;

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

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
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

function scaleWord(attribute: string, value: number): string | undefined {
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

/* ---- M4: model comparison ---- */

/** Verdicts on a deviation of the model comparison, in button order (keys 1–5). */
export const COMPARISON_VERDICT_LABELS: Record<ComparisonVerdict, string> = {
  a_correct: "A richtig",
  b_correct: "B richtig",
  both_ok: "Beide richtig",
  both_wrong: "Beide falsch",
  unclear: "Unklar",
};

/** A shortfall code of a comparison sample (`comparisonShortfall`) in German. */
export function comparisonShortfallLabel(code: string): string {
  const [kind, rest = ""] = code.split(/:(.*)/s);
  if (kind === "units") {
    const [n, target] = rest.split("/");
    return `Nur ${n} von ${target} Einheiten – es gibt nicht mehr Erwähnungen von Objekten mit Facts`;
  }
  if (kind === "sources") {
    const [n, min] = rest.split("/");
    return `Nur ${n} Quellen, die Spezifikation verlangt mindestens ${min}`;
  }
  if (kind === "doc_type") return `Dokumenttyp „${DOC_TYPE_LABELS[rest as DocType] ?? rest}“ fehlt in der Stichprobe`;
  return code;
}

/** Errors of the model comparison page besides refused runs (`?error=<code>`). */
export const MODEL_COMPARE_ERROR_LABELS = {
  invalid_label: "Bitte eine Bezeichnung angeben (höchstens 80 Zeichen)",
  invalid_rating: "Die Bewertung war unvollständig",
  invalid_models: "In config/models.json stehen nicht zwei verschiedene Vergleichsmodelle",
} as const;

/** The German text of a `?error=` on the model comparison page; null for none or an unknown code. */
export function modelComparePageError(param: string | string[] | undefined): string | null {
  if (typeof param !== "string") return null;
  return (
    runScopeError(param) ??
    (Object.hasOwn(MODEL_COMPARE_ERROR_LABELS, param) ? MODEL_COMPARE_ERROR_LABELS[param as keyof typeof MODEL_COMPARE_ERROR_LABELS] : null)
  );
}
