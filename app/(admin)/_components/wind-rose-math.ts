import { SECTOR_CENTER_DEG, type Sector } from "@/lib/domain/facts/schema-types";

/** Half the width of a compass sector in degrees. */
const HALF_SECTOR_DEG = 22.5;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const fmt = (n: number) => String(Number(n.toFixed(2)));

/** A sector's wedge: bearings (degrees, clockwise from north) and radius `value × radius` (value clamped to 0–1). */
export function wedge(sector: Sector, value: number, radius: number): { startDeg: number; endDeg: number; r: number } {
  const center = SECTOR_CENTER_DEG[sector];
  return { startDeg: center - HALF_SECTOR_DEG, endDeg: center + HALF_SECTOR_DEG, r: clamp01(value) * radius };
}

/** SVG point at `bearingDeg` (north up, clockwise) and distance `r` from (cx, cy). */
function polar(cx: number, cy: number, r: number, bearingDeg: number): [number, number] {
  const rad = (bearingDeg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

/** The wedge of `sector` as an SVG path around (cx, cy); empty for a zero radius. */
export function wedgePath(sector: Sector, value: number, radius: number, cx: number, cy: number): string {
  const { startDeg, endDeg, r } = wedge(sector, value, radius);
  if (r === 0) return "";
  const [x1, y1] = polar(cx, cy, r, startDeg);
  const [x2, y2] = polar(cx, cy, r, endDeg);
  return `M ${fmt(cx)} ${fmt(cy)} L ${fmt(x1)} ${fmt(y1)} A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x2)} ${fmt(y2)} Z`;
}

/** Position of a label at `bearingDeg`, `r` from (cx, cy). */
export const labelPosition = polar;

/** Colour of a shelter value: red (0) through yellow to green (1). */
export function shelterColor(value: number): string {
  return `hsl(${Math.round(clamp01(value) * 120)} 75% 45%)`;
}
