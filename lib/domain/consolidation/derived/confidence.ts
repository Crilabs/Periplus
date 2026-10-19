import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { AttributeProvenance } from "../types";
import { roundTo } from "../weights";

/*
 * Profile confidence (spec 07 "gewichteter Mittelwert über die Kernattribute (Schutz, Tiefe, Grund, Ausschluss)"),
 * weights in `cfg.profileConfidence`.
 */

const DEPTH = ["depth.min", "depth.max", "depth.anchoring_min", "depth.anchoring_max"];

/**
 * Groups `shelter` (mean over `shelter.*`), `depth` (mean over `depth.min/max/anchoring_min/anchoring_max`),
 * `seabed` and `exclude` (the confidence of `prohibitions`, ruling M5-P5); a group without values drops out and the
 * weights of the others are renormalized. No group → null.
 */
export function profileConfidence(provenance: Record<string, AttributeProvenance>, cfg: ConsolidationConfig): number | null {
  const keys = Object.keys(provenance).sort();
  const mean = (selected: string[]) =>
    selected.length === 0 ? null : selected.reduce((s, k) => s + provenance[k].confidence, 0) / selected.length;
  const groups: Record<keyof ConsolidationConfig["profileConfidence"], number | null> = {
    shelter: mean(keys.filter((k) => k.startsWith("shelter."))),
    depth: mean(keys.filter((k) => DEPTH.includes(k))),
    seabed: mean(keys.filter((k) => k === "seabed")),
    exclude: mean(keys.filter((k) => k === "prohibitions")),
  };
  let weighted = 0;
  let weights = 0;
  for (const key of ["shelter", "depth", "seabed", "exclude"] as const) {
    const v = groups[key];
    if (v === null) continue;
    weighted += cfg.profileConfidence[key] * v;
    weights += cfg.profileConfidence[key];
  }
  return weights > 0 ? roundTo(weighted / weights, cfg.precision) : null;
}
