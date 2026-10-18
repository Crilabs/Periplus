import type { ReviewKind, RunKind, RunScopeType, RunStageStatus, RunStatus } from "@/lib/db/schema";

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
  coast_tile_without_area: "Küstenkachel ohne Gebiet",
  uncertain_change: "Unsichere Änderung",
  comparison_deviation: "Vergleichsabweichung",
};

export const queueStateLabel = (paused: boolean): string => (paused ? "Pausiert" : "Läuft");
