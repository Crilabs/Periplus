import { areaByKey, getConfig } from "@/lib/config";
import { endUnconfiguredAreas, syncAreas } from "@/lib/domain/gazetteer/areas";
import { ensureTiles } from "@/lib/domain/gazetteer/tiles-ensure";
import type { StageDefinition } from "@/lib/pipeline/runs";
import type { JobData, JobHandler } from "@/lib/jobs/worker";

/** `areaKey` of run params or job data; throws when missing. */
export function areaKeyOf(params: Record<string, unknown>): string {
  if (typeof params.areaKey !== "string" || params.areaKey === "") throw new Error("areaKey is required");
  return params.areaKey;
}

/** Creates and labels the tiles of `run.params.areaKey`: one job per run. */
export const tilesEnsureStage: StageDefinition = {
  name: "tiles.ensure",
  queue: "tiles.ensure",
  async plan(_db, run) {
    const areaKey = areaKeyOf(run.params);
    areaByKey(areaKey); // fail planning for an unknown area
    return [{ key: areaKey, areaKey }];
  },
};

export const tilesEnsureHandler: JobHandler<JobData> = async (data, ctx) => {
  const area = areaByKey(areaKeyOf(data));
  const areas = getConfig().areas;
  const areaIds = await syncAreas(ctx.db, areas);
  const ended = await endUnconfiguredAreas(ctx.db, areas);
  const result = await ensureTiles(ctx.db, area, areaIds);
  ctx.log.info({ areaKey: area.key, ended, ...result }, "tiles ensured");
};
