import { areaByKey, getConfig } from "@/lib/config";
import { endUnconfiguredAreas, syncAreas, syncCoastSections } from "@/lib/domain/gazetteer/areas";
import { ensureSubdivisionTiles, ensureTiles } from "@/lib/domain/gazetteer/tiles-ensure";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
import type { StageDefinition } from "@/lib/pipeline/runs";
import type { JobData, JobHandler } from "@/lib/jobs/worker";

// TODO(plan 14a task 7): remove with the area run path
/** `areaKey` of run params or job data; throws when missing. */
export function areaKeyOf(params: Record<string, unknown>): string {
  if (typeof params.areaKey !== "string" || params.areaKey === "") throw new Error("areaKey is required");
  return params.areaKey;
}

/** Creates and labels the tiles of `run.params.subdivisionKey` (legacy `areaKey` until the starters switch): one job per run. */
export const tilesEnsureStage: StageDefinition = {
  name: "tiles.ensure",
  queue: "tiles.ensure",
  async plan(db, run) {
    if (typeof run.params.subdivisionKey === "string" && run.params.subdivisionKey !== "") {
      const key = run.params.subdivisionKey;
      if (!(await subdivisionByKey(db, key))) throw new Error(`Unknown subdivision ${key}`);
      return [{ key, subdivisionKey: key }];
    }
    // TODO(plan 14a task 7): remove with the area run path
    const areaKey = areaKeyOf(run.params);
    areaByKey(areaKey); // fail planning for an unknown area
    return [{ key: areaKey, areaKey }];
  },
};

export const tilesEnsureHandler: JobHandler<JobData> = async (data, ctx) => {
  if (typeof data.subdivisionKey === "string" && data.subdivisionKey !== "") {
    const sub = await subdivisionByKey(ctx.db, data.subdivisionKey);
    if (!sub) throw new Error(`Unknown subdivision ${data.subdivisionKey}`);
    const sections = await syncCoastSections(ctx.db, sub.key);
    const result = await ensureSubdivisionTiles(ctx.db, sub.id);
    ctx.log.info({ subdivisionKey: sub.key, coastSections: sections.size, ...result }, "tiles ensured");
    return;
  }
  // TODO(plan 14a task 7): remove with the area run path
  const area = areaByKey(areaKeyOf(data));
  const areas = getConfig().areas;
  const areaIds = await syncAreas(ctx.db, areas);
  const ended = await endUnconfiguredAreas(ctx.db, areas);
  const result = await ensureTiles(ctx.db, area, areaIds);
  ctx.log.info({ areaKey: area.key, ended, ...result }, "tiles ensured");
};
