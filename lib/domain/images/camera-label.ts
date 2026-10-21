import type { PlaceKind } from "@/lib/db/schema";
import { compositionFor, type CompositionInput } from "./light";
import type { CameraDetails } from "./render-plan";

/*
 * German labels of an image's type, camera, slot and points (spec 13), shared by the review panel and the place's
 * image tab.
 */

const KIND_LABELS: Record<PlaceKind, string> = { anchorage: "Ankerplatz", mooring_field: "Bojenfeld", marina: "Marina", port: "Hafen" };

/**
 * What an image of the place shows, from the composition the generator uses (`compositionFor`) and the place kind:
 * „Ankerplatz“, „Bojenfeld“, „Marina“, „Hafen“, or „Ankerplatz bei einem Ort – <Ortsname>“ for the near-town
 * composition (`townName` null: „ohne Namen“).
 */
export function imageTypeLabel(place: CompositionInput, townName: string | null): string {
  if (compositionFor(place) === "near_town") return `Ankerplatz bei einem Ort – ${townName ?? "ohne Namen"}`;
  return KIND_LABELS[place.kind];
}

/** „<Breite>, <Länge>“ with five decimals, as the place page shows a point. */
export const pointLabel = (p: { lon: number; lat: number }): string => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

const COMPASS = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"] as const;

/** The German 8-point compass name of a bearing (clockwise from north): N, NO, O, SO, S, SW, W, NW. */
export function compassPoint(bearingDeg: number): (typeof COMPASS)[number] {
  const normalised = ((bearingDeg % 360) + 360) % 360;
  return COMPASS[Math.round(normalised / 45) % 8]!;
}

const whole = (n: number) => Math.round(n).toLocaleString("de-DE");

/**
 * „Aufnahme von <Kameraseite>, Blick nach <Blickrichtung> (<Blickrichtung in Grad>°), <Höhe> m Höhe, Neigung <Neigung>°“.
 * The camera side is the compass point opposite the view bearing (a camera south of the bay looking north: „von S“),
 * the view direction the compass point of the bearing itself.
 */
export function cameraLine(camera: Pick<CameraDetails, "viewBearingDeg" | "heightM" | "tiltDeg">): string {
  const bearing = ((Math.round(camera.viewBearingDeg) % 360) + 360) % 360;
  return `Aufnahme von ${compassPoint(camera.viewBearingDeg + 180)}, Blick nach ${compassPoint(camera.viewBearingDeg)} (${bearing}°), ${whole(camera.heightM)} m Höhe, Neigung ${whole(camera.tiltDeg)}°`;
}

/** „Titelbild“ for slot `title`, „Weitere Ansicht <n>“ for `view-<n>`, else the slot itself. */
export function slotLabel(slot: string): string {
  if (slot === "title") return "Titelbild";
  const view = /^view-(\d+)$/.exec(slot);
  return view ? `Weitere Ansicht ${view[1]}` : slot;
}
