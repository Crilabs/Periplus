import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { researchCandidates } from "@/lib/domain/research/candidates";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { RESEARCH_ASSESS_STAGE } from "./research/assess";
import { RESEARCH_FETCH_STAGE } from "./research/fetch";
import { RESEARCH_SEARCH_STAGE } from "./research/search";
import { startRun } from "./runs";
import { RunScopeNotReady } from "./tile-scope";

// Kept apart from ./research/*: the job handlers import those modules, and this one reaches the stage registry
// through ./runs, which would close an import cycle through the handlers.

/** Scope id of a research run for a list of places (scope type `system`). */
export const RESEARCH_RUN_SCOPE = "places";

/** The stages of the run "Recherche", in order. */
export const RESEARCH_STAGES = [RESEARCH_SEARCH_STAGE, RESEARCH_FETCH_STAGE, RESEARCH_ASSESS_STAGE] as const;

/**
 * Starts the run "Recherche" for all candidates of a subdivision or for the given places: search, fetch and assess.
 * Checked before the run exists: the subdivision exists and the input has candidates (`RunScopeNotReady`
 * `geo_object_without_place`).
 */
export async function startResearchRun(
  db: Db,
  boss: PgBoss,
  input: { subdivisionKey: string } | { placeIds: string[] },
  triggeredBy: string,
): Promise<{ id: string }> {
  if ("subdivisionKey" in input) await requireSubdivision(db, input.subdivisionKey);
  if ((await researchCandidates(db, input)).length === 0) {
    throw new RunScopeNotReady("geo_object_without_place", "Keine Kandidaten für die Recherche");
  }
  return startRun(db, boss, {
    kind: "stage",
    scope: "subdivisionKey" in input ? { type: "subdivision", id: input.subdivisionKey } : { type: "system", id: RESEARCH_RUN_SCOPE },
    params: input,
    stages: [...RESEARCH_STAGES],
    triggeredBy,
  });
}
