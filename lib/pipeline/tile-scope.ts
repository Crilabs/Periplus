import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geoObjects, tiles } from "@/lib/db/schema";
import { parseTileId } from "@/lib/domain/tiles";
import { validAt } from "@/lib/domain/timeline";

// No import of ./runs here: modules a job handler imports must not reach the stage registry (import cycle).

/** Why a run's scope is not ready for its stage; the admin UI shows a German text per reason. */
export type RunScopeReason =
  | "area_without_geo_object"
  | "area_without_coast_tiles"
  | "bathymetry_missing"
  | "land_missing"
  | "place_not_computable";

/** A run start refused before the run exists because its scope lacks an input (an expected, user-facing error). */
export class RunScopeNotReady extends Error {
  constructor(
    readonly reason: RunScopeReason,
    message: string,
  ) {
    super(message);
    this.name = "RunScopeNotReady";
  }
}

/** Stage of the seed run; here rather than in ./seed, which imports ./runs. */
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
export async function areaGeoObjectId(db: Db, areaKey: string): Promise<string | null> {
  const [area] = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(and(eq(geoObjects.type, "area"), eq(geoObjects.configKey, areaKey), validAt(geoObjects)));
  return area?.id ?? null;
}
