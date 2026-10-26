import { sql } from "drizzle-orm";
import type { ImagesConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { groundAt } from "./projection";
import type { LonLat, RenderCamera } from "./render-plan";

export type Shares = { water: number; land: number; sky: number };

/**
 * Shares of water, land and sky in the image of `camera`, without a render (spec 19, part B): the view rays through the
 * centres of a `prediction.gridX` × `gridY` grid cut at sea level (`groundAt`); a ray above the horizon or beyond
 * `maxRayM` is sky, a ground point inside `land_polygons` land, every other water. One query for all points.
 */
export async function predictShares(db: Db, camera: RenderCamera, cfg: Pick<ImagesConfig, "composition">): Promise<Shares> {
  const { gridX, gridY, maxRayM } = cfg.composition.prediction;
  const n = gridX * gridY;
  const ground: LonLat[] = [];
  for (let j = 0; j < gridY; j++) {
    for (let i = 0; i < gridX; i++) {
      const p = groundAt(camera, [-1 + (2 * i + 1) / gridX, 1 - (2 * j + 1) / gridY], maxRayM);
      if (p) ground.push(p);
    }
  }
  if (ground.length === 0) return { water: 0, land: 0, sky: 1 };
  const { rows } = await db.execute<{ land: number | string }>(sql`
    select count(*) as land
    from unnest(${`{${ground.map((p) => p[0]).join(",")}}`}::float8[], ${`{${ground.map((p) => p[1]).join(",")}}`}::float8[]) as t(lon, lat)
    where exists (
      select 1 from land_polygons l
      where l.geom && ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326) and ST_Intersects(l.geom, ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326))
    )`);
  const land = Number(rows[0]!.land);
  return { water: (ground.length - land) / n, land: land / n, sky: (n - ground.length) / n };
}
