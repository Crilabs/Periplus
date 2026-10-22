import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { activeRulesVersion } from "@/lib/domain/consolidation/active-rules";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { FETCH_RUN_STAGES, startExclusiveFetchRun } from "@/lib/pipeline/fetch/run";
import { PLACE_WEBSITE_FREEZE_STAGE, PLACE_WEBSITE_STAGE } from "@/lib/pipeline/places/stage-name";
import { TEXT_RUN_STAGES } from "@/lib/pipeline/text/run";

// Kept apart from ./places/website-stage: the job handler imports that module, and this one reaches the stage
// registry through ./fetch/run and ./text/run, which would close an import cycle through the handler.

/**
 * The stages of „Marina-Websites suchen“ (spec 16 C „Crawl“): find and approve the websites, crawl the touched sources,
 * freeze their new versions, then every text stage up to the consolidation.
 */
export const PLACE_WEBSITE_RUN_STAGES = [PLACE_WEBSITE_STAGE, ...FETCH_RUN_STAGES, PLACE_WEBSITE_FREEZE_STAGE, ...TEXT_RUN_STAGES];

/**
 * „Marina-Websites suchen“ for a subdivision: one run of kind `stage`, scope `subdivision`, params
 * `{ subdivisionKey, pending: true, sourceIds: [], rulesVersion }`. `places.website` fills `sourceIds` with the sources
 * it approved or extended (sources another crawl fetches are left out, `addRunSources`), the crawl fetches them and the
 * freeze hands their pending versions to the text stages. Created through `startExclusiveFetchRun` like every crawl run;
 * an unknown or excluded subdivision is refused (`requireSubdivision`).
 */
export async function startPlaceWebsiteRun(
  db: Db,
  boss: PgBoss,
  input: { subdivisionKey: string },
  triggeredBy: string,
): Promise<{ id: string }> {
  const sub = await requireSubdivision(db, input.subdivisionKey);
  const rulesVersion = await activeRulesVersion(db);
  const { id } = await startExclusiveFetchRun(db, boss, [], { skipBusy: false }, () => ({
    kind: "stage",
    scope: { type: "subdivision", id: sub.key },
    stages: [...PLACE_WEBSITE_RUN_STAGES],
    params: { subdivisionKey: sub.key, pending: true, sourceIds: [], rulesVersion },
    triggeredBy,
  }));
  return { id };
}
