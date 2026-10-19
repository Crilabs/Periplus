import { z } from "zod";
import type { CallContext, Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { serpLevelEnum } from "@/lib/db/schema";
import { areaQueries, capQueries, placeQueries, queryKey, tileQueries, type DiscoveryQuery } from "@/lib/domain/discovery/queries";
import { runQuery } from "@/lib/domain/discovery/serp";
import { seedTileIds } from "./tile-scope";

// No import of ./runs here: the discovery job handlers import this module (import cycle through the stage registry).
// The run starters live in ./discovery-run.

export const DISCOVERY_AREA_STAGE = "discovery.area";
export const DISCOVERY_TILE_STAGE = "discovery.tile";
export const DISCOVERY_PROPOSE_STAGE = "discovery.propose";
/** Targeted source discovery for thin places (spec 07 Folgeaufträge, plan Task 15). */
export const DISCOVERY_PLACE_STAGE = "discovery.place";

type Deps = { transport: Transport; archive: Archive };

export const discoveryQuerySchema = z.strictObject({
  keyword: z.string().min(1),
  languageCode: z.string().min(1),
  locationCode: z.number().int().positive(),
  level: z.enum(serpLevelEnum.enumValues),
  scopeId: z.string().min(1),
  priority: z.number().int(),
  tileId: z.string().min(1).optional(),
});

export type SearchSummary = { queries: number; searched: number; reused: number };

/** Runs the queries one after another (`runQuery`: reuse within 30 days, else search and store). */
export async function runQueries(db: Db, queries: DiscoveryQuery[], deps: Deps, ctx: CallContext): Promise<SearchSummary> {
  let searched = 0;
  let reused = 0;
  for (const q of queries) {
    const result = await runQuery(db, q, deps, ctx);
    if (result.reused) reused += 1;
    else searched += 1;
  }
  return { queries: queries.length, searched, reused };
}

/** The area queries of `areaKey` a run makes: `areaQueries` cut to `maxQueriesPerRun`. */
async function plannedAreaQueries(db: Db, areaKey: string): Promise<DiscoveryQuery[]> {
  const { discovery } = getConfig();
  return capQueries(await areaQueries(db, areaKey, discovery), discovery.serp.maxQueriesPerRun).kept;
}

/** Job `discovery.area`: makes the area's queries, at most `maxQueriesPerRun`. */
export async function discoverArea(db: Db, areaKey: string, deps: Deps, ctx: CallContext): Promise<SearchSummary> {
  return runQueries(db, await plannedAreaQueries(db, areaKey), deps, ctx);
}

/**
 * Plan of the stage `discovery.tile`: one entry per coast tile of the run (`params.tileIds` or the coast tiles of
 * `params.areaKey`) with the tile's queries. The queries of all tiles are deduplicated among each other (lowest
 * priority wins, then the first tile) and against the run's area queries (recomputed: an area run made them in
 * `discovery.area`), then cut to what is left of `maxQueriesPerRun` after the area queries.
 */
export async function planTileDiscovery(
  db: Db,
  params: Record<string, unknown>,
): Promise<Array<{ tileId: string; queries: DiscoveryQuery[] }>> {
  const { discovery, areas } = getConfig();
  const tileIds = await seedTileIds(db, params);
  const areaPlanned = typeof params.areaKey === "string" ? await plannedAreaQueries(db, params.areaKey) : [];
  const areaKeys = new Set(areaPlanned.map(queryKey));
  const byKey = new Map<string, DiscoveryQuery>();
  for (const tileId of tileIds) {
    for (const q of await tileQueries(db, tileId, discovery, areas)) {
      const key = queryKey(q);
      if (areaKeys.has(key)) continue;
      const prior = byKey.get(key);
      if (!prior || q.priority < prior.priority) byKey.set(key, q);
    }
  }
  const budget = Math.max(0, discovery.serp.maxQueriesPerRun - areaPlanned.length);
  const { kept } = capQueries([...byKey.values()], budget);
  return tileIds.map((tileId) => ({ tileId, queries: kept.filter((q) => q.scopeId === tileId) }));
}

/** The geo object ids of a place discovery run (`params.geoObjectIds`, strings only), in their order, without repeats. */
export function placeDiscoveryIds(params: Record<string, unknown>): string[] {
  if (!Array.isArray(params.geoObjectIds)) throw new Error("geoObjectIds is required");
  for (const id of params.geoObjectIds) if (typeof id !== "string") throw new Error("geoObjectIds must be strings");
  return [...new Set(params.geoObjectIds as string[])];
}

/**
 * Plan of the stage `discovery.place`: one entry per geo object of the run (`params.geoObjectIds`, in their order) with
 * its place queries (`placeQueries`: the tile templates with the place's names). The queries are deduplicated among
 * the objects (the earlier object keeps a shared query) and cut to `maxQueriesPerRun` in that order, so the places
 * with the fewest documents (first in the run, `requestPlaceDiscovery`) keep theirs; an object left without queries
 * gets no entry.
 */
export async function planPlaceDiscovery(
  db: Db,
  params: Record<string, unknown>,
  config: AppConfig = getConfig(),
): Promise<Array<{ geoObjectId: string; queries: DiscoveryQuery[] }>> {
  const { discovery, areas } = config;
  const seen = new Set<string>();
  let budget = discovery.serp.maxQueriesPerRun;
  const out: Array<{ geoObjectId: string; queries: DiscoveryQuery[] }> = [];
  for (const geoObjectId of placeDiscoveryIds(params)) {
    const queries: DiscoveryQuery[] = [];
    for (const q of await placeQueries(db, geoObjectId, discovery, { areas })) {
      const key = queryKey(q);
      if (seen.has(key) || budget === 0) continue;
      seen.add(key);
      queries.push(q);
      budget--;
    }
    if (queries.length > 0) out.push({ geoObjectId, queries });
  }
  return out;
}
