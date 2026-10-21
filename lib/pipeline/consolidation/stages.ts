import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";

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

/**
 * The stages of a consolidation run, in order (a text run appends them after its quote check). The last one generates
 * the title images of the spots the run consolidated (`images.place`, spec 13), so every newly confirmed spot gets one;
 * a `stagesOnly` run (e.g. „Summary neu erzeugen") leaves it out unless it names it.
 */
export const CONSOLIDATION_STAGES = [CONSOLIDATION_GEO_STAGE, CONSOLIDATION_SUMMARY_STAGE, CONSOLIDATION_FOLLOWUP_STAGE, IMAGES_STAGE] as const;

/**
 * The consolidation stages a geometry run appends (final review I-2): profile, summary and title images. A paid source
 * discovery (`consolidation.followup`, DataForSEO) is never a side effect of recomputing geometry; it runs with
 * consolidation and text runs. The images stage is here because a place only becomes an image target once it has a
 * fetch computation, which a geometry run brings.
 */
export const GEOMETRY_CONSOLIDATION_STAGES = [CONSOLIDATION_GEO_STAGE, CONSOLIDATION_SUMMARY_STAGE, IMAGES_STAGE] as const;
