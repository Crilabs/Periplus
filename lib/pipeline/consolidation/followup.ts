import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { getConfig, getConsolidationConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { thinPlaces } from "@/lib/domain/consolidation/followup";
import { consolidationTargets } from "@/lib/domain/consolidation/targets";
import { placeQueries, queryKey } from "@/lib/domain/discovery/queries";
import { runDate } from "@/lib/domain/runs";
import { startPlaceDiscoveryRun } from "@/lib/pipeline/discovery-run";

/*
 * Job of the stage `consolidation.followup` (ruling M5-P11): it starts a run, so it reaches `lib/pipeline/runs`. Only
 * `lib/jobs/handlers/consolidation-followup.ts` imports this module, and that one only `lib/jobs/registry.ts`; the stage
 * definition (plan only) lives with the other consolidation stages and never imports a starter.
 */

/** `triggered_by` of the place discovery a consolidation run requests. */
export const followupTrigger = (runId: string) => `consolidation:${runId}`;

export type FollowupResult = { places: string[]; discoveryRunId: string | null; skipped: boolean };

/**
 * Requests a targeted source discovery for the thin places among the run's targets: `thinPlaces` on the run date (one
 * date for the selection, the queries and the starter, ruling M5-H-R2), only places with queries of their own (a tile
 * of a configured area and a name in one of its languages; a place without gets no request and no cool-down) and only
 * as many as `discovery.serp.maxQueriesPerRun` covers, fewest documents first. Nothing for none, otherwise one place
 * discovery run (`startPlaceDiscoveryRun`, which also writes the `place_discovery_requests`, in that order) triggered
 * by `consolidation:<runId>`. Retry-safe: when a run with that trigger exists already (an earlier attempt started it),
 * nothing happens (`skipped`).
 */
export async function requestPlaceDiscovery(
  db: Db,
  boss: PgBoss,
  runId: string,
  opts: { today?: string; config?: AppConfig } = {},
): Promise<FollowupResult> {
  const triggeredBy = followupTrigger(runId);
  const [prior] = await db.select({ id: runs.id }).from(runs).where(eq(runs.triggeredBy, triggeredBy)).limit(1);
  if (prior) return { places: [], discoveryRunId: prior.id, skipped: true };
  const [run] = await db.select({ params: runs.params }).from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  const params = (run.params ?? {}) as Record<string, unknown>;
  const today = opts.today ?? (await runDate(db, runId));
  const cfg = getConsolidationConfig(typeof params.rulesVersion === "string" ? params.rulesVersion : undefined);
  const { discovery, areas } = opts.config ?? getConfig();
  const seen = new Set<string>();
  let budget = discovery.serp.maxQueriesPerRun;
  // A place is requested only with queries of its own that still fit the run's query budget.
  const searchable = async (geoObjectId: string) => {
    const fresh = (await placeQueries(db, geoObjectId, discovery, { areas, on: today })).filter((q) => !seen.has(queryKey(q)));
    if (fresh.length === 0 || fresh.length > budget) return false;
    for (const q of fresh) seen.add(queryKey(q));
    budget -= fresh.length;
    return true;
  };
  const places = await thinPlaces(db, await consolidationTargets(db, { id: runId, params }, today), cfg.followup, today, searchable);
  if (places.length === 0) return { places, discoveryRunId: null, skipped: false };
  const { id } = await startPlaceDiscoveryRun(db, boss, { geoObjectIds: places, triggeredBy, on: today });
  return { places, discoveryRunId: id, skipped: false };
}
