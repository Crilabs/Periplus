import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { tileExists } from "@/lib/domain/geo-view";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { checkGeometryTiles, DETECT_BAYS_STAGE, GEOMETRY_STAGE, geometryPlaceIds } from "@/lib/pipeline/geometry";
import { startRun } from "@/lib/pipeline/runs";
import { RunScopeNotReady, seedTileIds } from "@/lib/pipeline/tile-scope";

// Kept apart from ./geometry: the job handler imports that module, and this one reaches the stage registry
// through ./runs, which would close an import cycle through the handler.

/** The stages of a geometry run for a tile or a subdivision, in order (a place skips `geometry.detect_bays`). */
export const GEOMETRY_RUN_STAGES = [DETECT_BAYS_STAGE, GEOMETRY_STAGE] as const;

/**
 * Starts the run "Geometrie" for one tile (scope `tile`), the coast tiles of a subdivision (scope `subdivision`) or one place
 * (scope `place`, e.g. after an anchor correction): for a tile or a subdivision first `geometry.detect_bays` (unnamed bays
 * become place candidates, ruling M7-P13), then stage `geometry.place`, then the run is done (the berth state picks the
 * computed values up in the berth follow-up chain). Checked before the run exists: the tile
 * exists, or the subdivision exists (an area key fails with the replacement hint) and has coast tiles, or the place is one the stage computes
 * and lies on a tile; every scoped tile has bathymetry and land polygons within the ray length. A scope lacking
 * one of these inputs throws `RunScopeNotReady`.
 */
export async function startGeometryRun(
  db: Db,
  boss: PgBoss,
  scope: { tileId: string } | { subdivisionKey: string } | { placeId: string },
  triggeredBy: string,
): Promise<{ id: string }> {
  let tileIds: string[];
  let run: { scope: { type: "tile" | "subdivision" | "place"; id: string }; params: Record<string, unknown> };
  if ("tileId" in scope) {
    if (!(await tileExists(db, scope.tileId))) throw new Error(`Unknown tile ${scope.tileId}`);
    tileIds = [scope.tileId];
    run = { scope: { type: "tile", id: scope.tileId }, params: { tileIds } };
  } else if ("subdivisionKey" in scope) {
    await requireSubdivision(db, scope.subdivisionKey);
    tileIds = await seedTileIds(db, { subdivisionKey: scope.subdivisionKey });
    if (tileIds.length === 0) {
      throw new RunScopeNotReady(
        "subdivision_without_coast_tiles",
        `Subdivision ${scope.subdivisionKey} has no coast tiles yet; build its gazetteer first`,
      );
    }
    run = { scope: { type: "subdivision", id: scope.subdivisionKey }, params: { subdivisionKey: scope.subdivisionKey } };
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
  const stages = run.scope.type === "place" ? GEOMETRY_RUN_STAGES.filter((s) => s !== DETECT_BAYS_STAGE) : [...GEOMETRY_RUN_STAGES];
  return startRun(db, boss, { kind: "stage", ...run, stages, triggeredBy });
}
