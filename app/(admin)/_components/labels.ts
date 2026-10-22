import type { ConsolidationSkipReason } from "@/lib/domain/consolidation/skipped";
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
  ReviewKind,
  RunKind,
  RunScopeType,
  RunStageStatus,
  RestrictedKind,
  RunStatus,
  SourceOrigin,
  SourceStatus,
} from "@/lib/db/schema";
import type { ChangeSeverity, ChangeType, SummaryStatus } from "@/lib/db/schema/profiles";
import type { DeliveryStatus } from "@/lib/db/schema/deliveries";
import type { ComparisonAttribute, ComparisonMethod, ComparisonResultValue, MetricKey } from "@/lib/db/schema/quality";
import type { ChangeEntry, ContractFile } from "@/contract";
import type { CheckName } from "@/lib/domain/delivery/validate";
import type { PreviewOmission } from "@/lib/domain/delivery/view";
import type { MergeRefusal } from "@/lib/domain/place-merge";
import type { PlaceStatusRefusal } from "@/lib/domain/place-status";
import type { ConfidenceClass, ConflictResolution, ProvenanceOrigin } from "@/lib/domain/consolidation/types";
import type { VersionDiff, VersionNote } from "@/lib/domain/profile-timeline";
import type { GapReason } from "@/lib/domain/geometry/gaps";
import type { CrawlRules } from "@/lib/domain/sources/crawl-rules";
import type { NAME_AFFIX_HINTS } from "@/lib/config/schemas";
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
  country: "Land",
  admin_region: "Verwaltungsregion",
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
  place_website: "Website des Ortes",
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
  subdivision_without_coast_tiles: "Landesteil hat noch keine Küstenkacheln – zuerst „Gazetteer aufbauen“",
  tile_without_subdivision: "Kachel gehört zu keinem Landesteil – Suchsprachen unbekannt",
  bathymetry_missing: "Bathymetrie fehlt – zuerst „Datensätze laden“",
  land_missing: "Landpolygone fehlen – zuerst die Landpolygone importieren",
  place_not_computable: "Ort wird nicht berechnet (beendet, zusammengeführt, verworfen oder ohne Kachel)",
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
  unknown_area: "Ein Revier-Schlüssel ist kein Laufumfang mehr – einen Landesteil angeben",
  versions_not_current: "Eine Dokumentversion gibt es nicht oder sie ist nicht mehr aktuell",
  unknown_comparison: "Diesen Modellvergleich gibt es nicht",
  comparison_without_units: "Der Modellvergleich hat keine Einheiten – zuerst Texte auswerten",
  comparison_started: "Für diesen Modellvergleich gibt es bereits einen Lauf",
  comparison_over_budget: "Die Kostenschätzung passt heute nicht mehr ins Anthropic-Budget (config/budgets.json) – morgen erneut starten",
  geo_object_not_consolidatable: "Geo-Objekt ist unbekannt, beendet, zusammengeführt oder hat keine Fact-Ebene",
  comparison_set_empty: "Der Vergleichssatz des Reviers ist leer",
  geo_object_without_place: "Geo-Objekt hat keinen gültigen Ort",
  measurement_label_taken: "Bezeichnung schon vergeben",
  measurement_label_invalid: "Bezeichnung fehlt oder ist länger als 40 Zeichen",
  measurement_window_empty: "Der Zeitraum ist leer – „von“ muss vor „bis“ liegen",
  measurement_from_required: "Erste Messung des Reviers: „von“ angeben (Beginn des ersten Pilot-Laufs)",
  measurement_running: "Für das Revier wartet oder läuft schon eine Messung – erst ihr Ende abwarten",
  evaluation_candidate_missing: "Regelversion oder Modell mit Prompt-Version angeben",
  evaluation_candidate_unknown: "Diese Regelversion, dieses Modell oder diese Prompt-Version gibt es in config/ nicht",
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
  forbidden_domain: "Diese Domain ist gesperrt (Navily, Google) und kann keine Quelle sein",
  invalid_source: "Domain, Name und Typ angeben",
  not_approved: "Nur eine freigegebene Quelle kann pausiert werden",
  not_paused: "Nur eine pausierte Quelle kann fortgesetzt werden",
  not_endable: "Nur eine freigegebene oder pausierte Quelle kann beendet werden",
  source_ended: "Die Quelle ist beendet",
  upload_not_allowed: "PDFs lassen sich nur bei freigegebenen, vorgeschlagenen oder pausierten Quellen hochladen",
  upload_run_not_started:
    "Die Datei ist archiviert, ihre Verarbeitung startete aber nicht (z. B. Job-Warteschlange nicht erreichbar). Dieselbe Datei erneut hochladen startet sie; sie wird nicht doppelt archiviert",
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

export const MATCH_KIND_LABELS: Record<MatchKind, string> = {
  deterministic: "Namensabgleich",
  model: "Modell",
  review: "Prüfung",
  bound: "Website des Ortes",
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

/** Why a run skipped its consolidation (the stored marker, ruling M5-H-R2). */
export const CONSOLIDATION_SKIP_REASON_LABELS: Record<ConsolidationSkipReason, string> = {
  quote_fidelity: "Belegtreue unter 100 %",
  run_failed: "Lauf vor der Konsolidierung fehlgeschlagen",
  run_ended: "Lauf vor der Konsolidierung beendet",
};

/** Notice of the review pages (`?notice=run_not_started`): the decision stands, a follow-up run did not start. */
export const RUN_NOT_STARTED_NOTICE =
  "Entscheidung gespeichert. Der Folgelauf konnte nicht gestartet werden (Fehler protokolliert) – bitte später von Hand starten.";

/** Notices of the run page (`?notice=`) after „Belegtreue neu prüfen“ or „Konsolidierung nachholen“. */
export const RUN_NOTICE_LABELS: Record<string, string> = {
  consolidation_blocked: "Konsolidierung nicht nachgeholt: Belegtreue weiter unter 100 % – zuerst „Belegtreue neu prüfen“.",
  consolidation_no_targets: "Konsolidierung nicht nachgeholt: kein Geo-Objekt des Laufs lässt sich konsolidieren.",
  consolidation_not_started: "Die Konsolidierung konnte nicht gestartet werden (Fehler protokolliert). Bitte später erneut versuchen.",
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

/* ---- M5: consolidated profiles ---- */

/** Where a profile value comes from (`AttributeProvenance.origin`; ruling M5-P13, plus `rule` for the harbour floor). */
export const PROVENANCE_ORIGIN_LABELS: Record<ProvenanceOrigin, string> = {
  ...FACT_ORIGIN_LABELS,
  rule: "Regel",
  gazetteer: "Gazetteer",
  derived: "Abgeleitet",
};

export const CONFIDENCE_CLASS_LABELS: Record<ConfidenceClass, string> = { high: "hoch", medium: "mittel", low: "niedrig" };

/** The admin's answer to a conflict, as the profile records it on the conflict note. */
export const CONFLICT_RESOLUTION_LABELS: Record<ConflictResolution, string> = {
  seasonal: "Beide gelten (saisonal)",
  left_open: "Offen gelassen",
  decided: "Für einen Wert entschieden",
};

/**
 * Why a profile attribute has no value (`ProfileGap.reason`; ruling M5-P13): the computation's gap reason, or one of
 * the profile's own reasons.
 */
export const PROFILE_GAP_REASON_LABELS: Record<string, string> = {
  ...GAP_REASON_LABELS,
  no_facts: "Keine Facts",
  too_few_parts: "Zu wenige Teilwerte",
  no_category: "Keine Kategorie",
  in_review: "In Prüfung (unsichere Änderung)",
};

/** The label of a gap reason; the reason itself when unknown. */
export const profileGapReasonLabel = (reason: string): string => PROFILE_GAP_REASON_LABELS[reason] ?? reason;

/** Status of a profile summary. */
export const SUMMARY_STATUS_LABELS: Record<SummaryStatus, string> = { ok: "erzeugt", rejected: "verworfen", empty: "leer (in Prüfung)" };

/** Change event types of the change feed (spec 07). */
export const CHANGE_TYPE_LABELS: Record<ChangeType, string> = {
  new_attribute: "Neu",
  changed: "Geändert",
  uncertain: "Unsicher",
  expired: "Abgelaufen",
  place_new: "Ort neu",
  place_abandoned: "Ort aufgegeben",
  geo_changed: "Gazetteer geändert",
};

export const SEVERITY_LABELS: Record<ChangeSeverity, string> = { info: "Info", notable: "Bemerkenswert", safety: "Sicherheit" };

/** Kinds of a difference between two profile versions. */
export const VERSION_DIFF_LABELS: Record<VersionDiff["kind"], string> = {
  added: "neu",
  removed: "entfallen",
  changed: "geändert",
  class: "Konfidenzklasse",
};

/** Why a version without value or class changes exists (`versionNotes`). */
export const VERSION_NOTE_LABELS: Record<VersionNote, string> = {
  expired: "Ein Wert ist abgelaufen oder wieder aktuell (Konfidenz angepasst).",
  gone_sources: "Quellen eines Werts sind verschwunden oder wieder da.",
  conflict: "Ein Konflikt wurde entschieden, ist neu oder ist entfallen.",
  other: "Nur Herkunftsangaben haben sich geändert.",
};

/** Notices of the profile tab (`?notice=`) after „Eintrag entfernen“. */
export const PROFILE_NOTICE_LABELS: Record<string, string> = {
  entry_removed: "Eintrag entfernt. Das Profil wird neu berechnet.",
  entry_removed_no_run: "Eintrag entfernt. Der Folgelauf konnte nicht gestartet werden – bitte „Profil neu berechnen“.",
  changed: "Das Profil hat sich geändert – bitte neu laden.",
  error: "Der Eintrag kann nicht entfernt werden.",
};

/** Why an attempt at a profile summary failed. */
export const SUMMARY_FAILURE_LABELS: Record<string, string> = {
  copied: "15 Wörter wörtlich aus dem Archiv",
  sentences: "Satzzahl verfehlt",
  invalid: "Antwort ungültig, abgeschnitten oder abgelehnt",
};

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
  rating_not_in_sample: "Diese Abweichung gehört nicht zur Stichprobe des Vergleichs – Bewertung nicht gespeichert",
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
  references: "Jede referenzierte ID ist in derselben Lieferung",
  spot_location: "Spot in der Bounding Box und höchstens 1,5 sm von Wasser",
  shelter: "Schutz: acht Sektoren 0–1, Häfen und Marinas belegt",
  limits: "Tiefgang und Länge im erlaubten Bereich",
  exclude_reason: "Ausgeschlossener Spot mit Grund",
  berth_months: "„Saisonal voll“ mit mindestens einem Monat",
  low_confidence_note: "Geringe Konfidenz mit Hinweis „wenig belegt“",
  highlight_selected: "Highlight nur an Spots, die es ausgewählt haben",
  spot_duplicates: "Keine zwei Spots derselben Art näher als 150 m",
  highlight_duplicates: "Keine zwei Highlights gleichen Namens näher als 500 m",
  verbatim_text: "Kein Text länger als 15 Wörter aus einer Quelle",
  image_attribution: "Bildnachweis nennt Luftbild- und Geländequelle",
  foreign_content: "Keine fremden Inhalte",
  data_version: "Datenversion größer als die vorherige",
  changes_complete: "changes.json enthält genau die geänderten Objekte",
};

/** Events of `changes.json`. */
export const CHANGE_EVENT_LABELS: Record<ChangeEntry["event"], string> = {
  created: "Neu",
  updated: "Geändert",
  excluded: "Ausgeschlossen",
  merged: "Zusammengelegt",
  removed: "Entfernt",
};

/** Object types of `changes.json`. */
export const CHANGE_OBJECT_TYPE_LABELS: Record<ChangeEntry["objectType"], string> = {
  spot: "Spot",
  highlight: "Highlight",
  region: "Region",
};

/** What the files of a package hold. */
export const CONTRACT_FILE_LABELS: Record<ContractFile, string> = {
  "manifest.json": "Manifest",
  "spots.json": "Spots",
  "highlights.json": "Highlights",
  "regions.json": "Regionen",
  "coast.geojson": "Küste",
  "weather-points.json": "Wetterpunkte",
  "changes.json": "Änderungen",
};

/** Why the next package would not deliver a place (place page, tab „Lieferung“). */
export const PREVIEW_OMISSION_LABELS: Record<PreviewOmission, string> = {
  no_name: "Der Ort hat keinen gültigen Namen.",
  no_profile: "Der Ort hat kein Profil.",
  shelter_incomplete: "Die Schutzwerte sind unvollständig oder ohne Herkunft.",
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

/* ---- M7: quality measurement ---- */

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

/** The metrics of a quality snapshot. */
export const METRIC_LABELS: Record<MetricKey, string> = {
  coverage: "Abdeckung",
  coverage_navily: "Abdeckung (Navily-Vergleichssatz)",
  multi_source: "Mehrbefund (≥ 2 Quellen)",
  multi_document: "Mehrbefund (≥ 2 Dokumente)",
  fact_precision: "Fact-Präzision",
  quote_fidelity: "Belegtreue",
  shelter_confidence: "Schutz-Konfidenz",
  route_reconstruction: "Routen-Rekonstruktion",
  cost_per_place: "Kosten je Ort",
  review_minutes: "Review-Aufwand",
  review_minutes_per_100: "Review-Aufwand je 100 Orte",
  highlight_share: "Anteil Orte mit Highlight",
  recent_observation_share: "Anteil Orte mit aktueller Beobachtung",
  places_per_tile: "Orte je Kachel",
  place_confirmation: "Automatisch bestätigte Orte",
  place_websites: "Marinas und Häfen mit Website",
  marina_services: "Marinas mit Kraftstoff und Wasser",
};

/** The rule that confirmed a place automatically (spec 17). */
export const AUTO_RULE_LABELS: Record<string, string> = {
  alone: "Revierführer/Behörde",
  pair: "Zwei unabhängige Berichte",
  own_website: "Eigene Website",
  commercial_port: "Quelle: gewerblicher Hafen",
  osm_commercial: "OSM: gewerblicher Hafen",
};

/** Where a place's website came from (spec 15 C). */
export const WEBSITE_ORIGIN_LABELS: Record<"osm" | "wikidata" | "serp", string> = {
  osm: "OSM",
  wikidata: "Wikidata",
  serp: "Google-Suche",
};
