import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { getConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { thinPlaces } from "@/lib/domain/consolidation/followup";
import { consolidationTargets } from "@/lib/domain/consolidation/targets";
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
 * Requests a targeted source discovery for the thin places among the run's targets (`thinPlaces` on `now`):
 * nothing for none, otherwise one place discovery run (`startPlaceDiscoveryRun`, which also writes the
 * `place_discovery_requests`) triggered by `consolidation:<runId>`. Retry-safe: when a run with that trigger exists
 * already (an earlier attempt started it), nothing happens (`skipped`).
 */
export async function requestPlaceDiscovery(db: Db, boss: PgBoss, runId: string, now = new Date()): Promise<FollowupResult> {
  const triggeredBy = followupTrigger(runId);
  const [prior] = await db.select({ id: runs.id }).from(runs).where(eq(runs.triggeredBy, triggeredBy)).limit(1);
  if (prior) return { places: [], discoveryRunId: prior.id, skipped: true };
  const [run] = await db.select({ params: runs.params }).from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  const params = (run.params ?? {}) as Record<string, unknown>;
  const cfg = getConsolidationConfig(typeof params.rulesVersion === "string" ? params.rulesVersion : undefined);
  const places = await thinPlaces(db, await consolidationTargets(db, { id: runId, params }), cfg.followup, now);
  if (places.length === 0) return { places, discoveryRunId: null, skipped: false };
  const { id } = await startPlaceDiscoveryRun(db, boss, { geoObjectIds: places, triggeredBy });
  return { places, discoveryRunId: id, skipped: false };
}
