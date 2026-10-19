import type { PgBoss } from "pg-boss";
import { areaByKey } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { tileExists } from "@/lib/domain/geo-view";
import { checkGeometryTiles, GEOMETRY_STAGE } from "@/lib/pipeline/geometry";
import { startRun } from "@/lib/pipeline/runs";
import { areaGeoObjectId, seedTileIds } from "@/lib/pipeline/tile-scope";

// Kept apart from ./geometry: the job handler imports that module, and this one reaches the stage registry
// through ./runs, which would close an import cycle through the handler.

/**
 * Starts the run "Geometrie" for one tile (scope `tile`) or the coast tiles of an area (scope `area`), stage
 * `geometry.place`. Checked before the run exists: the tile exists, or the area is configured and has its geo
 * object and coast tiles; every scoped tile has bathymetry and land polygons within the ray length.
 */
export async function startGeometryRun(
  db: Db,
  boss: PgBoss,
  scope: { tileId: string } | { areaKey: string },
  triggeredBy: string,
): Promise<{ id: string }> {
  let tileIds: string[];
  if ("tileId" in scope) {
    if (!(await tileExists(db, scope.tileId))) throw new Error(`Unknown tile ${scope.tileId}`);
    tileIds = [scope.tileId];
  } else {
    areaByKey(scope.areaKey);
    if (!(await areaGeoObjectId(db, scope.areaKey))) {
      throw new Error(`Area ${scope.areaKey} has no geo object yet; build its gazetteer first`);
    }
    tileIds = await seedTileIds(db, { areaKey: scope.areaKey });
    if (tileIds.length === 0) throw new Error(`Area ${scope.areaKey} has no coast tiles yet; build its gazetteer first`);
  }
  await checkGeometryTiles(db, tileIds);
  const run =
    "tileId" in scope
      ? { scope: { type: "tile" as const, id: scope.tileId }, params: { tileIds: [scope.tileId] } }
      : { scope: { type: "area" as const, id: scope.areaKey }, params: { areaKey: scope.areaKey } };
  return startRun(db, boss, { kind: "stage", ...run, stages: [GEOMETRY_STAGE], triggeredBy });
}
