/*
 * Names of the marina website stages (spec 15 C): constants only, so domain code, the subdivision build and the run
 * starter can name them without an import cycle through the stage registry.
 */

/** Finds and approves the website of each marina or port of a subdivision (one job per place). */
export const PLACE_WEBSITE_STAGE = "places.website";

/** Freezes the version set of a marina website run between its crawl and its text stages (one job). */
export const PLACE_WEBSITE_FREEZE_STAGE = "places.website.freeze";
