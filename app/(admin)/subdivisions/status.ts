import type { SubdivisionStatus } from "@/lib/domain/subdivisions/view";
import type { Tone } from "../_components/ui";

/** Badge tone of each subdivision status („Länder und Landesteile“). */
export const SUBDIVISION_STATUS_TONES: Record<SubdivisionStatus, Tone> = {
  "nicht begonnen": "neutral",
  teilweise: "warn",
  läuft: "accent",
  aufgebaut: "ok",
  fehlgeschlagen: "danger",
  ausgeschlossen: "neutral",
};
