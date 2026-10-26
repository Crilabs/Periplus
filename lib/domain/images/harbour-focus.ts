import { sql } from "drizzle-orm";
import type { MultiPolygon, Polygon } from "geojson";
import type { ImagesConfig, ZoomLevel } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { fitCamera } from "./fit";
import type { PlaceImageInput } from "./place-input";
import { baseAzimuthFor, candidateAzimuths, firstCameraOverWater, type LonLat, type RenderCamera } from "./render-plan";

export type HarbourFocus = { source: "basin" | "structures"; rings: LonLat[][] };

const ringsOf = (g: Polygon | MultiPolygon): LonLat[][] =>
  (g.type === "Polygon" ? [g.coordinates] : g.coordinates).map((p) => p[0]!.map((c) => [c[0]!, c[1]!] as LonLat));

/**
 * What the title image of a marina or port must show whole (spec 19, part A): for a place that is an area, the water
 * area of its latest `anchor_area` computation (the basin); otherwise, or when that water is empty, the convex hull
 * of the harbour structures (OSM piers, breakwaters, groynes) within `harbour.pierRadiusM` of the centre, each widened
 * by `pierBufferM`; `null` without either (the camera-3 rule then frames the place).
 */
export async function harbourFocus(db: Db, input: PlaceImageInput, cfg: Pick<ImagesConfig, "composition">): Promise<HarbourFocus | null> {
  const { pierRadiusM, pierBufferM } = cfg.composition.harbour;
  const { rows } = await db.execute<{ basin: Polygon | MultiPolygon | null; hull: Polygon | null }>(sql`
    with o as (select geom from geo_objects where id = ${input.geoObjectId}),
    c as (
      select outputs->'water' as water from computations
      where geo_object_id = ${input.geoObjectId} and kind = 'anchor_area'
      order by created_at desc, id desc
      limit 1
    ),
    pt as (select ST_SetSRID(ST_MakePoint(${input.lon}::float8, ${input.lat}::float8), 4326) as p)
    select
      (select case when ST_Dimension(o.geom) = 2 and jsonb_typeof(c.water) = 'object'
                   then ST_AsGeoJSON(ST_GeomFromGeoJSON(c.water::text))::json end
       from o left join c on true) as basin,
      (select ST_AsGeoJSON(ST_ConvexHull(ST_Collect(ST_Buffer(h.geom::geography, ${pierBufferM}::float8)::geometry)))::json
       from harbour_structures h, pt
       where ST_DWithin(h.geom::geography, pt.p::geography, ${pierRadiusM}::float8)) as hull`);
  const row = rows[0];
  if (row?.basin && (row.basin.type === "Polygon" || row.basin.type === "MultiPolygon")) return { source: "basin", rings: ringsOf(row.basin) };
  if (row?.hull && row.hull.type === "Polygon") return { source: "structures", rings: ringsOf(row.hull) };
  return null;
}

/**
 * Title camera of a marina or port (spec 19): `fitCamera` on `harbourFocus` with `composition.harbour`, no lower than
 * the height of `floorZoom`; the azimuth starts at the rule's base (`baseAzimuthFor`) and turns in
 * `camera.rotateStepDeg` steps to the first camera whose ground point is over water. `null` without a focus or
 * without such a camera.
 */
export async function planHarbour(
  db: Db,
  input: PlaceImageInput,
  floorZoom: ZoomLevel,
  cfg: Pick<ImagesConfig, "camera" | "composition">,
): Promise<RenderCamera | null> {
  const focus = await harbourFocus(db, input, cfg);
  if (!focus) return null;
  const h = cfg.composition.harbour;
  const opts = { tiltDeg: h.tiltDeg, fill: h.fill, centreY: h.centreY, minHeightM: cfg.camera.zooms[floorZoom].heightM, zoom: floorZoom };
  const cameras = candidateAzimuths(baseAzimuthFor(input) ?? 0, cfg.camera.rotateStepDeg).flatMap((az) => {
    const c = fitCamera(focus.rings, az, opts, cfg);
    return c ? [c] : [];
  });
  const index = await firstCameraOverWater(db, cameras);
  return index === null ? null : cameras[index]!;
}
