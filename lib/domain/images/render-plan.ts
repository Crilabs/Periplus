import { sql } from "drizzle-orm";
import type { ImagesConfig, ZoomLevel } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { PlaceImageInput } from "./place-input";

export type LonLat = [lon: number, lat: number];

/**
 * Camera of a terrain render (spec 13). The camera stands `distanceM` from `target` along `azimuthDeg` (the bearing
 * from the target to the camera's ground point), `heightM` above sea level, and looks back at the target: the view
 * direction is `azimuthDeg + 180`, tilted `tiltDeg` below the horizon.
 */
export type RenderCamera = {
  target: LonLat;
  azimuthDeg: number;
  heightM: number;
  distanceM: number;
  tiltDeg: number;
  fovDeg: number;
  width: number;
  height: number;
  zoom: ZoomLevel;
};

export type RenderPlan = { ok: true; camera: RenderCamera } | { ok: false; reason: "no_water_view" };

const RAD = Math.PI / 180;
const WGS84_A = 6_378_137;
const WGS84_E2 = 0.006_694_379_990_14;

function normalise(deg: number): number {
  const a = deg % 360;
  return a < 0 ? a + 360 : a;
}

/** Metres per degree of latitude and longitude at `lat` (WGS84 meridian and prime-vertical radii). */
function metresPerDegree(lat: number): { lat: number; lon: number } {
  const s = Math.sin(lat * RAD);
  const w = Math.sqrt(1 - WGS84_E2 * s * s);
  return { lat: ((WGS84_A * (1 - WGS84_E2)) / (w * w * w)) * RAD, lon: (WGS84_A / w) * Math.cos(lat * RAD) * RAD };
}

/** `from` moved `distanceM` along `azimuthDeg` (local tangent plane; exact enough for a few kilometres). */
function destination(from: LonLat, distanceM: number, azimuthDeg: number): LonLat {
  const m = metresPerDegree(from[1]);
  return [from[0] + (distanceM * Math.sin(azimuthDeg * RAD)) / m.lon, from[1] + (distanceM * Math.cos(azimuthDeg * RAD)) / m.lat];
}

/** Ground distance and bearing from `a` to `b` (local tangent plane at their mean latitude). */
function offset(a: LonLat, b: LonLat): { distanceM: number; azimuthDeg: number } {
  const m = metresPerDegree((a[1] + b[1]) / 2);
  const east = (b[0] - a[0]) * m.lon;
  const north = (b[1] - a[1]) * m.lat;
  return { distanceM: Math.hypot(east, north), azimuthDeg: normalise(Math.atan2(east, north) / RAD) };
}

/** Where an image was taken from; stored on `place_images` and shown in the contract and the UI. */
export type CameraDetails = {
  position: LonLat;
  heightM: number;
  /** Clockwise from north, the direction the camera looks. */
  viewBearingDeg: number;
  tiltDeg: number;
  fovDeg: number;
};

/** Camera position (target moved `distanceM` along `azimuthDeg`), height, view bearing (`azimuthDeg + 180`), tilt, field of view. */
export function cameraDetails(camera: RenderCamera): CameraDetails {
  return {
    position: destination(camera.target, camera.distanceM, camera.azimuthDeg),
    heightM: camera.heightM,
    viewBearingDeg: normalise(camera.azimuthDeg + 180),
    tiltDeg: camera.tiltDeg,
    fovDeg: camera.fovDeg,
  };
}

/** The opening bearing, else the bearing of the longest fetch ray (ray i at `i · rayStepDeg`), else `null`. */
export function baseAzimuth(openingBearing: number | null, rays: number[] | null, rayStepDeg: number): number | null {
  if (openingBearing !== null) return openingBearing;
  if (!rays || rays.length === 0) return null;
  let longest = 0;
  for (let i = 1; i < rays.length; i++) if (rays[i]! > rays[longest]!) longest = i;
  return normalise(longest * rayStepDeg);
}

/** `base, base+step, base−step, base+2·step, …` up to ±180°, normalised to [0, 360), without repeats. */
export function candidateAzimuths(base: number, stepDeg: number): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  const push = (deg: number) => {
    const a = normalise(deg);
    const key = a.toFixed(9);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a);
  };
  push(base);
  for (let k = 1; k * stepDeg <= 180; k++) {
    push(base + k * stepDeg);
    push(base - k * stepDeg);
  }
  return out;
}

/**
 * Fetch (metres) along `bearingDeg` from the rays of the centre (ray i at `i · 360 / rays.length`), interpolated
 * linearly between the two neighbouring rays; `null` without rays.
 */
export function shoreDistance(rays: number[] | null, bearingDeg: number): number | null {
  if (!rays || rays.length === 0) return null;
  const pos = normalise(bearingDeg) / (360 / rays.length);
  const i = Math.floor(pos) % rays.length;
  const t = pos - Math.floor(pos);
  return rays[i]! * (1 - t) + rays[(i + 1) % rays.length]! * t;
}

/**
 * How far behind the shoreline the open-water target lies at `zoom`, so that the shoreline runs
 * `composition.openWater.shoreBelowCentreDeg` below the image centre (8.3° ≈ fov/6: the lower-third line, a strip
 * of water at the bottom and the coast filling the image): the camera stands `d = h / tan(tilt)` before its target
 * but only `ds = h / tan(tilt + angle)` before the shoreline, so the target lies `d − ds` inland of it.
 */
export function inlandOffsetM(zoom: ZoomLevel, cfg: Pick<ImagesConfig, "camera" | "composition">): number {
  const h = cfg.camera.zooms[zoom].heightM;
  const tilt = cfg.camera.tiltDeg;
  return h / Math.tan(tilt * RAD) - h / Math.tan((tilt + cfg.composition.openWater.shoreBelowCentreDeg) * RAD);
}

/**
 * Target of the open-water composition for the camera side `azimuthDeg` and a shore `shoreM` ahead along the view
 * direction (`azimuthDeg + 180`; from the fetch rays or the named cove's land query): the centre moved
 * `shoreM + inlandOffsetM` along the view, so the shoreline runs through the lower third of the image. The centre
 * itself (the same array) without a shore distance or when the shore ahead is farther than
 * `composition.openWater.maxShoreM` (open sea ahead). Decision Christian, 21.10.2026, after review feedback: with
 * the centre as target the image showed water below and the bay far away at the top.
 */
export function openWaterTarget(
  centre: LonLat,
  shoreM: number | null,
  azimuthDeg: number,
  zoom: ZoomLevel,
  cfg: Pick<ImagesConfig, "camera" | "composition">,
): LonLat {
  if (shoreM === null || shoreM > cfg.composition.openWater.maxShoreM) return centre;
  return destination(centre, shoreM + inlandOffsetM(zoom, cfg), normalise(azimuthDeg + 180));
}

/** Open-water camera: at the zoom height, `heightM / tan(tilt)` from the target along `azimuthDeg`. */
export function cameraFor(target: LonLat, azimuthDeg: number, zoom: ZoomLevel, cfg: Pick<ImagesConfig, "camera">): RenderCamera {
  const c = cfg.camera;
  const heightM = c.zooms[zoom].heightM;
  return {
    target,
    azimuthDeg: normalise(azimuthDeg),
    heightM,
    distanceM: heightM / Math.tan(c.tiltDeg * RAD),
    tiltDeg: c.tiltDeg,
    fovDeg: c.fovDeg,
    width: c.width,
    height: c.height,
    zoom,
  };
}

/**
 * Size on screen (pixels) of one source pixel of `resolutionM` at the bottom edge of the image, the nearest ground:
 * `resolutionM · f / d` with focal length `f = (height/2) / tan(fov/2)` and slant distance
 * `d = heightM / sin(tilt + fov/2)`.
 */
export function foregroundPixelSize(
  resolutionM: number,
  zoom: ZoomLevel,
  cfg: Pick<ImagesConfig, "camera">,
  tiltDeg: number = cfg.camera.tiltDeg,
): number {
  const c = cfg.camera;
  const f = c.height / 2 / Math.tan((c.fovDeg / 2) * RAD);
  const d = c.zooms[zoom].heightM / Math.sin((tiltDeg + c.fovDeg / 2) * RAD);
  return (resolutionM * f) / d;
}

/**
 * Lowest height of a camera at `tiltDeg` whose foreground is as sharp as the zoom level at the configured tilt
 * (spec 19, the floor of a fitted camera): the bottom edge's slant distance `h / sin(tilt + fov/2)` equals the
 * zoom's, so `foregroundPixelSize` is the same.
 */
export function floorHeightFor(zoom: ZoomLevel, tiltDeg: number, cfg: Pick<ImagesConfig, "camera">): number {
  const c = cfg.camera;
  return (c.zooms[zoom].heightM * Math.sin((tiltDeg + c.fovDeg / 2) * RAD)) / Math.sin((c.tiltDeg + c.fovDeg / 2) * RAD);
}

/**
 * Zoom levels at which a source pixel of `resolutionM` stays within `render.maxSourcePixelOnScreen` in the foreground
 * (at the configured tilt); the widest level `z1` is always allowed.
 */
export function allowedZooms(resolutionM: number, cfg: Pick<ImagesConfig, "camera" | "render">): ZoomLevel[] {
  return (Object.keys(cfg.camera.zooms) as ZoomLevel[]).filter(
    (z) => z === "z1" || foregroundPixelSize(resolutionM, z, cfg) <= cfg.render.maxSourcePixelOnScreen,
  );
}

/**
 * Zoom of the automatic title image: `composition.openWater.zoom` when core imagery of `coreResolutionM` allows it (`allowedZooms`), else the closest
 * allowed level below it (`z1` is always allowed). `coreResolutionM` null (the imagery is not known yet) gives the
 * wanted level. An explicit zoom of a view (an admin's choice) is not subject to this. Decision Christian,
 * 21.10.2026: the title image shows the anchorage at z2. Since spec 19 its height is the floor of the fitted title
 * camera (`planView`).
 */
export function titleZoomFor(
  coreResolutionM: number | null,
  cfg: Pick<ImagesConfig, "camera" | "composition" | "render">,
): ZoomLevel {
  const wanted = cfg.composition.openWater.zoom;
  if (coreResolutionM === null) return wanted;
  const levels = Object.keys(cfg.camera.zooms) as ZoomLevel[];
  const allowed = allowedZooms(coreResolutionM, cfg);
  return levels.slice(0, levels.indexOf(wanted) + 1).filter((z) => allowed.includes(z)).at(-1) ?? "z1";
}

/**
 * Where the rotation starts: the opening bearing or the longest fetch ray (`baseAzimuth`; the rays cover the
 * full circle, so their step is `360 / rays.length`).
 */
export function baseAzimuthFor(input: PlaceImageInput): number | null {
  return baseAzimuth(input.openingBearing, input.rays, input.rays && input.rays.length > 0 ? 360 / input.rays.length : 0);
}

/**
 * Index of the first candidate (origin `origins[i]`, azimuth `azimuths[i]`) for which every point `origin` moved
 * `distance` along the azimuth (for all `distancesM`, geodesic `ST_Project`) lies outside `land_polygons`; `null` if
 * none does. One query over all candidates.
 */
async function firstOverWater(db: Db, origins: LonLat[], azimuths: number[], distancesM: number[]): Promise<number | null> {
  const { rows } = await db.execute<{ i: number | string }>(sql`
    select t.i
    from unnest(${`{${azimuths.join(",")}}`}::float8[],
                ${`{${origins.map((o) => o[0]).join(",")}}`}::float8[],
                ${`{${origins.map((o) => o[1]).join(",")}}`}::float8[]) with ordinality as t(az, lon, lat, i)
    where not exists (
      select 1
      from unnest(${`{${distancesM.join(",")}}`}::float8[]) as d(m)
      cross join lateral (
        select ST_Project(ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography, d.m, radians(t.az))::geometry as p
      ) q
      join land_polygons l on l.geom && q.p and ST_Intersects(l.geom, q.p)
    )
    order by t.i
    limit 1`);
  return rows[0] ? Number(rows[0].i) - 1 : null;
}

/**
 * Index of the first camera whose ground point (`cameraDetails(c).position`) lies outside `land_polygons`; `null` if
 * none does. One query for all cameras (they may stand at different distances, unlike `firstOverWater`).
 */
export async function firstCameraOverWater(db: Db, cameras: RenderCamera[]): Promise<number | null> {
  const index = (await camerasOverWater(db, cameras)).indexOf(true);
  return index < 0 ? null : index;
}

/** For each camera, whether its ground point (`cameraDetails(c).position`) lies outside `land_polygons`; one query. */
export async function camerasOverWater(db: Db, cameras: RenderCamera[]): Promise<boolean[]> {
  if (cameras.length === 0) return [];
  const ground = cameras.map((c) => cameraDetails(c).position);
  const { rows } = await db.execute<{ i: number | string }>(sql`
    select t.i
    from unnest(${`{${ground.map((p) => p[0]).join(",")}}`}::float8[], ${`{${ground.map((p) => p[1]).join(",")}}`}::float8[]) with ordinality as t(lon, lat, i)
    where exists (
      select 1 from land_polygons l
      where l.geom && ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326) and ST_Intersects(l.geom, ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326))
    )`);
  const onLand = new Set(rows.map((r) => Number(r.i) - 1));
  return cameras.map((_, i) => !onLand.has(i));
}

/**
 * For each bearing, the distance (metres) from `origin` to the first land along it between `fromM` and `maxM` out
 * (`land_polygons` cut by that segment), `null` where there is none. One query over all bearings.
 */
export async function landDistances(db: Db, origin: LonLat, bearings: number[], fromM: number, maxM: number): Promise<Array<number | null>> {
  if (bearings.length === 0 || fromM >= maxM) return bearings.map(() => null);
  const { rows } = await db.execute<{ i: number | string; m: number | string | null }>(sql`
    with o as (select ST_SetSRID(ST_MakePoint(${origin[0]}::float8, ${origin[1]}::float8), 4326)::geography as p),
    ray as (
      select t.i,
             ST_MakeLine(ST_Project(o.p, ${fromM}::float8, radians(t.b))::geometry, ST_Project(o.p, ${maxM}::float8, radians(t.b))::geometry) as seg
      from unnest(${`{${bearings.join(",")}}`}::float8[]) with ordinality as t(b, i), o
    )
    select ray.i,
           (select min(ST_Distance(o.p, ST_Intersection(ray.seg, l.geom)::geography))
            from land_polygons l, o
            where l.geom && ray.seg and ST_Intersects(l.geom, ray.seg)) as m
    from ray
    order by ray.i`);
  return rows.map((r) => (r.m === null ? null : Number(r.m)));
}

/**
 * Camera for an image of a place at `zoom`. The azimuth starts at `azimuthOverride` (an additional view an admin
 * asked for), else at the rule's base, and turns in `camera.rotateStepDeg` steps until the camera is over water:
 * its ground point must be, with the target `openWaterTarget` of the shore ahead; the rules in turn until one yields a
 * camera:
 * 1. the named cove (`input.cove`): the camera stands over the anchorage and looks at the cove point (base: the
 *    bearing cove → anchor point); each candidate's shore is the first land along its view direction from the
 *    anchor point beyond the cove point's distance (`landDistances`, within `maxShoreM`; a view without land there
 *    is no candidate);
 * 2. the fetch rays (base: `baseAzimuthFor`): each candidate's shore is the fetch along its view direction;
 * 3. the same candidates with the centre as target (the rule before camera-3).
 * The light rule stays the same with an override. `no_water_view` when no azimuth qualifies (an
 * enclosed place). Decision Christian, 21.10.2026: the title image shows the named cove, the camera over the
 * anchorage, the shoreline in the lower third.
 */
export async function planRender(
  db: Db,
  input: PlaceImageInput,
  zoom: ZoomLevel,
  cfg: Pick<ImagesConfig, "camera" | "composition">,
  azimuthOverride: number | null = null,
): Promise<RenderPlan> {
  const centre: LonLat = [input.lon, input.lat];
  const step = cfg.camera.rotateStepDeg;
  // the ground point lies `distanceM` from each candidate's own target
  const overWater = (cameras: RenderCamera[]) => firstOverWater(db, cameras.map((c) => c.target), cameras.map((c) => c.azimuthDeg), [cameras[0]!.distanceM]);

  if (input.cove) {
    const cove = offset(centre, input.cove);
    const candidates = candidateAzimuths(azimuthOverride ?? normalise(cove.azimuthDeg + 180), step);
    const shores = await landDistances(db, centre, candidates.map((az) => normalise(az + 180)), cove.distanceM, cfg.composition.openWater.maxShoreM);
    const cameras = candidates.flatMap((az, i) => (shores[i] === null ? [] : [cameraFor(openWaterTarget(centre, shores[i], az, zoom, cfg), az, zoom, cfg)]));
    if (cameras.length > 0) {
      const index = await overWater(cameras);
      if (index !== null) return { ok: true, camera: cameras[index]! };
    }
  }

  const candidates = candidateAzimuths(azimuthOverride ?? baseAzimuthFor(input) ?? 0, step);
  const shifted = candidates.map((az) => cameraFor(openWaterTarget(centre, shoreDistance(input.rays, normalise(az + 180)), az, zoom, cfg), az, zoom, cfg));
  const stages = [shifted];
  // `openWaterTarget` hands back `centre` itself when it does not shift: a further stage only when the first differs
  if (shifted.some((c) => c.target !== centre)) stages.push(candidates.map((az) => cameraFor(centre, az, zoom, cfg)));
  for (const cameras of stages) {
    const index = await overWater(cameras);
    if (index !== null) return { ok: true, camera: cameras[index]! };
  }
  return { ok: false, reason: "no_water_view" };
}
