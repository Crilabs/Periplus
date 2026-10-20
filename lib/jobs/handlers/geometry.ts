import { getConfig } from "@/lib/config";
import { detectTileBays } from "@/lib/domain/geometry/bays";
import { parseTileId } from "@/lib/domain/tiles";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { computePlaceGeometry, DETECT_BAYS_STAGE, GEOMETRY_STAGE, geometryPlaceIds } from "@/lib/pipeline/geometry";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { seedTileIds } from "@/lib/pipeline/tile-scope";

/** Stage `geometry.detect_bays`: one job per tile of `run.params.tileIds` or per coast tile of `run.params.areaKey`; none for a place run. */
export const detectBaysStage: StageDefinition = {
  name: DETECT_BAYS_STAGE,
  queue: "geometry.detect_bays",
  async plan(db, run) {
    if (Array.isArray(run.params.placeIds)) return [];
    const tileIds = await seedTileIds(db, run.params);
    return tileIds.map((tileId) => ({ key: tileId, tileId }));
  },
};

/** Detects the unnamed bays of `data.tileId` and opens a place candidate for each new one. */
export const detectBaysHandler: JobHandler<JobData> = async (data, ctx) => {
  if (typeof data.tileId !== "string") throw new Error("tileId is required");
  parseTileId(data.tileId);
  const result = await detectTileBays(ctx.db, data.tileId, getConfig().geometry);
  ctx.log.info({ tileId: data.tileId, ...result }, "unnamed bays detected");
};

/** Stage `geometry.place`: one job per place of `run.params.placeIds`, of `run.params.tileIds` or of the coast tiles of `run.params.areaKey`. */
export const geometryPlaceStage: StageDefinition = {
  name: GEOMETRY_STAGE,
  queue: "geometry.compute",
  async plan(db, run) {
    const placeIds = await geometryPlaceIds(db, run.params);
    return placeIds.map((placeId) => ({ key: placeId, placeId }));
  },
};

/** Computes the geometry of `data.placeId`. */
export const geometryPlaceHandler: JobHandler<JobData> = async (data, ctx) => {
  if (typeof data.placeId !== "string") throw new Error("placeId is required");
  const result = await computePlaceGeometry(ctx.db, data.placeId, { runId: data.runId });
  ctx.log.info(
    { placeId: data.placeId, created: result.created, gaps: result.gaps.length, excluded: result.excluded },
    "place geometry computed",
  );
};
