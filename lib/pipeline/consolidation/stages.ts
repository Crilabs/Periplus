/*
 * Stage names of the consolidation (ruling M5-P16): constants only, no starter and no `lib/pipeline/runs` import, so
 * domain code and stage modules can name them without an import cycle.
 */

/** Stage consolidating the run's geo objects (one job per object, `consolidateGeo`). */
export const CONSOLIDATION_GEO_STAGE = "consolidation.geo";

/** Stage of the profile summaries (one job per new profile version). */
export const CONSOLIDATION_SUMMARY_STAGE = "consolidation.summary";

/** Stage requesting a targeted source discovery for the run's thin places (one job). */
export const CONSOLIDATION_FOLLOWUP_STAGE = "consolidation.followup";

/** The stages of a consolidation run, in order (a text run appends them after its quote check). */
export const CONSOLIDATION_STAGES = [CONSOLIDATION_GEO_STAGE, CONSOLIDATION_SUMMARY_STAGE, CONSOLIDATION_FOLLOWUP_STAGE] as const;
