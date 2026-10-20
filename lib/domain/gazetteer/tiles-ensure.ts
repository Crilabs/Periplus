import { and, eq, sql } from "drizzle-orm";
import type { AreaConfig } from "@/lib/config";
import { countryConfig, getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { subdivisions, tiles } from "@/lib/db/schema";
import { polygonBbox } from "./areas";
import { createReviewTask, hasDecidedTask } from "@/lib/domain/review";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
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

// TODO(plan 14a task 7): remove with the area run path
/** The tiles of an area: `tilesInBbox(tileBbox)` ∪ `tilesInBbox(bbox(polygon))`. */
export function areaTileIds(area: AreaConfig): string[] {
  return [...new Set([...(area.tileBbox ? tilesInBbox(area.tileBbox) : []), ...tilesInBbox(polygonBbox(area.polygon))])];
}

/**
 * TODO(plan 14a task 7): remove with the area run path.
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

/** Cycle days of a subdivision: the override for its key, else its country's default. */
function subdivisionCycleDays(key: string, country: string): number {
  return getConfig().subdivisions.overrides[key]?.cycleDays ?? countryConfig(country).cycleDays;
}

/**
 * Creates or updates the tiles of a subdivision: every tile of the polygon's bbox whose box meets the polygon
 * (not just along an edge).
 * - `has_coast`: the tile box intersects a land polygon.
 * - `subdivision_id`: the label. Candidates are all valid subdivisions (excluded ones too) whose `geom` intersects the
 *   tile box. The label is the candidate with the longest true coastline (boundary of the land polygons, not the
 *   administrative border over land) inside the box near its land, ties by key. Without any coastline length: the
 *   candidate whose `geom` contains the tile centre, else the one with the largest `geom` overlap with the box; null
 *   without candidates. Same result whichever subdivision ensures the tile.
 * - New tiles take `cycle_days` from config (override per key, else the country). `cycle_days` is set only when a tile
 *   is created, so the first ensuring subdivision wins. Rows only change when a value changed.
 * Throws for an excluded subdivision. `tiles.area_id` is not written.
 */
export async function ensureSubdivisionTiles(db: Db, subdivisionId: string): Promise<{ tiles: number; coast: number }> {
  const [sub] = await db
    .select({ id: subdivisions.id, key: subdivisions.key, country: subdivisions.country, status: subdivisions.status })
    .from(subdivisions)
    .where(and(eq(subdivisions.id, subdivisionId), sql`${subdivisions.validTo} IS NULL`));
  if (!sub) throw new Error(`Unknown subdivision ${subdivisionId}`);
  if (sub.status === "excluded") throw new Error(`Landesteil ${sub.key} ist ausgeschlossen`);
  const cycleDays = subdivisionCycleDays(sub.key, sub.country);
  const ref = await subdivisionByKey(db, sub.key);

  return db.transaction(async (tx) => {
    let tileCount = 0;
    let coast = 0;
    for (const tileId of tilesInBbox(ref!.bbox)) {
      const box = envelope(tileBbox(tileId));
      const [geo] = await tx
        .execute<{ meets: boolean; hasCoast: boolean; label: string | null }>(
          sql`WITH box AS (SELECT ${box} AS g)
              SELECT
                EXISTS (SELECT 1 FROM subdivisions s, box WHERE s.id = ${sub.id} AND ST_Intersects(s.geom, box.g)
                        AND NOT ST_Touches(s.geom, box.g)) AS meets,
                EXISTS (SELECT 1 FROM land_polygons l, box WHERE ST_Intersects(l.geom, box.g)) AS "hasCoast",
                COALESCE(
                  (SELECT c.id FROM (
                     SELECT s.id, s.key,
                       ST_Length(ST_Intersection(
                         (SELECT ST_Collect(ST_Intersection(ST_Boundary(l.geom), box.g))
                          FROM land_polygons l WHERE ST_Intersects(l.geom, box.g)),
                         ST_Buffer(s.land_geom, 0.00001))::geography) AS len
                     FROM subdivisions s, box
                     WHERE s.valid_to IS NULL AND s.land_geom IS NOT NULL AND ST_Intersects(s.geom, box.g)) c
                   WHERE c.len > 0 ORDER BY c.len DESC, c.key LIMIT 1),
                  (SELECT s.id FROM subdivisions s, box
                   WHERE s.valid_to IS NULL AND ST_Intersects(s.geom, box.g)
                   ORDER BY ST_Contains(s.geom, ST_Centroid(box.g)) DESC,
                            ST_Area(ST_Intersection(s.geom, box.g)::geography) DESC, s.key
                   LIMIT 1)
                ) AS label`,
        )
        .then((r) => r.rows);
      if (!geo!.meets) continue;
      tileCount++;
      if (geo!.hasCoast) coast++;
      const label = geo!.label;
      const [existing] = await tx
        .select({ subdivisionId: tiles.subdivisionId, hasCoast: tiles.hasCoast })
        .from(tiles)
        .where(eq(tiles.id, tileId));
      if (!existing) {
        await tx.insert(tiles).values({ id: tileId, bbox: sql`${box}`, subdivisionId: label, hasCoast: geo!.hasCoast, cycleDays });
      } else if (existing.subdivisionId !== label || existing.hasCoast !== geo!.hasCoast) {
        await tx.update(tiles).set({ subdivisionId: label, hasCoast: geo!.hasCoast }).where(eq(tiles.id, tileId));
      }
    }
    return { tiles: tileCount, coast };
  });
}

/**
 * The run scope of a subdivision: valid coast tiles whose box meets its polygon, ordered by id. A tile on a border
 * is in the scope of both neighbours, whatever its label says.
 */
export async function subdivisionTileIds(db: Db, subdivisionId: string): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(
    sql`SELECT t.id FROM tiles t JOIN subdivisions s ON s.id = ${subdivisionId}
        WHERE t.has_coast AND t.valid_to IS NULL AND ST_Intersects(t.bbox, s.geom) AND NOT ST_Touches(t.bbox, s.geom)
        ORDER BY t.id`,
  );
  return rows.map((r) => r.id);
}
