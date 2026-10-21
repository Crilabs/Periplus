/*
 * Name of the image stage (spec 13): a constant only, so `consolidation/stages.ts` can append it to the consolidation
 * stages without an import cycle through the stage module.
 */

/** Stage generating the title image of each spot a run consolidated (one job per place and view). */
export const IMAGES_STAGE = "images.place";
