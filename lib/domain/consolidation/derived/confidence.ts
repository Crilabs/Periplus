import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { AttributeProvenance } from "../types";
import { attributeIn, roundTo } from "../weights";

/*
 * Profile confidence (spec 07 "gewichteter Mittelwert über die Kernattribute (Schutz, Tiefe, Grund, Ausschluss)"),
 * weights in `cfg.profileConfidence`.
 */

const GROUPS = ["shelter", "depth", "seabed", "exclude"] as const;

/**
 * Groups `shelter`, `depth`, `seabed` and `exclude`, each the mean confidence over its attributes in
 * `cfg.profileConfidenceGroups` (v1: `shelter.*`; `depth.min/max/anchoring_min/anchoring_max`; `seabed`; `exclude` =
 * the confidence of `prohibitions`, ruling M5-P5); a group without values drops out and the weights of the others are
 * renormalized. No group → null.
 */
export function profileConfidence(provenance: Record<string, AttributeProvenance>, cfg: ConsolidationConfig): number | null {
  const keys = Object.keys(provenance).sort();
  const mean = (selected: string[]) =>
    selected.length === 0 ? null : selected.reduce((s, k) => s + provenance[k].confidence, 0) / selected.length;
  let weighted = 0;
  let weights = 0;
  for (const key of GROUPS) {
    const v = mean(keys.filter((k) => attributeIn(k, cfg.profileConfidenceGroups[key])));
    if (v === null) continue;
    weighted += cfg.profileConfidence[key] * v;
    weights += cfg.profileConfidence[key];
  }
  return weights > 0 ? roundTo(weighted / weights, cfg.precision) : null;
}
