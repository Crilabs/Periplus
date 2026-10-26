import type { ReviewKind, ReviewStatus } from "@/lib/db/schema";
import type { Tone } from "../_components/ui";

/** What a task of each kind means, in one or two sentences (list filter and task header). */
export const REVIEW_KIND_HELP: Record<ReviewKind, string> = {
  place_candidate:
    "Ein Ort oder Name, bei dem die Pipeline unsicher ist: ein Ortskandidat, zwei Geo-Objekte, die dasselbe sein könnten, oder ein Name aus Texten ohne passendes Objekt.",
  failed_job:
    "Ein Job ist nach allen Versuchen gescheitert, oder die Zusammenfassung eines Profils blieb nach allen Versuchen leer.",
  comparison_deviation: "Ein eigener Wert wich beim Qualitätsvergleich von der Vergleichsquelle ab.",
  place_image: "KI-Titelbild eines Orts prüfen: Rendering und Illustration vergleichen, freigeben, neu erzeugen oder kein Bild.",
  research_conflict:
    "Die Recherche bestätigt diesen Ort, aber er ist nicht in der Referenz. Entscheiden, ob es ein Liegeplatz ist.",
};

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  open: "Offen",
  decided: "Entschieden",
  dismissed: "Hinfällig",
};

export const REVIEW_STATUS_TONES: Record<ReviewStatus, Tone> = {
  open: "warn",
  decided: "ok",
  dismissed: "neutral",
};
