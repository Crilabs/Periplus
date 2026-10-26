import type {
  ComputationKind,
  DocType,
  ExtractionStatus,
  DocumentStatus,
  ObservedAtBasis,
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
} from "@/lib/db/schema";
import type { DeliveryStatus } from "@/lib/db/schema/deliveries";
import type { PageKind } from "@/lib/db/schema/research";
import type { BerthSignalKind, Tone } from "@/lib/db/schema/research-extract";
import type { ComparisonAttribute, ComparisonMethod, ComparisonResultValue } from "@/lib/db/schema/quality";
import type { ContractFile } from "@/contract";
import type { CheckName } from "@/lib/domain/delivery/validate";
import type { PreviewOmission } from "@/lib/domain/delivery/view";
import type { MergeRefusal } from "@/lib/domain/place-merge";
import type { PlaceStatusRefusal } from "@/lib/domain/place-status";
import type { ConfidenceClass } from "@/lib/domain/rules/types";
import type { GapReason } from "@/lib/domain/geometry/gaps";
import type { OriginSource } from "@/lib/domain/geometry/water";
import type { RunScopeReason } from "@/lib/pipeline/tile-scope";

export {
  EXPOSURE_SCALE_WORDS,
  FACT_ATTRIBUTE_LABELS,
  factAttributeLabel,
  formatFactValue,
  POI_CATEGORY_LABELS,
  SEABED_TYPE_LABELS,
  SECTOR_LABELS,
  SHELTER_SCALE_WORDS,
} from "@/lib/domain/facts/labels";

/** The language of a name for display: `und` (ISO 639 „undetermined“, an OSM `name` without language) reads „unbekannt“. */
export const languageLabel = (code: string): string => (code === "und" ? "unbekannt" : code);

/** German display labels for English enum values. Typed as complete records, so a new enum value fails typecheck. */

export const RUN_KIND_LABELS: Record<RunKind, string> = {
  full: "Vollständig",
  stage: "Einzelne Stufe",
  revisit: "Revisit",
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

/** German names of stages whose technical name alone says little, shown beside it on the run page. */
export const STAGE_LABELS: Partial<Record<string, string>> = {
  "consolidation.highlights": "Highlights konsolidieren",
};

export const SCOPE_TYPE_LABELS: Record<RunScopeType, string> = {
  tile: "Kachel",
  area: "Gebiet",
  subdivision: "Landesteil",
  place: "Ort",
  source: "Quelle",
  system: "System",
};

export const REVIEW_KIND_LABELS: Record<ReviewKind, string> = {
  source_approval: "Quellenfreigabe",
  place_candidate: "Ortskandidat",
  conflict: "Konflikt",
  failed_job: "Fehlgeschlagener Job",
  coast_tile_without_area: "Küstenkachel ohne Revier",
  uncertain_change: "Unsichere Änderung",
  comparison_deviation: "Vergleichsabweichung",
  place_image: "Titelbild",
  research_conflict: "Recherche-Konflikt",
};

/** Kind of a researched page (page assessment, spec 18). */
export const PAGE_KIND_LABELS: Record<PageKind, string> = {
  trip_report: "Törnbericht",
  pilot_guide: "Revierführer",
  marina: "Marina",
  authority: "Behörde",
  forum: "Forum",
  travel_guide: "Reiseführer",
  listing: "Liste",
  other: "Sonstiges",
};

/** Kind of a research signal on a berth (spec 5.6). */
export const SIGNAL_KIND_LABELS: Record<BerthSignalKind, string> = {
  anchored: "geankert",
  moored_buoy: "an Boje gelegen",
  berthed: "festgemacht",
  listed_as_berth: "als Liegeplatz geführt",
  prohibited: "Verbot/Sperrgebiet",
  buoys_private: "Bojen privat",
  no_space: "kein Platz",
  unsafe: "unsicher",
  closed: "geschlossen/Bauarbeiten",
};

/** Tendency of an extracted fact. */
export const TONE_LABELS: Record<Tone, string> = { positive: "positiv", neutral: "neutral", negative: "negativ" };

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
  country: "Land",
  admin_region: "Verwaltungsregion",
};

export const GEO_ORIGIN_LABELS: Record<GeoOrigin, string> = {
  osm: "OpenStreetMap",
  geonames: "GeoNames",
  wikidata: "Wikidata",
  text: "Text",
  review: "Review",
  computed: "Berechnet",
  manual: "Manuell",
  marine_regions: "Marine Regions",
  import: "Revier-Bot",
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
  import: "Revier-Bot",
  research: "Recherche",
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

/** Why a run did not start (`RunScopeNotReady`). */
export const RUN_SCOPE_REASON_LABELS: Record<RunScopeReason, string> = {
  area_without_geo_object: "Revier hat noch kein Geo-Objekt – zuerst „Gazetteer aufbauen“",
  area_without_coast_tiles: "Revier hat noch keine Küstenkacheln – zuerst „Gazetteer aufbauen“",
  subdivision_without_coast_tiles: "Landesteil hat noch keine Küstenkacheln – zuerst „Gazetteer aufbauen“",
  tile_without_subdivision: "Kachel gehört zu keinem Landesteil – Suchsprachen unbekannt",
  bathymetry_missing: "Bathymetrie fehlt – zuerst „Datensätze laden“",
  land_missing: "Landpolygone fehlen – zuerst die Landpolygone importieren",
  place_not_computable: "Ort wird nicht berechnet (beendet, zusammengeführt, verworfen oder ohne Kachel)",
  unknown_tile: "Kachel ist unbekannt oder beendet",
  unknown_area: "Ein Revier-Schlüssel ist kein Laufumfang mehr – einen Landesteil angeben",
  comparison_set_empty: "Der Vergleichssatz des Reviers ist leer",
  geo_object_without_place: "Geo-Objekt hat keinen gültigen Ort",
  no_research_candidates: "Keine Kandidaten für die Recherche",
  research_run_active: "Für diesen Umfang wartet oder läuft schon eine Recherche – erst ihr Ende abwarten",
  research_gate_closed: "Recherche erst nach bestandenem Navily-Test für weitere Landesteile",
};

/** The German text of a `?error=<reason>` a run action redirected with; null for none or an unknown reason. */
export function runScopeError(param: string | string[] | undefined): string | null {
  return typeof param === "string" && Object.hasOwn(RUN_SCOPE_REASON_LABELS, param)
    ? RUN_SCOPE_REASON_LABELS[param as RunScopeReason]
    : null;
}

/** Errors of the quality page besides refused runs (`?error=<code>`). */
export const QUALITY_ERROR_LABELS = {
  regression_gate_closed: "Nicht aktiviert – der Vergleich alt/neu besteht nicht (Gründe bei der Bewertung)",
  invalid_input: "Eingabe ungültig – bitte die Felder prüfen",
} as const;

/** The German text of a `?error=` on the quality page: a refused run or a `QUALITY_ERROR_LABELS` code. */
export function qualityPageError(param: string | string[] | undefined): string | null {
  if (typeof param !== "string") return null;
  return runScopeError(param) ?? (Object.hasOwn(QUALITY_ERROR_LABELS, param) ? QUALITY_ERROR_LABELS[param as keyof typeof QUALITY_ERROR_LABELS] : null);
}

export const queueStateLabel = (paused: boolean): string => (paused ? "Pausiert" : "Läuft");

const BUDGET_SERVICE_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  dataforseo: "DataForSEO",
  voyage: "Voyage",
  jina: "Jina",
  firecrawl: "Firecrawl",
};

/** Whether a pause is a budget stop (`pauseForBudget`, reason `budget:<service>`). */
export const isBudgetPause = (pause: { reason: string | null } | null): boolean => pause?.reason?.startsWith("budget:") ?? false;

/**
 * Why and until when a queue is paused, in German (UI-8): „Budget Anthropic erreicht, bis 21.10.26, 00:00 UTC“ for a budget stop,
 * „von Hand (a@b)“ for a pause from the jobs page.
 */
export function queuePauseText(pause: { reason: string | null; until: Date | null; by: string }): string {
  const until = pause.until
    ? `bis ${pause.until.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" })} UTC`
    : "ohne Ende";
  if (isBudgetPause(pause)) {
    const service = pause.reason!.slice("budget:".length);
    return `Budget ${BUDGET_SERVICE_LABELS[service] ?? service} erreicht, ${until}`;
  }
  if (pause.reason === "manual") return `von Hand (${pause.by}), ${until}`;
  return `${pause.reason ?? "ohne Grund"} (${pause.by}), ${until}`;
}

/* ---- M4: mentions, extraction runs, facts ---- */

/** The extraction state of a mention (`failed`: its unit failed for good; only a reprocess extracts it again). */
export const MENTION_EXTRACTION_STATUS_LABELS: Record<ExtractionStatus, string> = {
  pending: "Offen",
  done: "Ausgewertet",
  skipped: "Übersprungen (keine Fact-Ebene)",
  failed: "Fehlgeschlagen",
};

/** Notice of the review pages (`?notice=run_not_started`): the decision stands, a follow-up run did not start. */
export const RUN_NOT_STARTED_NOTICE =
  "Entscheidung gespeichert. Der Folgelauf konnte nicht gestartet werden (Fehler protokolliert) – bitte später von Hand starten.";

/** Where a fact comes from (`FactView.origin`). */
export const FACT_ORIGIN_LABELS = {
  text: "Text",
  computed: "Berechnung",
  review: "Prüfung",
  observed: "Beobachtung",
} as const;

/* ---- M5: consolidated profiles ---- */

export const CONFIDENCE_CLASS_LABELS: Record<ConfidenceClass, string> = { high: "hoch", medium: "mittel", low: "niedrig" };

/* ---- M4: model comparison ---- */

/** The map popup's line „Profil-Konfidenz“ of a place: the value with its class, „Profil ohne Konfidenz“ or „kein Profil“. */
export function profileConfidenceText(p: { profileConfidence?: unknown; profileClass?: unknown; hasProfile?: unknown }): string {
  if (typeof p.profileConfidence === "number") {
    const value = p.profileConfidence.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${value} (${CONFIDENCE_CLASS_LABELS[p.profileClass as ConfidenceClass] ?? String(p.profileClass)})`;
  }
  return p.hasProfile === true ? "Profil ohne Konfidenz" : "kein Profil";
}

/** Status of a package build (`deliveries.status`). */
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  valid: "Gültig",
  rejected: "Abgelehnt",
  unchanged: "Unverändert",
};

/** The validation checks of a package (spec 08, Teil B „Validierung“), in report order. */
export const CHECK_LABELS: Record<CheckName, string> = {
  json_schema: "Jede Datei entspricht ihrem JSON-Schema",
  ids: "IDs eindeutig und mit richtigem Präfix",
  references: "Jede referenzierte ID ist in derselben Lieferung (Fakt-Bezug in nearby desselben Spots)",
  spot_location: "Spot in der Bounding Box und höchstens 1,5 sm von Wasser",
  shelter: "Schutz: acht Sektoren 0–1, Häfen und Marinas belegt",
  limits: "Tiefgang und Länge im erlaubten Bereich",
  exclude_reason: "Ausgeschlossener Spot mit Grund",
  berth_months: "„Saisonal voll“ mit mindestens einem Monat",
  spot_duplicates: "Keine zwei Spots derselben Art näher als 150 m",
  verbatim_text: "Kein Text länger als 15 Wörter aus einer Quelle",
  image_attribution: "Bildnachweis nennt Luftbild- und Geländequelle",
  foreign_content: "Keine URL und kein Domainname in Texten und Namen",
  data_version: "Datenversion größer als die vorherige",
};

/** What the files of a package hold. */
export const CONTRACT_FILE_LABELS: Record<ContractFile, string> = {
  "manifest.json": "Manifest",
  "spots.json": "Spots",
  "regions.json": "Regionen",
  "coast.geojson": "Küste",
  "weather-points.json": "Wetterpunkte",
};

/** Why the next package would not deliver a place (place page, tab „Lieferung“). */
export const PREVIEW_OMISSION_LABELS: Record<PreviewOmission, string> = {
  no_name: "Der Ort hat keinen gültigen Namen.",
  no_state: "Der Ort hat keinen Stand.",
  incomplete_core: "Im Stand fehlen Schutzwerte oder die Ankerposition.",
  no_subdivision: "Der Ort gehört zu keinem Landesteil.",
  merged: "Der Ort ist zusammengelegt. Das nächste Paket liefert ihn mit „zusammengelegt in“ (mergedInto) den Ort, in den er aufgegangen ist, sofern das letzte Paket des Landesteils ihn enthielt.",
  merged_removed:
    "Der Ort ist zusammengelegt in einen Ort, den das nächste Paket des Landesteils nicht liefert (anderer Landesteil oder ausgelassen). Das Paket meldet ihn als entfernt.",
  not_in_package: "Der Ort ist kein Spot des Pakets (nicht bestätigt oder beendet).",
};

/** Why „Mit Ort zusammenlegen“ was refused (`?mergeError=`). */
export const MERGE_ERROR_LABELS: Record<MergeRefusal, string> = {
  self: "Ein Ort kann nicht mit sich selbst zusammengelegt werden.",
  not_valid: "Beide Orte müssen gültige, bestätigte Orte sein – einer ist beendet, verworfen oder schon zusammengelegt.",
  across_subdivisions: "Die Orte liegen in verschiedenen Landesteilen – bitte das Zusammenlegen über Landesteilgrenzen bestätigen.",
};

/** The German text of a `?mergeError=`; null for none or an unknown reason. */
export function mergeError(param: string | string[] | undefined): string | null {
  return typeof param === "string" && Object.hasOwn(MERGE_ERROR_LABELS, param) ? MERGE_ERROR_LABELS[param as MergeRefusal] : null;
}

/** Why a header status change of a place was refused (`?statusError=`, gesamt review UI-3). */
export const PLACE_STATUS_ERROR_LABELS: Record<PlaceStatusRefusal, string> = {
  open_task: "Der Ort hat eine offene Prüfung – dort entscheiden, mit ihrem ganzen Kontext.",
  changed: "Der Status hat sich inzwischen geändert – bitte neu prüfen.",
  unchanged: "Der Ort hat diesen Status schon.",
  not_valid: "Der Ort ist beendet oder zusammengelegt.",
};

/** The German text of a `?statusError=`; null for none or an unknown reason. */
export function placeStatusError(param: string | string[] | undefined): string | null {
  return typeof param === "string" && Object.hasOwn(PLACE_STATUS_ERROR_LABELS, param)
    ? PLACE_STATUS_ERROR_LABELS[param as PlaceStatusRefusal]
    : null;
}

/* ---- Navily comparison ---- */

/** The compared attributes (spec 10 „Existenz, Position, Schutz je Sektor, Tiefe, Grund, Bojen, Versorgung, Taverne“). */
export const COMPARISON_ATTRIBUTE_LABELS: Record<ComparisonAttribute, string> = {
  existence: "Existenz",
  position: "Position",
  "shelter.N": "Schutz N",
  "shelter.NE": "Schutz NO",
  "shelter.E": "Schutz O",
  "shelter.SE": "Schutz SO",
  "shelter.S": "Schutz S",
  "shelter.SW": "Schutz SW",
  "shelter.W": "Schutz W",
  "shelter.NW": "Schutz NW",
  depth: "Tiefe",
  seabed: "Grund",
  "mooring.buoys": "Bojen",
  "services.water": "Versorgung: Wasser",
  "highlight.supply": "Versorgung: Einkauf",
  "highlight.food": "Taverne",
};

/** Decisions on a `comparison_deviation` task, in button order (keys 1–3). */
export const COMPARISON_DECISION_LABELS = {
  own_correct: "Eigener Wert stimmt",
  navily_correct: "Navily stimmt (eigener Wert falsch)",
  unclear: "Unklar",
} as const;

/** Outcomes of the comparison against Navily (`comparison_results.result`). */
export const COMPARISON_RESULT_LABELS: Record<ComparisonResultValue, string> = {
  match: "stimmt",
  deviation: "weicht ab",
  not_at_navily: "bei Navily nicht vorhanden",
  deviation_confirmed_own: "Abweichung: eigener Wert stimmt",
  deviation_confirmed_navily: "Abweichung: Navily stimmt",
  unclear: "unklar",
};

/** How an outcome was recorded (`comparison_results.method`). */
export const COMPARISON_METHOD_LABELS: Record<ComparisonMethod, string> = {
  manual: "von Hand",
  proposal_confirmed: "Vorschlag bestätigt",
  proposal_auto: "Vorschlag maschinell",
  review: "Prüfung",
};

/** Where a place's website came from (spec 15 C). */
export const WEBSITE_ORIGIN_LABELS: Record<"osm" | "wikidata" | "serp", string> = {
  osm: "OSM",
  wikidata: "Wikidata",
  serp: "Google-Suche",
};

/** Reasons a research page was not fetched (`research_fetches.reason`), for „nicht geholt: …“; unknown ones are shown as stored. */
export const RESEARCH_FETCH_REASON_LABELS: Record<string, string> = {
  forbidden_domain: "gesperrte Domain",
  robots: "robots.txt verbietet es",
  too_large: "Seite zu groß",
  blocked_address: "Adresse gesperrt",
};
