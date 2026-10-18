import { and, asc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { geoObjects, tiles } from "@/lib/db/schema";
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
  const [area] = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(and(eq(geoObjects.type, "area"), eq(geoObjects.configKey, params.areaKey), validAt(geoObjects)));
  if (!area) throw new Error(`Unknown area ${params.areaKey}`);
  const rows = await db
    .select({ id: tiles.id })
    .from(tiles)
    .where(and(eq(tiles.areaId, area.id), eq(tiles.hasCoast, true), validAt(tiles)))
    .orderBy(asc(tiles.id));
  return rows.map((r) => r.id);
}

/** Starts a seed run for one tile (scope `tile`) or for the coast tiles of an area (scope `area`). */
export function startSeedRun(
  db: Db,
  boss: PgBoss,
  scope: { tileId: string } | { areaKey: string },
  triggeredBy: string,
): Promise<{ id: string }> {
  const run =
    "tileId" in scope
      ? { scope: { type: "tile" as const, id: scope.tileId }, params: { tileIds: [scope.tileId] } }
      : { scope: { type: "area" as const, id: scope.areaKey }, params: { areaKey: scope.areaKey } };
  return startRun(db, boss, { kind: "stage", ...run, stages: [SEED_STAGE], triggeredBy });
}
