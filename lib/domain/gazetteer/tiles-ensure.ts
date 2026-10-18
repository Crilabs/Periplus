import { eq, sql } from "drizzle-orm";
import type { AreaConfig } from "@/lib/config";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { tiles } from "@/lib/db/schema";
import { polygonBbox } from "./areas";
import { createReviewTask, hasDecidedTask } from "@/lib/domain/review";
import { tileBbox, tilesInBbox, type Bbox } from "@/lib/domain/tiles";

function envelope([west, south, east, north]: Bbox) {
  return sql`ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)`;
}

/**
 * The label area per tile from the configured `tileBbox`es: `area` itself plus every configured area
 * whose key is in `areaIds`. A tile in several boxes keeps the first (the given area wins).
 */
function tileBboxLabels(area: AreaConfig, areaIds: Map<string, string>): Map<string, string> {
  const configured = [area, ...getConfig().areas.filter((a) => a.key !== area.key && areaIds.has(a.key))];
  const labels = new Map<string, string>();
  for (const a of configured) {
    const id = areaIds.get(a.key);
    if (!a.tileBbox || !id) continue;
    for (const tileId of tilesInBbox(a.tileBbox)) if (!labels.has(tileId)) labels.set(tileId, id);
  }
  return labels;
}

/** The tiles of an area: `tilesInBbox(tileBbox)` ∪ `tilesInBbox(bbox(polygon))`. */
export function areaTileIds(area: AreaConfig): string[] {
  return [...new Set([...(area.tileBbox ? tilesInBbox(area.tileBbox) : []), ...tilesInBbox(polygonBbox(area.polygon))])];
}

/**
 * Creates or updates the tiles of `area`: `tilesInBbox(tileBbox)` ∪ `tilesInBbox(bbox(polygon))`.
 * - `has_coast`: the tile box intersects a land polygon.
 * - `area_id`: the area whose `tileBbox` contains the tile; else the area (from `areaIds`) whose polygon
 *   has the largest intersection with the tile box (measured on the geography); else null. A non-null
 *   `area_id` differing from that is kept when a `coast_tile_without_area` task for the tile was decided
 *   (the label was set by review).
 * - New tiles take `cycle_days` from the area config. Rows only change when a value changed (no history noise).
 * - A coast tile without area opens a `coast_tile_without_area` review task unless one was already decided.
 * Returns the number of tiles, coast tiles, and coast tiles without area.
 */
export async function ensureTiles(
  db: Db,
  area: AreaConfig,
  areaIds: Map<string, string>,
): Promise<{ tiles: number; coast: number; withoutArea: number }> {
  const tileIds = areaTileIds(area);
  const bboxLabels = tileBboxLabels(area, areaIds);
  // Postgres array literal; drizzle would expand a JS array into a parameter list.
  const areaIdArray = `{${[...areaIds.values()].join(",")}}`;

  return db.transaction(async (tx) => {
    let coast = 0;
    let withoutArea = 0;
    for (const tileId of tileIds) {
      const box = envelope(tileBbox(tileId));
      const [geo] = await tx
        .execute<{ hasCoast: boolean; largest: string | null; candidates: string[] }>(
          sql`WITH box AS (SELECT ${box} AS g),
              areas AS (
                SELECT o.id, ST_Area(ST_Intersection(o.geom, box.g)::geography) AS overlap
                FROM geo_objects o, box
                WHERE o.type = 'area' AND o.valid_to IS NULL AND o.id = ANY(${areaIdArray}::uuid[]) AND o.geom && box.g
              )
              SELECT
                EXISTS (SELECT 1 FROM land_polygons, box WHERE ST_Intersects(land_polygons.geom, box.g)) AS "hasCoast",
                (SELECT id FROM areas WHERE overlap > 0 ORDER BY overlap DESC, id LIMIT 1) AS "largest",
                ARRAY(SELECT id::text FROM areas ORDER BY id) AS "candidates"`,
        )
        .then((r) => r.rows);
      const hasCoast = geo!.hasCoast;
      const computed = bboxLabels.get(tileId) ?? geo!.largest;

      const [existing] = await tx
        .select({ areaId: tiles.areaId, hasCoast: tiles.hasCoast })
        .from(tiles)
        .where(eq(tiles.id, tileId));

      let decided: boolean | undefined;
      const isDecided = async () => (decided ??= await hasDecidedTask(tx, "coast_tile_without_area", tileId));

      let areaId = computed;
      if (!existing) {
        await tx.insert(tiles).values({ id: tileId, bbox: sql`${box}`, areaId, hasCoast, cycleDays: area.cycleDays });
      } else {
        if (existing.areaId !== null && existing.areaId !== computed && (await isDecided())) areaId = existing.areaId;
        if (existing.areaId !== areaId || existing.hasCoast !== hasCoast) {
          await tx.update(tiles).set({ areaId, hasCoast }).where(eq(tiles.id, tileId));
        }
      }

      if (!hasCoast) continue;
      coast++;
      if (areaId !== null) continue;
      withoutArea++;
      if (await isDecided()) continue;
      await createReviewTask(tx, {
        kind: "coast_tile_without_area",
        subjectType: "tile",
        subjectId: tileId,
        context: { areaKey: area.key, candidates: geo!.candidates },
      });
    }
    return { tiles: tileIds.length, coast, withoutArea };
  });
}
