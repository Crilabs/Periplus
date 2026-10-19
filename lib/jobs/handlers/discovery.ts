import { z } from "zod";
import { getCrawlTransport } from "@/lib/adapters/fetch/guarded";
import { getTransport } from "@/lib/adapters/http";
import { getArchive } from "@/lib/adapters/s3";
import { areaByKey } from "@/lib/config";
import { proposeSources } from "@/lib/domain/discovery/proposals";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import {
  discoverArea,
  DISCOVERY_AREA_STAGE,
  DISCOVERY_PROPOSE_STAGE,
  DISCOVERY_TILE_STAGE,
  discoveryQuerySchema,
  planTileDiscovery,
  runQueries,
} from "@/lib/pipeline/discovery";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { areaKeyOf } from "./tiles";

/** Stage `discovery.area`: one job for the run's area (`run.params.areaKey`). */
export const discoveryAreaStage: StageDefinition = {
  name: DISCOVERY_AREA_STAGE,
  queue: "discovery.area",
  async plan(_db, run) {
    const areaKey = areaKeyOf(run.params);
    areaByKey(areaKey); // fail planning for an unknown area
    return [{ key: areaKey, areaKey }];
  },
};

/** Stage `discovery.tile`: one job per coast tile of the run, carrying the tile's share of the per-run query cap. */
export const discoveryTileStage: StageDefinition = {
  name: DISCOVERY_TILE_STAGE,
  queue: "discovery.tile",
  async plan(db, run) {
    const plan = await planTileDiscovery(db, run.params);
    return plan.map(({ tileId, queries }) => ({ key: tileId, tileId, queries }));
  },
};

/** Stage `discovery.propose`: one job turning SERP hits and the link graph into source proposals. */
export const discoveryProposeStage: StageDefinition = {
  name: DISCOVERY_PROPOSE_STAGE,
  queue: "discovery.propose",
  async plan() {
    return [{ key: "propose" }];
  },
};

const deps = () => ({ transport: getTransport(), archive: getArchive() });

/** Makes the area queries of `data.areaKey`. */
export const discoveryAreaHandler: JobHandler<JobData> = async (data, ctx) => {
  const areaKey = areaKeyOf(data);
  const result = await discoverArea(ctx.db, areaKey, deps(), { db: ctx.db, runId: data.runId, stage: data.stage });
  ctx.log.info({ areaKey, ...result }, "area discovery done");
};

const tileJobSchema = z.object({ tileId: z.string().min(1), queries: z.array(discoveryQuerySchema) });

/** Makes the queries planned for `data.tileId`. */
export const discoveryTileHandler: JobHandler<JobData> = async (data, ctx) => {
  const { tileId, queries } = tileJobSchema.parse(data);
  const result = await runQueries(ctx.db, queries, deps(), { db: ctx.db, runId: data.runId, stage: data.stage });
  ctx.log.info({ tileId, ...result }, "tile discovery done");
};

/**
 * Proposes new sources from all SERP hits and the link graph. Their robots.txt is read through the crawl transport:
 * the origins come from SERP hits and crawled links, so every connection passes the address guard (M3-SEC-R3).
 */
export const discoveryProposeHandler: JobHandler<JobData> = async (data, ctx) => {
  if (typeof data.runId !== "string") throw new Error("runId is required");
  const robotsDeps = { transport: getCrawlTransport(), archive: getArchive() };
  const result = await proposeSources(ctx.db, robotsDeps, { db: ctx.db, runId: data.runId, stage: data.stage });
  ctx.log.info(result, "source proposals made");
};
