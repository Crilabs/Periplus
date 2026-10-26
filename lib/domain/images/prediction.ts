import { sql } from "drizzle-orm";
import type { ImagesConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { groundAt } from "./projection";
import type { LonLat, RenderCamera } from "./render-plan";

export type Shares = { water: number; land: number; sky: number };

/** The sea-level points of the view rays of the `prediction` grid; `null` for a ray above the horizon or beyond `maxRayM`. */
function gridGround(camera: RenderCamera, cfg: Pick<ImagesConfig, "composition">): LonLat[] {
  const { gridX, gridY, maxRayM } = cfg.composition.prediction;
  const ground: LonLat[] = [];
  for (let j = 0; j < gridY; j++) {
    for (let i = 0; i < gridX; i++) {
      const p = groundAt(camera, [-1 + (2 * i + 1) / gridX, 1 - (2 * j + 1) / gridY], maxRayM);
      if (p) ground.push(p);
    }
  }
  return ground;
}

/**
 * Shares of water, land and sky in the image of `camera`, without a render (spec 19, part B): the view rays through the
 * centres of a `prediction.gridX` × `gridY` grid cut at sea level (`groundAt`); a ray above the horizon or beyond
 * `maxRayM` is sky, a ground point inside `land_polygons` land, every other water.
 */
export async function predictShares(db: Db, camera: RenderCamera, cfg: Pick<ImagesConfig, "composition">): Promise<Shares> {
  return (await predictSharesBatch(db, [camera], cfg))[0]!;
}

/**
 * `predictShares` for many cameras in one query, in camera order: the land within the box of every ground point is
 * cut out once (`ST_Collect` of the clipped land polygons, prepared once for all points), then each point is tested
 * against it. The anchor window scores dozens of cameras per place, so one round trip instead of one per camera.
 */
export async function predictSharesBatch(db: Db, cameras: RenderCamera[], cfg: Pick<ImagesConfig, "composition">): Promise<Shares[]> {
  const { gridX, gridY } = cfg.composition.prediction;
  const n = gridX * gridY;
  const grounds = cameras.map((c) => gridGround(c, cfg));
  const all = grounds.flatMap((g, k) => g.map((p) => [p[0], p[1], k] as const));
  const land = new Array<number>(cameras.length).fill(0);
  if (all.length > 0) {
    const lons = all.map((p) => p[0]);
    const lats = all.map((p) => p[1]);
    const box = sql`ST_MakeEnvelope(${Math.min(...lons)}::float8, ${Math.min(...lats)}::float8, ${Math.max(...lons)}::float8, ${Math.max(...lats)}::float8, 4326)`;
    const { rows } = await db.execute<{ k: number | string; land: number | string }>(sql`
      with clip as (
        select ST_Collect(ST_Intersection(l.geom, ${box})) as g from land_polygons l where l.geom && ${box}
      )
      select t.k, count(*) as land
      from unnest(${`{${lons.join(",")}}`}::float8[], ${`{${lats.join(",")}}`}::float8[], ${`{${all.map((p) => p[2]).join(",")}}`}::int[]) as t(lon, lat, k), clip
      where clip.g is not null and ST_Intersects(clip.g, ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326))
      group by t.k`);
    for (const r of rows) land[Number(r.k)] = Number(r.land);
  }
  return grounds.map((g, k) => ({ water: (g.length - land[k]!) / n, land: land[k]! / n, sky: (n - g.length) / n }));
}
