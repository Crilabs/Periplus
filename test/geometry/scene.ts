import { eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places, type GeoObjectType, type PlaceStatus } from "@/lib/db/schema";
import type { LonLat } from "@/lib/domain/geometry/water";
import { createReviewTask } from "@/lib/domain/review";
import { insertTestRaster } from "./raster";
import { circle, difference, insertLand, lonLatOf, rect, SYNTHETIC_SRID } from "./synthetic";

export const SCENE_LAND_VERSION = "scene-land-1";
export const SCENE_SEABED_VERSION = "scene-seabed-1";
export const SCENE_ROADS_VERSION = "scene-roads-1";

export type ScenePlace = { placeId: string; geoObjectId: string; position: LonLat; tileId: string };

export type BayScene = ScenePlace & { settlementId: string; seabedAreaKey: string };

const point = (p: LonLat): GeoJSON.Point => ({ type: "Point", coordinates: [p.lon, p.lat] });

/**
 * A place on a geo object (default a bay point) at (x, y) metres from the synthetic reference point, with an
 * open `place_candidate` review task when its status is `candidate`. Write it only inside `withRollback`.
 */
export async function insertScenePlace(
  tx: Db,
  x: number,
  y: number,
  opts: { status?: PlaceStatus; type?: GeoObjectType; mergedIntoId?: string; ended?: boolean } = {},
): Promise<ScenePlace> {
  const position = await lonLatOf(tx, x, y);
  const [object] = await tx
    .insert(geoObjects)
    .values({ type: opts.type ?? "bay", origin: "osm", geom: sql`${geomFromGeoJson(point(position))}` })
    .returning({ id: geoObjects.id });
  const status = opts.status ?? "candidate";
  const [place] = await tx
    .insert(places)
    .values({
      geoObjectId: object!.id,
      kind: "anchorage",
      status,
      position: sql`${geomFromGeoJson(point(position))}`,
      mergedIntoId: opts.mergedIntoId,
      ...(opts.ended ? { validFrom: "2020-01-01", validTo: "2021-01-01" } : {}),
    })
    .returning({ id: places.id });
  const [row] = await tx.select({ tileId: places.tileId }).from(places).where(eq(places.id, place!.id));
  if (status === "candidate" && !opts.mergedIntoId && !opts.ended) {
    await createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: place!.id, context: {} });
  }
  return { placeId: place!.id, geoObjectId: object!.id, position, tileId: row!.tileId! };
}

/**
 * The bay scene of the geometry stage tests (≈ 21.0 E / 35.24 N, outside the pilot box), only inside `withRollback`:
 * - land north of y = 0 minus a 500 m circle around (0, 0): a half-circle bay open to the south;
 * - a `candidate` place on a bay point at (0, 100) with an open review task;
 * - (`raster`, default true) the synthetic 10×10 raster with its top-left corner at (−455, 555), under the place's
 *   tile: rows 1–5 (4–12 m) cover y ≈ 444 … −111, row 0 (2 m) the inner end of the bay;
 * - seabed sand west of x = 0 and mud east of it (±2 km), a settlement point at (0, 1500) and a road along y = 2500.
 */
export async function buildBayScene(tx: Db, opts: { raster?: boolean } = {}): Promise<BayScene> {
  await insertLand(tx, [await difference(tx, rect(-20000, 0, 20000, 20000), await circle(tx, 0, 0, 500))], SCENE_LAND_VERSION);
  const place = await insertScenePlace(tx, 0, 100);
  if (opts.raster ?? true) await insertTestRaster(tx, { origin: await lonLatOf(tx, -455, 555), tileId: place.tileId });

  const seabedAreaKey = `scene-${crypto.randomUUID()}`;
  for (const [substrate, wkt] of [
    ["sand", rect(-2000, -2000, 0, 2000)],
    ["mud", rect(0, -2000, 2000, 2000)],
  ] as const) {
    await tx.execute(sql`
      insert into seabed_polygons (id, substrate, area_key, dataset_version, geom)
      values (gen_random_uuid(), ${substrate}::seabed_type, ${seabedAreaKey}, ${SCENE_SEABED_VERSION},
              ST_Transform(ST_GeomFromText(${wkt}, ${SYNTHETIC_SRID}::int), 4326))`);
  }

  const [settlement] = await tx
    .insert(geoObjects)
    .values({ type: "settlement", origin: "osm", geom: sql`${geomFromGeoJson(point(await lonLatOf(tx, 0, 1500)))}` })
    .returning({ id: geoObjects.id });
  await tx.execute(sql`
    insert into roads (id, osm_id, highway, geom, dataset_version)
    values (gen_random_uuid(), ${`way/scene-${crypto.randomUUID()}`}, 'tertiary',
            ST_Transform(ST_GeomFromText(${`LINESTRING(497000 3902500, 503000 3902500)`}, ${SYNTHETIC_SRID}::int), 4326),
            ${SCENE_ROADS_VERSION})`);

  return { ...place, settlementId: settlement!.id, seabedAreaKey };
}
