import type { JobData, JobHandler } from "@/lib/jobs/worker";
import { computePlaceGeometry, GEOMETRY_STAGE, geometryPlaceIds } from "@/lib/pipeline/geometry";
import type { StageDefinition } from "@/lib/pipeline/runs";

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
