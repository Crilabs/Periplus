import type {
  GeoObjectType,
  GeoOrigin,
  NameOrigin,
  PlaceKind,
  PlaceStatus,
  ReviewKind,
  RunKind,
  RunScopeType,
  RunStageStatus,
  RunStatus,
} from "@/lib/db/schema";

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

export const queueStateLabel = (paused: boolean): string => (paused ? "Pausiert" : "Läuft");
