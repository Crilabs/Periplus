import { eq } from "drizzle-orm";
import type { CallContext, Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { researchCandidates } from "@/lib/domain/research/candidates";
import { recordHits, recordWebsiteHit } from "@/lib/domain/research/hits";
import { buildResearchQueries, candidateNames } from "@/lib/domain/research/queries";
import type { JobData } from "@/lib/jobs/worker";
import { runQueries } from "@/lib/pipeline/discovery";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

export const RESEARCH_SEARCH_STAGE = "research.search";

/** The candidates a run covers: `params.subdivisionKey` or `params.placeIds`. */
export function researchScope(params: Record<string, unknown>): { subdivisionKey: string } | { placeIds: string[] } {
  const { subdivisionKey, placeIds } = params;
  if (typeof subdivisionKey === "string") return { subdivisionKey };
  if (Array.isArray(placeIds) && placeIds.every((id) => typeof id === "string")) return { placeIds: placeIds as string[] };
  throw new Error("subdivisionKey or placeIds is required");
}

/** Plan of the stage `research.search`: one job per candidate of `params.subdivisionKey` or `params.placeIds`. */
export async function planResearchSearch(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> {
  return (await researchCandidates(db, researchScope(run.params))).map((placeId) => ({ key: placeId, placeId }));
}

/**
 * Job `research.search`: the positive and negative queries of one candidate (`runQueries`: reuse within
 * `serp.reuseDays`, a transiently failing query is skipped), then the hits of every searched or reused query. A
 * candidate without a name has no queries. The place's own bound website is a positive hit first (N3b).
 */
export async function searchCandidate(
  db: Db,
  placeId: string,
  deps: { transport: Transport; archive: Archive },
  ctx: CallContext & { runId: string },
): Promise<{ queries: number; hits: number }> {
  const cfg = getConfig().research;
  const [place] = await db.select({ geoObjectId: places.geoObjectId }).from(places).where(eq(places.id, placeId));
  if (!place) throw new Error(`Unbekannter Platz ${placeId}`);
  const input = await candidateNames(db, placeId);
  const callCtx = { ...ctx, stage: ctx.stage ?? RESEARCH_SEARCH_STAGE };

  let queries = 0;
  let hits = await recordWebsiteHit(db, { placeId, geoObjectId: place.geoObjectId, runId: ctx.runId });
  for (const purpose of ["positive", "negative"] as const) {
    const planned = buildResearchQueries(placeId, input, cfg, purpose);
    if (planned.length === 0) continue;
    const summary = await runQueries(db, planned, deps, callCtx);
    queries += summary.queries;
    hits += await recordHits(db, { placeId, geoObjectId: place.geoObjectId, serpQueryIds: summary.queryIds, purpose, runId: ctx.runId }, cfg);
  }
  return { queries, hits };
}
