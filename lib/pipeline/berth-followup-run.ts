import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { activeRulesVersion } from "@/lib/domain/consolidation/active-rules";
import { RESEARCH_ASSESS_STAGE } from "@/lib/pipeline/research/assess";
import { RESEARCH_FETCH_STAGE } from "@/lib/pipeline/research/fetch";
import { RESEARCH_LANDSIDE_EXTRACT_STAGE } from "@/lib/pipeline/research/landside-extract";
import { RESEARCH_LANDSIDE_SEARCH_STAGE } from "@/lib/pipeline/research/landside-search";
import { RESEARCH_STATE_FACTS_STAGE, RESEARCH_STATE_STAGE } from "@/lib/pipeline/research/state";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import { startRun } from "@/lib/pipeline/runs";

// Kept apart from ./research/*: the job handlers import those modules, and this one reaches the stage registry
// through ./runs, which would close an import cycle through the handlers (pattern of images-run.ts).

/** Scope id of the follow-up run of newly confirmed berths (scope type `system`). */
export const BERTH_FOLLOWUP_SCOPE = "berth-followup";

/**
 * The stages of the follow-up run of a newly confirmed berth (spec 5.7b). N2: the title images of the berths
 * (`images.place` with `params.images.geoObjectIds`), preceded by the berth state (`research.state`: core values, landing
 * points, reachable and bundled facts; the rules version is frozen in `params.rulesVersion`); N4b adds the land research:
 * search, fetch and assess the landside pages (the fetch and assess stages plan from all hits of the run's places, either
 * purpose), extract the landside facts, then bundle the facts again (`research.state_facts`). A stage cannot repeat in a
 * run (unique per run and stage), so the state is built once, first (its `nearby` gives the landside subjects), and the
 * closing stage only bundles. The research run per subdivision has no landside stages.
 */
export const BERTH_FOLLOWUP_STAGES = [
  RESEARCH_STATE_STAGE,
  RESEARCH_LANDSIDE_SEARCH_STAGE,
  RESEARCH_FETCH_STAGE,
  RESEARCH_ASSESS_STAGE,
  RESEARCH_LANDSIDE_EXTRACT_STAGE,
  RESEARCH_STATE_FACTS_STAGE,
  IMAGES_STAGE,
] as const;

/**
 * Starts the follow-up run of berths that just became `confirmed` (kind `event`, scope `system`/`berth-followup`):
 * the stages of `BERTH_FOLLOWUP_STAGES` over the given places. Unknown, ended or merged places are left out; `null`
 * when no place is left. The caller starts it after the status change committed (never inside its transaction).
 */
export async function startBerthFollowupRun(db: Db, boss: PgBoss, placeIds: string[], triggeredBy: string): Promise<{ id: string } | null> {
  const ids = [...new Set(placeIds)].sort();
  if (ids.length === 0) return null;
  const { rows } = await db.execute<{ id: string; geo_object_id: string }>(sql`
    select id, geo_object_id from places
    where id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
      and valid_to is null and merged_into_id is null
    order by id`);
  if (rows.length === 0) return null;
  const geoObjectIds = [...new Set(rows.map((r) => r.geo_object_id))].sort();
  return startRun(db, boss, {
    kind: "event",
    scope: { type: "system", id: BERTH_FOLLOWUP_SCOPE },
    stages: [...BERTH_FOLLOWUP_STAGES],
    params: { placeIds: rows.map((r) => r.id), images: { geoObjectIds }, rulesVersion: await activeRulesVersion(db) },
    triggeredBy,
  });
}
