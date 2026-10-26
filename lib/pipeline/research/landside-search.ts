import { and, eq, inArray, isNull } from "drizzle-orm";
import type { CallContext, Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { researchCandidates } from "@/lib/domain/research/candidates";
import { recordLandsideHits } from "@/lib/domain/research/hits";
import { buildLandsideQueries, landsideSubjects } from "@/lib/domain/research/landside-queries";
import type { JobData } from "@/lib/jobs/worker";
import { runQueries } from "@/lib/domain/search/run-queries";
import { researchScope } from "@/lib/pipeline/research/search";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

export const RESEARCH_LANDSIDE_SEARCH_STAGE = "research.landside_search";

/** Plan of the stage `research.landside_search`: one job per confirmed place of the run's `subdivisionKey` or `placeIds`. */
export async function planLandsideSearch(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> {
  const ids = await researchCandidates(db, researchScope(run.params));
  if (ids.length === 0) return [];
  const confirmed = await db
    .select({ id: places.id })
    .from(places)
    .where(and(inArray(places.id, ids), eq(places.status, "confirmed"), isNull(places.mergedIntoId), isNull(places.validTo)));
  return confirmed.map((p) => p.id).sort().map((placeId) => ({ key: placeId, placeId }));
}

/**
 * Job `research.landside_search`: the landside queries of one confirmed berth (`landsideSubjects` x the landside
 * templates; `runQueries` reuses what was searched within `serp.reuseDays`, so a town several berths reach is
 * searched once), then the hits per subject as purpose `landside`. A place without a subject has no queries.
 */
export async function searchLandside(
  db: Db,
  placeId: string,
  deps: { transport: Transport; archive: Archive },
  ctx: CallContext & { runId: string },
): Promise<{ queries: number; hits: number }> {
  const cfg = getConfig().research;
  const [place] = await db.select({ geoObjectId: places.geoObjectId, tileId: places.tileId }).from(places).where(eq(places.id, placeId));
  if (!place) throw new Error(`Unbekannter Platz ${placeId}`);
  const callCtx = { ...ctx, stage: ctx.stage ?? RESEARCH_LANDSIDE_SEARCH_STAGE };

  // one query set per subject object: its names in the several template languages belong together
  const byObject = new Map<string, ReturnType<typeof buildLandsideQueries>>();
  for (const subject of await landsideSubjects(db, placeId, cfg.landside)) {
    const key = subject.geoObjectId ?? `${subject.lang}:${subject.name}`;
    byObject.set(key, [...(byObject.get(key) ?? []), ...buildLandsideQueries(placeId, place.tileId, subject, cfg)]);
  }
  let queries = 0;
  const subjects: Array<{ serpQueryIds: string[] }> = [];
  for (const planned of byObject.values()) {
    if (planned.length === 0) continue;
    const summary = await runQueries(db, planned, deps, callCtx);
    queries += summary.queries;
    subjects.push({ serpQueryIds: summary.queryIds });
  }
  const hits = await recordLandsideHits(db, { placeId, geoObjectId: place.geoObjectId, subjects, runId: ctx.runId }, cfg);
  return { queries, hits };
}
