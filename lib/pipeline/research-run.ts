import { eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, places, subdivisions } from "@/lib/db/schema";
import { activeRulesVersion } from "@/lib/domain/rules/active";
import { researchCandidates } from "@/lib/domain/research/candidates";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { RESEARCH_ASSESS_STAGE } from "./research/assess";
import { RESEARCH_CONFIRM_STAGE } from "./research/confirm";
import { RESEARCH_EXTRACT_STAGE } from "./research/extract";
import { RESEARCH_FETCH_STAGE } from "./research/fetch";
import { RESEARCH_DISCOVER_STAGE, RESEARCH_ROUTES_STAGE } from "./research/routes";
import { RESEARCH_SEARCH_STAGE } from "./research/search";
import { RESEARCH_STATE_STAGE } from "./research/state";
import { startRun } from "./runs";
import { RunScopeNotReady } from "./tile-scope";

// Kept apart from ./research/*: the job handlers import those modules, and this one reaches the stage registry
// through ./runs, which would close an import cycle through the handlers.

/** Scope id of a research run for a list of places (scope type `system`). */
export const RESEARCH_RUN_SCOPE = "places";

/** The stages of the run "Recherche", in order. */
export const RESEARCH_STAGES = [
  RESEARCH_SEARCH_STAGE,
  RESEARCH_FETCH_STAGE,
  RESEARCH_ASSESS_STAGE,
  RESEARCH_EXTRACT_STAGE,
  RESEARCH_ROUTES_STAGE,
  RESEARCH_DISCOVER_STAGE,
  RESEARCH_CONFIRM_STAGE,
  RESEARCH_STATE_STAGE,
] as const;

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
 * The gate switch (plan N3): while `research.gate.released` is false only the gate subdivision is researched. Refuses
 * (`research_gate_closed`) another subdivision, and a place list with a place outside the gate subdivision.
 */
async function requireGateOpenFor(db: Db, input: { subdivisionKey: string } | { placeIds: string[] }, gate: AppConfig["research"]["gate"]): Promise<void> {
  if (gate.released) return;
  const closed = () => new RunScopeNotReady("research_gate_closed", `Research outside ${gate.subdivision} waits for the reference gate`);
  if ("subdivisionKey" in input) {
    if (input.subdivisionKey !== gate.subdivision) throw closed();
    return;
  }
  if (input.placeIds.length === 0) return;
  const rows = await db
    .select({ key: subdivisions.key })
    .from(places)
    .leftJoin(geoObjects, eq(geoObjects.id, places.geoObjectId))
    .leftJoin(subdivisions, eq(subdivisions.id, geoObjects.subdivisionId))
    .where(inArray(places.id, input.placeIds));
  if (rows.some((r) => r.key !== gate.subdivision)) throw closed();
}

/**
 * Starts the run "Recherche" for all candidates of a subdivision or for the given places: search, fetch, assess, extract, routes, discover, confirm and state.
 * Checked before the run exists (`RunScopeNotReady`): the subdivision exists, the input has candidates
 * (`no_research_candidates`) and no research run of the same scope is queued or running (`research_run_active`); while the
 * reference gate is closed, only the gate subdivision (`research_gate_closed`, see `requireGateOpenFor`).
 */
export async function startResearchRun(
  db: Db,
  boss: PgBoss,
  input: { subdivisionKey: string } | { placeIds: string[] },
  triggeredBy: string,
  cfg: Pick<AppConfig, "research"> = getConfig(),
): Promise<{ id: string }> {
  await requireGateOpenFor(db, input, cfg.research.gate);
  if ("subdivisionKey" in input) await requireSubdivision(db, input.subdivisionKey);
  if ((await researchCandidates(db, input)).length === 0) {
    throw new RunScopeNotReady("no_research_candidates", "No candidates for the research");
  }
  const active = await activeResearchRun(db, input);
  if (active) throw new RunScopeNotReady("research_run_active", `Research run ${active} of this scope is queued or running`);
  return startRun(db, boss, {
    kind: "stage",
    scope: "subdivisionKey" in input ? { type: "subdivision", id: input.subdivisionKey } : { type: "system", id: RESEARCH_RUN_SCOPE },
    // the rules version of the berth states, frozen so every berth of the run is decided by one version
    params: { ...input, rulesVersion: activeRulesVersion() },
    stages: [...RESEARCH_STAGES],
    triggeredBy,
  });
}
