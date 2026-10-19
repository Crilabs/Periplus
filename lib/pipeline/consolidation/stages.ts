/*
 * Stage names of the consolidation (ruling M5-P16): constants only, no starter and no `lib/pipeline/runs` import, so
 * domain code and stage modules can name them without an import cycle. Task 16 adds `CONSOLIDATION_STAGES`.
 */

/** Stage of the profile summaries (one job per new profile version). */
export const CONSOLIDATION_SUMMARY_STAGE = "consolidation.summary";
