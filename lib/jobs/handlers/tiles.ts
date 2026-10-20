import { syncCoastSections } from "@/lib/domain/gazetteer/areas";
import { ensureSubdivisionTiles } from "@/lib/domain/gazetteer/tiles-ensure";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import type { StageDefinition } from "@/lib/pipeline/runs";
import type { JobData, JobHandler } from "@/lib/jobs/worker";

/** `subdivisionKey` of run params or job data; throws when missing. A leftover `areaKey` fails with the replacement hint. */
export function subdivisionKeyOf(params: Record<string, unknown>): string {
  if (typeof params.subdivisionKey === "string" && params.subdivisionKey !== "") return params.subdivisionKey;
  if (typeof params.areaKey === "string" && params.areaKey !== "") {
    throw new Error(`Revier-Schlüssel ${params.areaKey} ist kein Laufumfang mehr; Landesteil angeben (z. B. GR-I)`);
  }
  throw new Error("subdivisionKey is required");
}

/** Creates and labels the tiles of `run.params.subdivisionKey`: one job per run. */
export const tilesEnsureStage: StageDefinition = {
  name: "tiles.ensure",
  queue: "tiles.ensure",
  async plan(db, run) {
    const key = subdivisionKeyOf(run.params);
    await requireSubdivision(db, key);
    return [{ key, subdivisionKey: key }];
  },
};

export const tilesEnsureHandler: JobHandler<JobData> = async (data, ctx) => {
  const sub = await requireSubdivision(ctx.db, subdivisionKeyOf(data));
  const sections = await syncCoastSections(ctx.db, sub.key);
  const result = await ensureSubdivisionTiles(ctx.db, sub.id);
  ctx.log.info({ subdivisionKey: sub.key, coastSections: sections.size, ...result }, "tiles ensured");
};
