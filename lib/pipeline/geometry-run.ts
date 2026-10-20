import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { areaByKey } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { activeRulesVersion } from "@/lib/domain/consolidation/active-rules";
import { tileExists } from "@/lib/domain/geo-view";
import { GEOMETRY_CONSOLIDATION_STAGES } from "@/lib/pipeline/consolidation/stages";
import { checkGeometryTiles, DETECT_BAYS_STAGE, GEOMETRY_STAGE, geometryPlaceIds } from "@/lib/pipeline/geometry";
import { startRun } from "@/lib/pipeline/runs";
import { areaGeoObjectId, RunScopeNotReady, seedTileIds } from "@/lib/pipeline/tile-scope";

// Kept apart from ./geometry: the job handler imports that module, and this one reaches the stage registry
// through ./runs, which would close an import cycle through the handler.

/**
 * Starts the run "Geometrie" for one tile (scope `tile`), the coast tiles of an area (scope `area`) or one place
 * (scope `place`, e.g. after an anchor correction): for a tile or an area first `geometry.detect_bays` (unnamed bays
 * become place candidates, ruling M7-P13), then stage `geometry.place`, then profile and summary for its
 * places (`GEOMETRY_CONSOLIDATION_STAGES`, no paid source discovery; final review I-2: a new exclusion or computed shelter reaches the profile and the
 * change feed in the same run; `consolidationTargets` maps the run's params). Checked before the run exists: the tile
 * exists, or the area is configured and has its geo object and coast tiles, or the place is one the stage computes
 * and lies on a tile; every scoped tile has bathymetry and land polygons within the ray length. A scope lacking
 * one of these inputs throws `RunScopeNotReady`.
 */
export async function startGeometryRun(
  db: Db,
  boss: PgBoss,
  scope: { tileId: string } | { areaKey: string } | { placeId: string },
  triggeredBy: string,
): Promise<{ id: string }> {
  let tileIds: string[];
  let run: { scope: { type: "tile" | "area" | "place"; id: string }; params: Record<string, unknown> };
  if ("tileId" in scope) {
    if (!(await tileExists(db, scope.tileId))) throw new Error(`Unknown tile ${scope.tileId}`);
    tileIds = [scope.tileId];
    run = { scope: { type: "tile", id: scope.tileId }, params: { tileIds } };
  } else if ("areaKey" in scope) {
    areaByKey(scope.areaKey);
    if (!(await areaGeoObjectId(db, scope.areaKey))) {
      throw new RunScopeNotReady(
        "area_without_geo_object",
        `Area ${scope.areaKey} has no geo object yet; build its gazetteer first`,
      );
    }
    tileIds = await seedTileIds(db, { areaKey: scope.areaKey });
    if (tileIds.length === 0) {
      throw new RunScopeNotReady(
        "area_without_coast_tiles",
        `Area ${scope.areaKey} has no coast tiles yet; build its gazetteer first`,
      );
    }
    run = { scope: { type: "area", id: scope.areaKey }, params: { areaKey: scope.areaKey } };
  } else {
    const [computable] = await geometryPlaceIds(db, { placeIds: [scope.placeId] });
    const [place] = computable
      ? await db.select({ tileId: places.tileId }).from(places).where(eq(places.id, computable))
      : [];
    if (!place?.tileId) {
      throw new RunScopeNotReady("place_not_computable", `Place ${scope.placeId} is not one the geometry stage computes`);
    }
    tileIds = [place.tileId];
    run = { scope: { type: "place", id: scope.placeId }, params: { placeIds: [scope.placeId] } };
  }
  await checkGeometryTiles(db, tileIds);
  // its consolidation and summaries keep the rules active now, across a later activation (ruling M7-E-R1)
  run.params.rulesVersion = await activeRulesVersion(db);
  const detect = run.scope.type === "place" ? [] : [DETECT_BAYS_STAGE];
  return startRun(db, boss, { kind: "stage", ...run, stages: [...detect, GEOMETRY_STAGE, ...GEOMETRY_CONSOLIDATION_STAGES], triggeredBy });
}
