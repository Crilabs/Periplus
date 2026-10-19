import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { areaByKey, getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, tiles } from "@/lib/db/schema";
import { tileExists } from "@/lib/domain/geo-view";
import { DISCOVERY_AREA_STAGE, DISCOVERY_PROPOSE_STAGE, DISCOVERY_TILE_STAGE } from "./discovery";
import { startRun } from "./runs";
import { areaGeoObjectId, RunScopeNotReady, seedTileIds } from "./tile-scope";

// Kept apart from ./discovery: the job handlers import that module, and this one reaches the stage registry
// through ./runs, which would close an import cycle through the handlers.

/** Scope id of a proposal run (scope type `system`). */
export const PROPOSAL_RUN_SCOPE = "discovery";

/**
 * Starts the run "Quellenfindung" for an area (stages `discovery.area`, `discovery.tile`, `discovery.propose`)
 * or one tile (`discovery.tile`, `discovery.propose`). Checked before the run exists: the area is configured and
 * has its geo object and coast tiles (`RunScopeNotReady`), or the tile exists and belongs to a configured area,
 * whose source languages its queries need (`RunScopeNotReady` `tile_without_area`).
 */
export async function startDiscoveryRun(
  db: Db,
  boss: PgBoss,
  scope: { areaKey: string } | { tileId: string },
  triggeredBy: string,
): Promise<{ id: string }> {
  if ("areaKey" in scope) {
    areaByKey(scope.areaKey);
    if (!(await areaGeoObjectId(db, scope.areaKey))) {
      throw new RunScopeNotReady(
        "area_without_geo_object",
        `Area ${scope.areaKey} has no geo object yet; build its gazetteer first`,
      );
    }
    if ((await seedTileIds(db, { areaKey: scope.areaKey })).length === 0) {
      throw new RunScopeNotReady(
        "area_without_coast_tiles",
        `Area ${scope.areaKey} has no coast tiles yet; build its gazetteer first`,
      );
    }
    return startRun(db, boss, {
      kind: "stage",
      scope: { type: "area", id: scope.areaKey },
      params: { areaKey: scope.areaKey },
      stages: [DISCOVERY_AREA_STAGE, DISCOVERY_TILE_STAGE, DISCOVERY_PROPOSE_STAGE],
      triggeredBy,
    });
  }
  if (!(await tileExists(db, scope.tileId))) throw new Error(`Unknown tile ${scope.tileId}`);
  const [tile] = await db
    .select({ areaKey: geoObjects.configKey })
    .from(tiles)
    .leftJoin(geoObjects, eq(geoObjects.id, tiles.areaId))
    .where(eq(tiles.id, scope.tileId));
  if (!tile?.areaKey || !getConfig().areas.some((a) => a.key === tile.areaKey)) {
    throw new RunScopeNotReady(
      "tile_without_area",
      `Tile ${scope.tileId} has no configured area; its queries need the area's source languages`,
    );
  }
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "tile", id: scope.tileId },
    params: { tileIds: [scope.tileId] },
    stages: [DISCOVERY_TILE_STAGE, DISCOVERY_PROPOSE_STAGE],
    triggeredBy,
  });
}

/** Starts a run with only `discovery.propose` (e.g. after a crawl filled the link graph). */
export async function startProposalRun(db: Db, boss: PgBoss, triggeredBy: string): Promise<{ id: string }> {
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "system", id: PROPOSAL_RUN_SCOPE },
    stages: [DISCOVERY_PROPOSE_STAGE],
    triggeredBy,
  });
}
