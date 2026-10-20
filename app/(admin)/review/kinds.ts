import type { ReviewKind, ReviewStatus } from "@/lib/db/schema";
import type { Tone } from "../_components/ui";

/** What a task of each kind means, in one or two sentences (list filter and task header). */
export const REVIEW_KIND_HELP: Record<ReviewKind, string> = {
  source_approval:
    "Die Quellensuche hat eine Website gefunden, die noch nicht gecrawlt wird. Erst nach der Freigabe holt die Pipeline Dokumente von ihr.",
  place_candidate:
    "Ein Ort oder Name, bei dem die Pipeline unsicher ist: ein Ortskandidat, zwei Geo-Objekte, die dasselbe sein könnten, oder ein Name aus Texten ohne passendes Objekt.",
  conflict:
    "Für dasselbe Attribut gibt es zwei Werte, die sich zeitlich nicht ordnen lassen und ähnlich schwer wiegen. Das Profil zeigt bis zur Entscheidung Wert A.",
  failed_job:
    "Ein Job ist nach allen Versuchen gescheitert, oder die Zusammenfassung eines Profils blieb nach allen Versuchen leer.",
  coast_tile_without_area:
    "Entfallen (Teil-Spec 14): Früher wurde hier einer Küstenkachel ein Revier zugeordnet. Heute gehört jede Küstenkachel zu einem Landesteil.",
  uncertain_change:
    "Ein neuer Wert weicht vom Profil ab, ist aber zu schwach belegt (zu wenige unabhängige Quellen, keine besonders gewichtige). Das Profil behält bis zur Entscheidung den bisherigen Wert.",
  comparison_deviation: "Ein eigener Wert wich beim Qualitätsvergleich von der Vergleichsquelle ab.",
  place_image: "KI-Titelbild eines Orts prüfen: Rendering und Illustration vergleichen, freigeben, neu erzeugen oder kein Bild.",
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
