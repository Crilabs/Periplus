import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { tileExists } from "@/lib/domain/geo-view";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { startRun } from "@/lib/pipeline/runs";
import { RunScopeNotReady, SEED_STAGE, seedTileIds } from "@/lib/pipeline/tile-scope";

// Re-exported for existing callers; the scope lives apart so job pipelines can use it without importing ./runs.
export { SEED_STAGE, seedTileIds } from "@/lib/pipeline/tile-scope";

/**
 * Starts a seed run for one tile (scope `tile`) or for the coast tiles of a subdivision (scope `subdivision`). The
 * scope is checked before the run exists, so a scope the run cannot plan leaves no queued run behind: the tile must
 * exist; the subdivision must exist (an area key fails with the replacement hint) and already have coast tiles.
 */
export async function startSeedRun(
  db: Db,
  boss: PgBoss,
  scope: { tileId: string } | { subdivisionKey: string },
  triggeredBy: string,
): Promise<{ id: string }> {
  if ("tileId" in scope) {
    if (!(await tileExists(db, scope.tileId))) throw new Error(`Unknown tile ${scope.tileId}`);
    return startRun(db, boss, {
      kind: "stage",
      scope: { type: "tile", id: scope.tileId },
      params: { tileIds: [scope.tileId] },
      stages: [SEED_STAGE],
      triggeredBy,
    });
  }
  const { subdivisionKey } = scope;
  await requireSubdivision(db, subdivisionKey);
  if ((await seedTileIds(db, { subdivisionKey })).length === 0) {
    throw new RunScopeNotReady(
      "subdivision_without_coast_tiles",
      `Subdivision ${subdivisionKey} has no coast tiles yet; build its gazetteer first`,
    );
  }
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "subdivision", id: subdivisionKey },
    params: { subdivisionKey },
    stages: [SEED_STAGE],
    triggeredBy,
  });
}
