import { eq } from "drizzle-orm";
import type { CallContext, Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { researchCandidates } from "@/lib/domain/research/candidates";
import { recordHits } from "@/lib/domain/research/hits";
import { buildResearchQueries, candidateNames } from "@/lib/domain/research/queries";
import type { JobData } from "@/lib/jobs/worker";
import { runQueries } from "@/lib/pipeline/discovery";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

export const RESEARCH_SEARCH_STAGE = "research.search";

/** Plan of the stage `research.search`: one job per candidate of `params.subdivisionKey` or `params.placeIds`. */
export async function planResearchSearch(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> {
  const { subdivisionKey, placeIds } = run.params;
  let scope: { subdivisionKey: string } | { placeIds: string[] };
  if (typeof subdivisionKey === "string") scope = { subdivisionKey };
  else if (Array.isArray(placeIds) && placeIds.every((id) => typeof id === "string")) scope = { placeIds: placeIds as string[] };
  else throw new Error("subdivisionKey or placeIds is required");
  return (await researchCandidates(db, scope)).map((placeId) => ({ key: placeId, placeId }));
}

/**
 * Job `research.search`: the positive and negative queries of one candidate (`runQueries`: reuse within
 * `serp.reuseDays`, a transiently failing query is skipped), then the hits of every searched or reused query. A
 * candidate without a name has no queries.
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
  let hits = 0;
  for (const purpose of ["positive", "negative"] as const) {
    const planned = buildResearchQueries(placeId, input, cfg, purpose);
    if (planned.length === 0) continue;
    const summary = await runQueries(db, planned, deps, callCtx);
    queries += summary.queries;
    hits += await recordHits(db, { placeId, geoObjectId: place.geoObjectId, serpQueryIds: summary.queryIds, purpose, runId: ctx.runId }, cfg);
  }
  return { queries, hits };
}
