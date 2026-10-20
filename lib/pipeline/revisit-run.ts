import { and, eq, isNull, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { simulationActive } from "@/lib/adapters/simulation";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { activeRulesVersion } from "@/lib/domain/consolidation/active-rules";
import { CONSOLIDATION_FOLLOWUP_STAGE } from "@/lib/pipeline/consolidation/stages";
import { FETCH_RUN_STAGES, startExclusiveFetchRun } from "@/lib/pipeline/fetch/run";
import { REVISIT_FREEZE_STAGE } from "@/lib/pipeline/revisit-stages";
import { TEXT_RUN_STAGES } from "@/lib/pipeline/text/run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";

// Kept apart from ./revisit-stages: the job handler imports that module, and this one reaches the stage registry
// through ./fetch/run and ./text/run, which would close an import cycle through the handler (rulings M6-P17, M7-P5).

/**
 * The stages of a revisit run (ruling M7-P6): the crawl of every approved source (`fetch.source`, `fetch.url`,
 * `embed.chunks`), the freeze of what the crawl wrote (`revisit.freeze`), then every text stage up to the consolidation.
 */
export const REVISIT_STAGES = [...FETCH_RUN_STAGES, REVISIT_FREEZE_STAGE, ...TEXT_RUN_STAGES] as const;

/** The revisit stages a process runs: in a simulated revisit without `consolidation.followup` (DataForSEO, ruling M7-P8). */
export function revisitStages(simulated: boolean = simulationActive()): string[] {
  return simulated ? REVISIT_STAGES.filter((s) => s !== CONSOLIDATION_FOLLOWUP_STAGE) : [...REVISIT_STAGES];
}

/**
 * „Revisit für Revier“ (spec 10, rulings M7-P6/P7/P8): one run of kind `revisit`, scope `area`, that crawls every
 * approved source again, freezes the versions that crawl wrote (`revisit.freeze`) and evaluates them like a text run up
 * to the consolidation and its change events. The same run serves the simulated revisit (`PERIPLUS_SIMULATION`: pages
 * from the scenario, no follow-up, no geocoding) and the real second pass. Params `{ sourceIds, areaKey, rulesVersion,
 * maxPages? }`: the approved sources resolved now (ruling M7-P6), the active rules version frozen at the start (ruling
 * M7-E-R1), an optional page cap per source like a crawl run; `revisit.freeze` adds the version set. Created through `startExclusiveFetchRun`: refused while
 * another queued or running run fetches one of the sources (`source_run_active`, ruling M3-C-R6). Refused before the
 * run exists: an area not configured (`unknown_area`) or without valid tiles (`area_without_tiles`), no approved
 * source (`no_approved_sources`).
 */
export async function startRevisitRun(
  db: Db,
  boss: PgBoss,
  input: { areaKey: string; triggeredBy: string; maxPages?: number },
  config: AppConfig = getConfig(),
): Promise<{ id: string }> {
  const { areaKey } = input;
  if (!config.areas.some((a) => a.key === areaKey)) throw new RunScopeNotReady("unknown_area", `area ${areaKey} is not configured`);
  const { rows } = await db.execute(sql`
    select 1 from tiles t join geo_objects a on a.id = t.area_id and a.type = 'area'
    where a.config_key = ${areaKey} and t.valid_from <= current_date and (t.valid_to is null or t.valid_to > current_date)
    limit 1
  `);
  if (rows.length === 0) throw new RunScopeNotReady("area_without_tiles", `area ${areaKey} has no tiles yet`);
  if (input.maxPages !== undefined && !(Number.isInteger(input.maxPages) && input.maxPages >= 1)) {
    throw new Error("maxPages must be a positive integer");
  }
  const sourceIds = (
    await db
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.status, "approved"), isNull(sources.validTo)))
  )
    .map((s) => s.id)
    .sort();
  if (sourceIds.length === 0) throw new RunScopeNotReady("no_approved_sources", "No source is approved yet");
  const rulesVersion = await activeRulesVersion(db);
  const stages = revisitStages();
  const { id } = await startExclusiveFetchRun(db, boss, sourceIds, { skipBusy: false }, (ids) => ({
    kind: "revisit",
    scope: { type: "area", id: areaKey },
    params: { sourceIds: ids, areaKey, rulesVersion, ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}) },
    stages,
    triggeredBy: input.triggeredBy,
  }));
  return { id };
}
