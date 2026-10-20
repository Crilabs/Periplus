import type { CameraDetails } from "./render-plan";

/*
 * German labels of an image's camera and slot (spec 13), shared by the review panel and the place's image tab.
 */

const COMPASS = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"] as const;

/** The German 8-point compass name of a bearing (clockwise from north): N, NO, O, SO, S, SW, W, NW. */
export function compassPoint(bearingDeg: number): (typeof COMPASS)[number] {
  const normalised = ((bearingDeg % 360) + 360) % 360;
  return COMPASS[Math.round(normalised / 45) % 8]!;
}

const whole = (n: number) => Math.round(n).toLocaleString("de-DE");

/**
 * „Aufnahme aus <Himmelsrichtung> (<Blickrichtung>°), <Höhe> m Höhe, Neigung <Neigung>°“. The compass point names the
 * side the camera stands on as seen from the place (opposite the view bearing: a camera south of the bay looking north
 * takes the shot „aus S“); the degrees are the view bearing, the direction the camera looks.
 */
export function cameraLine(camera: Pick<CameraDetails, "viewBearingDeg" | "heightM" | "tiltDeg">): string {
  const bearing = ((Math.round(camera.viewBearingDeg) % 360) + 360) % 360;
  return `Aufnahme aus ${compassPoint(camera.viewBearingDeg + 180)} (${bearing}°), ${whole(camera.heightM)} m Höhe, Neigung ${whole(camera.tiltDeg)}°`;
}

/** „Titelbild“ for slot `title`, „Weitere Ansicht <n>“ for `view-<n>`, else the slot itself. */
export function slotLabel(slot: string): string {
  if (slot === "title") return "Titelbild";
  const view = /^view-(\d+)$/.exec(slot);
  return view ? `Weitere Ansicht ${view[1]}` : slot;
}
