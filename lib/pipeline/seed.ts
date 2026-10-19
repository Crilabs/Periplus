import type { PgBoss } from "pg-boss";
import { areaByKey } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { tileExists } from "@/lib/domain/geo-view";
import { startRun } from "@/lib/pipeline/runs";
import { areaGeoObjectId } from "@/lib/pipeline/tile-scope";

// Re-exported for existing callers; the scope lives apart so job pipelines can use it without importing ./runs.
export { areaGeoObjectId, seedTileIds } from "@/lib/pipeline/tile-scope";

export const SEED_STAGE = "seed.tile";

/**
 * Starts a seed run for one tile (scope `tile`) or for the coast tiles of an area (scope `area`). The scope
 * is checked before the run exists, so a scope the run cannot plan leaves no queued run behind: the tile
 * must exist; the area must be configured and already have its geo object.
 */
export async function startSeedRun(
  db: Db,
  boss: PgBoss,
  scope: { tileId: string } | { areaKey: string },
  triggeredBy: string,
): Promise<{ id: string }> {
  if ("tileId" in scope) {
    if (!(await tileExists(db, scope.tileId))) throw new Error(`Unknown tile ${scope.tileId}`);
  } else {
    areaByKey(scope.areaKey);
    if (!(await areaGeoObjectId(db, scope.areaKey))) {
      throw new Error(`Area ${scope.areaKey} has no geo object yet; build its gazetteer first`);
    }
  }
  const run =
    "tileId" in scope
      ? { scope: { type: "tile" as const, id: scope.tileId }, params: { tileIds: [scope.tileId] } }
      : { scope: { type: "area" as const, id: scope.areaKey }, params: { areaKey: scope.areaKey } };
  return startRun(db, boss, { kind: "stage", ...run, stages: [SEED_STAGE], triggeredBy });
}
