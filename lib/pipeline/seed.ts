import { and, asc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { areaByKey } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, tiles } from "@/lib/db/schema";
import { tileExists } from "@/lib/domain/geo-view";
import { parseTileId } from "@/lib/domain/tiles";
import { validAt } from "@/lib/domain/timeline";
import { startRun } from "@/lib/pipeline/runs";

export const SEED_STAGE = "seed.tile";

/**
 * The tiles a seed run covers: `params.tileIds` exactly as given, else every valid coast tile labelled with
 * the area `params.areaKey` (ordered by id). Throws for invalid params or an unknown area.
 */
export async function seedTileIds(db: Db, params: Record<string, unknown>): Promise<string[]> {
  if (Array.isArray(params.tileIds)) {
    for (const id of params.tileIds) {
      if (typeof id !== "string") throw new Error("tileIds must be strings");
      parseTileId(id);
    }
    return params.tileIds as string[];
  }
  if (typeof params.areaKey !== "string" || params.areaKey === "") throw new Error("tileIds or areaKey is required");
  const areaId = await areaGeoObjectId(db, params.areaKey);
  if (!areaId) throw new Error(`Unknown area ${params.areaKey}`);
  const rows = await db
    .select({ id: tiles.id })
    .from(tiles)
    .where(and(eq(tiles.areaId, areaId), eq(tiles.hasCoast, true), validAt(tiles)))
    .orderBy(asc(tiles.id));
  return rows.map((r) => r.id);
}

/** The valid geo object of the area `areaKey` (written by `tiles.ensure`); null before it exists. */
async function areaGeoObjectId(db: Db, areaKey: string): Promise<string | null> {
  const [area] = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(and(eq(geoObjects.type, "area"), eq(geoObjects.configKey, areaKey), validAt(geoObjects)));
  return area?.id ?? null;
}

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
