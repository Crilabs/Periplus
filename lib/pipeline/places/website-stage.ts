import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { findPlaceWebsite, placesNeedingWebsite, type FindDeps, type FoundWebsite, type PlaceRef } from "@/lib/domain/places/website-find";
import { attachPlaceWebsite } from "@/lib/domain/places/website-source";
import { currentPlaceWebsite } from "@/lib/domain/places/websites";

// No import of ../runs here: the job handler imports this module, which must not reach the stage registry (import
// cycle).

/** What one `places.website` job did; `attached_before`: a retried job found the place's website already recorded. */
export type PlaceWebsiteJobResult = {
  outcome: FoundWebsite["outcome"] | "attached_before";
  url?: string;
  sourceId?: string | null;
  bound?: boolean;
};

/** Plan of the stage `places.website`: one job per place of `params.subdivisionKey` without website (`placesNeedingWebsite`). */
export async function planPlaceWebsites(db: Db, run: { id: string; params: Record<string, unknown> }) {
  const key = run.params.subdivisionKey;
  if (typeof key !== "string" || key === "") throw new Error("subdivisionKey is required");
  return (await placesNeedingWebsite(db, key)).map((p) => ({ key: p.placeId, placeId: p.placeId, geoObjectId: p.geoObjectId }));
}

/**
 * Job `places.website` for one place: finds its website (`findPlaceWebsite`) and records it (`attachPlaceWebsite`). A
 * place whose website is recorded already (a retried job) changes nothing.
 */
export async function runPlaceWebsiteJob(
  db: Db,
  job: PlaceRef & { runId: string },
  deps: FindDeps,
): Promise<PlaceWebsiteJobResult> {
  const recorded = await currentPlaceWebsite(db, job.placeId);
  if (recorded) return { outcome: "attached_before", url: recorded.url, sourceId: recorded.sourceId, bound: recorded.bound };
  const [place] = await db.select({ tileId: places.tileId }).from(places).where(eq(places.id, job.placeId));
  const found = await findPlaceWebsite(db, job, deps, { runId: job.runId, tileId: place?.tileId ?? null });
  if (!found.url || !found.origin) return { outcome: found.outcome };
  const { url, origin } = found;
  return db.transaction(async (tx) => {
    const attached = await attachPlaceWebsite(tx, {
      placeId: job.placeId,
      geoObjectId: job.geoObjectId,
      url,
      origin,
      ...(found.serpQueryId ? { serpQueryId: found.serpQueryId } : {}),
      ...(found.quote !== undefined ? { quote: found.quote } : {}),
      ...(found.confidence !== undefined ? { confidence: found.confidence } : {}),
      runId: job.runId,
    });
    return { outcome: found.outcome, url, ...attached };
  });
}
