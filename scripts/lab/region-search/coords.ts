/*
 * Coordinates as web pages write them (spec 5C/5D). Only pairs inside the eastern Mediterranean window count; the
 * precision follows the notation (a whole minute is ±900 m, a decimal degree with four places ±10 m).
 */

export type Coord = { lat: number; lon: number; precisionM: number; text: string };

const LAT = { min: 30, max: 46 };
const LON = { min: 15, max: 30 };

const DEG = "[°º]";
const MIN = "['′’]";
const SEC = '["″]';
const SP = "\\s*";

// 37°31'N 23°27'E · 37° 31.5' N, 23° 27.1' E · 37°31'12"N 23°27'06"E
const DMS = new RegExp(
  `(\\d{1,2})${SP}${DEG}${SP}(\\d{1,2}(?:[.,]\\d+)?)${SP}${MIN}?${SP}(?:(\\d{1,2}(?:[.,]\\d+)?)${SP}${SEC})?${SP}([NS])[,;\\s]*` +
    `(\\d{1,3})${SP}${DEG}${SP}(\\d{1,2}(?:[.,]\\d+)?)${SP}${MIN}?${SP}(?:(\\d{1,2}(?:[.,]\\d+)?)${SP}${SEC})?${SP}([EW])`,
  "g",
);
// N37 31.500 E023 27.100 · N 37°31.5 E 23°27.1
const LETTER_FIRST = new RegExp(
  `([NS])${SP}(\\d{1,2})${SP}${DEG}?${SP}(\\d{1,2}(?:[.,]\\d+)?)${MIN}?[,;\\s]*([EW])${SP}(\\d{1,3})${SP}${DEG}?${SP}(\\d{1,2}(?:[.,]\\d+)?)${MIN}?`,
  "g",
);
// 37.5167, 23.45 · 37,5167° N 23,4500° E · 37.5167°N, 23.4500°E
const DECIMAL = new RegExp(`(\\d{2}[.,]\\d{2,})${SP}${DEG}?${SP}([NS])?[,;\\s]+(\\d{2}[.,]\\d{2,})${SP}${DEG}?${SP}([EW])?`, "g");

const num = (s: string): number => Number(s.replace(",", "."));
const decimals = (s: string): number => (s.includes(".") || s.includes(",") ? s.split(/[.,]/)[1]!.length : 0);

function minutePrecision(minutes: string, seconds: string | undefined): number {
  if (seconds !== undefined) return 30;
  const d = decimals(minutes);
  return d === 0 ? 900 : d === 1 ? 90 : d === 2 ? 10 : 1;
}

function inWindow(lat: number, lon: number): boolean {
  return lat >= LAT.min && lat <= LAT.max && lon >= LON.min && lon <= LON.max;
}

function dms(deg: string, min: string, sec: string | undefined, sign: number): number {
  return sign * (num(deg) + num(min) / 60 + (sec !== undefined ? num(sec) / 3600 : 0));
}

function* matches(text: string): Generator<{ index: number; coord: Coord }> {
  for (const m of text.matchAll(DMS)) {
    const lat = dms(m[1]!, m[2]!, m[3], m[4] === "S" ? -1 : 1);
    const lon = dms(m[5]!, m[6]!, m[7], m[8] === "W" ? -1 : 1);
    if (inWindow(lat, lon)) yield { index: m.index, coord: { lat, lon, precisionM: Math.max(minutePrecision(m[2]!, m[3]), minutePrecision(m[6]!, m[7])), text: m[0] } };
  }
  for (const m of text.matchAll(LETTER_FIRST)) {
    const lat = dms(m[2]!, m[3]!, undefined, m[1] === "S" ? -1 : 1);
    const lon = dms(m[5]!, m[6]!, undefined, m[4] === "W" ? -1 : 1);
    if (inWindow(lat, lon)) yield { index: m.index, coord: { lat, lon, precisionM: Math.max(minutePrecision(m[3]!, undefined), minutePrecision(m[6]!, undefined)), text: m[0] } };
  }
  for (const m of text.matchAll(DECIMAL)) {
    const lat = num(m[1]!) * (m[2] === "S" ? -1 : 1);
    const lon = num(m[3]!) * (m[4] === "W" ? -1 : 1);
    const places = Math.min(decimals(m[1]!), decimals(m[3]!));
    if (inWindow(lat, lon) && places >= 2) yield { index: m.index, coord: { lat, lon, precisionM: 10 ** Math.max(0, 5 - places), text: m[0] } };
  }
}

/** All coordinate pairs of a text in text order; overlapping matches of different notations count once. */
export function coordinatesIn(text: string): Coord[] {
  const found = [...matches(text)].sort((a, b) => a.index - b.index);
  const out: Coord[] = [];
  let end = -1;
  for (const { index, coord } of found) {
    if (index < end) continue;
    out.push(coord);
    end = index + coord.text.length;
  }
  return out;
}

/** The first coordinate pair of a short text, else null. */
export function parseCoordinate(text: string): Coord | null {
  return coordinatesIn(text)[0] ?? null;
}
