import type {
  ChangeRate,
  ComputationKind,
  DocType,
  FrontierStatus,
  GeoObjectType,
  GeoOrigin,
  NameOrigin,
  PlaceKind,
  PlaceStatus,
  ReviewKind,
  RunKind,
  RunScopeType,
  RunStageStatus,
  RestrictedKind,
  RunStatus,
  SeabedType,
  SourceStatus,
} from "@/lib/db/schema";
import type { Sector } from "@/lib/domain/facts/schema-types";
import type { GapReason } from "@/lib/domain/geometry/gaps";
import type { CrawlRules } from "@/lib/domain/sources/crawl-rules";
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
};

/** The German text of a `?error=<reason>` a run action redirected with; null for none or an unknown reason. */
export function runScopeError(param: string | string[] | undefined): string | null {
  return typeof param === "string" && Object.hasOwn(RUN_SCOPE_REASON_LABELS, param)
    ? RUN_SCOPE_REASON_LABELS[param as RunScopeReason]
    : null;
}

export const queueStateLabel = (paused: boolean): string => (paused ? "Pausiert" : "Läuft");
