export const GAP_REASONS = ["no_water", "origin_unresolved", "no_bathymetry", "no_anchor_area", "no_seabed_coverage"] as const;
export type GapReason = (typeof GAP_REASONS)[number];
/** An attribute without a value and why; stored in `outputs.gaps` of the computation it belongs to. */
export type Gap = { attribute: string; reason: GapReason };
