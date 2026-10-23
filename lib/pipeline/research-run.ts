import { sql } from "drizzle-orm";
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
 * The id of a queued or running research run of the same scope: for a subdivision the run of that subdivision, for
 * places a run on the places list that shares a place.
 */
async function activeResearchRun(db: Db, input: { subdivisionKey: string } | { placeIds: string[] }): Promise<string | null> {
  const same =
    "subdivisionKey" in input
      ? sql`scope_type = 'subdivision' and scope_id = ${input.subdivisionKey}`
      : sql`scope_type = 'system' and scope_id = ${RESEARCH_RUN_SCOPE}
          and coalesce(params -> 'placeIds', '[]'::jsonb) ?| array[${sql.join(input.placeIds.map((id) => sql`${id}`), sql`, `)}]::text[]`;
  const { rows } = await db.execute<{ id: string }>(sql`
    select id from runs
    where kind = 'stage' and ${RESEARCH_SEARCH_STAGE} = any(stages) and status in ('queued', 'running') and ${same}
    order by created_at desc limit 1
  `);
  return rows[0]?.id ?? null;
}

/**
 * Starts the run "Recherche" for all candidates of a subdivision or for the given places: search, fetch and assess.
 * Checked before the run exists (`RunScopeNotReady`): the subdivision exists, the input has candidates
 * (`no_research_candidates`) and no research run of the same scope is queued or running (`research_run_active`).
 */
export async function startResearchRun(
  db: Db,
  boss: PgBoss,
  input: { subdivisionKey: string } | { placeIds: string[] },
  triggeredBy: string,
): Promise<{ id: string }> {
  if ("subdivisionKey" in input) await requireSubdivision(db, input.subdivisionKey);
  if ((await researchCandidates(db, input)).length === 0) {
    throw new RunScopeNotReady("no_research_candidates", "No candidates for the research");
  }
  const active = await activeResearchRun(db, input);
  if (active) throw new RunScopeNotReady("research_run_active", `Research run ${active} of this scope is queued or running`);
  return startRun(db, boss, {
    kind: "stage",
    scope: "subdivisionKey" in input ? { type: "subdivision", id: input.subdivisionKey } : { type: "system", id: RESEARCH_RUN_SCOPE },
    params: input,
    stages: [...RESEARCH_STAGES],
    triggeredBy,
  });
}
