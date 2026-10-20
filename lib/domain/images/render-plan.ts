import { sql } from "drizzle-orm";
import type { ImagesConfig, ZoomLevel } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { compositionFor } from "./light";
import type { PlaceImageInput } from "./place-input";

type LonLat = [lon: number, lat: number];

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

/**
 * Near-town composition: the segment from the place towards the camera ground point that must be over water starts
 * here (closer to the place the shore of the anchorage itself may lie in the way) and is sampled at this step.
 * Fixed by the image rule (Christian, 20.10.2026), not tuned.
 */
const NEAR_TOWN_CLEAR_FROM_M = 200;
const NEAR_TOWN_CLEAR_STEP_M = 10;

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
 * Near-town camera: its ground point is `centre` moved `composition.nearTown.foregroundM` along `azimuthDeg` (away
 * from the town), the target is the midpoint of centre and town, and the tilt follows from the geometry:
 * `atan(heightM / ground distance camera → target)`. `azimuthDeg` of the result is the bearing target → camera.
 */
export function nearTownCamera(
  centre: LonLat,
  town: LonLat,
  azimuthDeg: number,
  zoom: ZoomLevel,
  cfg: Pick<ImagesConfig, "camera" | "composition">,
): RenderCamera {
  const c = cfg.camera;
  const heightM = c.zooms[zoom].heightM;
  const ground = destination(centre, cfg.composition.nearTown.foregroundM, azimuthDeg);
  const target: LonLat = [(centre[0] + town[0]) / 2, (centre[1] + town[1]) / 2];
  const view = offset(target, ground);
  return {
    target,
    azimuthDeg: view.azimuthDeg,
    heightM,
    distanceM: view.distanceM,
    tiltDeg: Math.atan(heightM / view.distanceM) / RAD,
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
 * Zoom levels at which a source pixel of `resolutionM` stays within `render.maxSourcePixelOnScreen` in the foreground
 * (at the configured tilt); the widest level `z1` is always allowed.
 */
export function allowedZooms(resolutionM: number, cfg: Pick<ImagesConfig, "camera" | "render">): ZoomLevel[] {
  return (Object.keys(cfg.camera.zooms) as ZoomLevel[]).filter(
    (z) => z === "z1" || foregroundPixelSize(resolutionM, z, cfg) <= cfg.render.maxSourcePixelOnScreen,
  );
}

/**
 * Where the rotation starts: for `near_town` the bearing from the town to the centre (the camera stands on the far
 * side of the anchorage), otherwise the opening bearing or the longest fetch ray (`baseAzimuth`; the rays cover the
 * full circle, so their step is `360 / rays.length`).
 */
export function baseAzimuthFor(input: PlaceImageInput): number | null {
  if (compositionFor(input) === "near_town") {
    return offset([input.town!.lon, input.town!.lat], [input.lon, input.lat]).azimuthDeg;
  }
  return baseAzimuth(input.openingBearing, input.rays, input.rays && input.rays.length > 0 ? 360 / input.rays.length : 0);
}

/** Distances from the centre that must be over water for the near-town camera: 200 m to `foregroundM` every 10 m. */
function nearTownSamples(foregroundM: number): number[] {
  const out: number[] = [];
  for (let d = NEAR_TOWN_CLEAR_FROM_M; d < foregroundM; d += NEAR_TOWN_CLEAR_STEP_M) out.push(d);
  out.push(foregroundM);
  return out;
}

/**
 * Index of the first azimuth for which every point `origin` moved `distance` along it (for all `distancesM`,
 * geodesic `ST_Project`) lies outside `land_polygons`; `null` if none does. One query over all candidates.
 */
async function firstOverWater(db: Db, origin: LonLat, azimuths: number[], distancesM: number[]): Promise<number | null> {
  const { rows } = await db.execute<{ i: number | string }>(sql`
    select t.i
    from unnest(${`{${azimuths.join(",")}}`}::float8[]) with ordinality as t(az, i)
    where not exists (
      select 1
      from unnest(${`{${distancesM.join(",")}}`}::float8[]) as d(m)
      cross join lateral (
        select ST_Project(ST_SetSRID(ST_MakePoint(${origin[0]}::float8, ${origin[1]}::float8), 4326)::geography,
                          d.m, radians(t.az))::geometry as p
      ) q
      join land_polygons l on l.geom && q.p and ST_Intersects(l.geom, q.p)
    )
    order by t.i
    limit 1`);
  return rows[0] ? Number(rows[0].i) - 1 : null;
}

/**
 * Camera for the title image of a place at `zoom`. Starting at `baseAzimuthFor` (north without opening and rays),
 * the azimuth turns in `camera.rotateStepDeg` steps until the camera is over water: for `open_water` its ground
 * point, for `near_town` every point from 200 m to `foregroundM` from the centre. `no_water_view` when no azimuth
 * qualifies (an enclosed place).
 */
export async function planRender(
  db: Db,
  input: PlaceImageInput,
  zoom: ZoomLevel,
  cfg: Pick<ImagesConfig, "camera" | "composition">,
): Promise<RenderPlan> {
  const centre: LonLat = [input.lon, input.lat];
  const candidates = candidateAzimuths(baseAzimuthFor(input) ?? 0, cfg.camera.rotateStepDeg);

  const nearTown = compositionFor(input) === "near_town";
  const town: LonLat | null = nearTown ? [input.town!.lon, input.town!.lat] : null;
  const camera = (azimuthDeg: number) =>
    town ? nearTownCamera(centre, town, azimuthDeg, zoom, cfg) : cameraFor(centre, azimuthDeg, zoom, cfg);
  const samples = town ? nearTownSamples(cfg.composition.nearTown.foregroundM) : [camera(0).distanceM];

  const index = await firstOverWater(db, centre, candidates, samples);
  return index === null ? { ok: false, reason: "no_water_view" } : { ok: true, camera: camera(candidates[index]!) };
}
