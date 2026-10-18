import { getConfig } from "@/lib/config";
import { seedTile } from "@/lib/domain/seed";
import { parseTileId } from "@/lib/domain/tiles";
import type { JobData, JobHandler } from "@/lib/jobs/worker";
import type { StageDefinition } from "@/lib/pipeline/runs";
import { SEED_STAGE, seedTileIds } from "@/lib/pipeline/seed";

/** Seeds places per tile: one job per tile of `run.params.tileIds` or of the coast tiles of `run.params.areaKey`. */
export const seedTileStage: StageDefinition = {
  name: SEED_STAGE,
  queue: "seed.tile",
  async plan(db, run) {
    const tileIds = await seedTileIds(db, run.params);
    return tileIds.map((tileId) => ({ key: tileId, tileId }));
  },
};

export const seedTileHandler: JobHandler<JobData> = async (data, ctx) => {
  if (typeof data.tileId !== "string") throw new Error("tileId is required");
  parseTileId(data.tileId);
  const result = await seedTile(ctx.db, data.tileId, getConfig().gazetteer);
  ctx.log.info({ tileId: data.tileId, ...result }, "tile seeded");
};
