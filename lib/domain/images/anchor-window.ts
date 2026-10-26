import { sql } from "drizzle-orm";
import type { ImagesConfig, ZoomLevel } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { fitCamera } from "./fit";
import type { PlaceImageInput } from "./place-input";
import { predictSharesBatch } from "./prediction";
import { projectGround } from "./projection";
import { camerasOverWater, candidateAzimuths, floorHeightFor, landDistances, type LonLat, type RenderCamera } from "./render-plan";

const RAD = Math.PI / 180;
const KY = 110_540;
const CIRCLE_VERTICES = 24;
/** A highlight counts when it lies this far inside the image edges (NDC). */
const HIGHLIGHT_IN_FRAME = 0.95;

const kxAt = (lat: number) => 111_320 * Math.cos(lat * RAD);
const normalise = (deg: number) => ((deg % 360) + 360) % 360;
const angleOff = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
const move = (p: LonLat, east: number, north: number): LonLat => [p[0] + east / kxAt(p[1]), p[1] + north / KY];

function circle(c: LonLat, radiusM: number): LonLat[] {
  return Array.from({ length: CIRCLE_VERTICES + 1 }, (_, i) => {
    const a = ((i % CIRCLE_VERTICES) / CIRCLE_VERTICES) * 2 * Math.PI;
    return move(c, Math.sin(a) * radiusM, Math.cos(a) * radiusM);
  });
}

export type CoastDirection = { bearingDeg: number; shore: LonLat; shoreM: number };

/**
 * The mean coastline direction from `origin` (spec 19): of the rays every `anchorWindow.rayStepDeg` up to `rayMaxM`,
 * those that meet land, as unit vectors weighted 1 / max(distance, `minRayM`). The shore point is the first land
 * along that bearing, else the nearest land. `null` without land on any ray.
 */
export async function coastDirection(db: Db, origin: LonLat, cfg: Pick<ImagesConfig, "composition">): Promise<CoastDirection | null> {
  const w = cfg.composition.anchorWindow;
  const bearings = Array.from({ length: Math.floor(360 / w.rayStepDeg) }, (_, i) => i * w.rayStepDeg);
  const rays = await landDistances(db, origin, bearings, 0, w.rayMaxM);
  let east = 0;
  let north = 0;
  rays.forEach((d, i) => {
    if (d === null) return;
    east += Math.sin(bearings[i]! * RAD) / Math.max(d, w.minRayM);
    north += Math.cos(bearings[i]! * RAD) / Math.max(d, w.minRayM);
  });
  if (rays.every((d) => d === null) || (east === 0 && north === 0)) return null;
  const bearingDeg = normalise(Math.atan2(east, north) / RAD);
  const [ahead] = await landDistances(db, origin, [bearingDeg], 0, w.rayMaxM);
  if (ahead !== null && ahead !== undefined) {
    return { bearingDeg, shore: move(origin, Math.sin(bearingDeg * RAD) * ahead, Math.cos(bearingDeg * RAD) * ahead), shoreM: ahead };
  }
  const { rows } = await db.execute<{ lon: number; lat: number; d: number }>(sql`
    with o as (select ST_SetSRID(ST_MakePoint(${origin[0]}::float8, ${origin[1]}::float8), 4326) as p),
    q as (select ST_ClosestPoint(l.geom, o.p) as g from land_polygons l, o order by l.geom <-> o.p limit 1)
    select ST_X(q.g) as lon, ST_Y(q.g) as lat, ST_Distance(q.g::geography, o.p::geography) as d from q, o`);
  const r = rows[0]!;
  return { bearingDeg, shore: [Number(r.lon), Number(r.lat)], shoreM: Number(r.d) };
}

type Highlight = { at: LonLat; category: string; distM: number };

async function highlightsNear(db: Db, origin: LonLat, cfg: ImagesConfig["composition"]["anchorWindow"]): Promise<Highlight[]> {
  const categories = Object.keys(cfg.highlightWeights);
  if (categories.length === 0) return [];
  const { rows } = await db.execute<{ lon: number; lat: number; category: string; d: number }>(sql`
    with o as (select ST_SetSRID(ST_MakePoint(${origin[0]}::float8, ${origin[1]}::float8), 4326) as p)
    select ST_X(g.centroid) as lon, ST_Y(g.centroid) as lat, g.category::text as category,
           ST_Distance(g.centroid::geography, o.p::geography) as d
    from geo_objects g, o
    where g.type = 'poi' and g.valid_to is null and g.merged_into_id is null
      and g.category::text = any(${`{${categories.join(",")}}`}::text[])
      and ST_DWithin(g.centroid::geography, o.p::geography, ${cfg.highlightReachM}::float8)
    order by g.id`);
  return rows.map((r) => ({ at: [Number(r.lon), Number(r.lat)], category: r.category, distM: Number(r.d) }));
}

/** Sum over categories of the highest weight among the highlights in the frame of `camera` (doubled when near). */
function highlightScore(camera: RenderCamera, highlights: Highlight[], cfg: ImagesConfig["composition"]["anchorWindow"]): number {
  if (highlights.length === 0) return 0;
  const ndc = projectGround(camera, highlights.map((h) => h.at));
  const best = new Map<string, number>();
  highlights.forEach((h, i) => {
    const p = ndc[i];
    if (!p || Math.abs(p[0]) > HIGHLIGHT_IN_FRAME || Math.abs(p[1]) > HIGHLIGHT_IN_FRAME) return;
    const weight = (cfg.highlightWeights[h.category] ?? 0) * (h.distM <= cfg.highlightNearM ? 2 : 1);
    best.set(h.category, Math.max(best.get(h.category) ?? 0, weight));
  });
  return [...best.values()].reduce((a, b) => a + b, 0);
}

export type AnchorWindowPlan = { camera: RenderCamera; score: number; water: number };

/**
 * Title camera of an anchorage or mooring field (spec 19, part A): the anchor window along the coastline
 * (`coastDirection` from the centre). For each window radius the window point lies that far before the shore point
 * towards the centre (the centre itself when it is nearer); each tilt × focus centre × azimuth within `spanDeg` of the
 * direct view onto the shore point is fitted (`fitCamera`, no lower than the height of `floorZoom` at that tilt, `floorHeightFor`), kept when its
 * ground point is over water, and scored (`predictSharesBatch`: one query for all, highlights in frame). The lowest score wins; ties keep the
 * earlier candidate, so the plan is deterministic. `null` without land near the centre or without any camera.
 */
export async function planAnchorWindow(
  db: Db,
  input: PlaceImageInput,
  floorZoom: ZoomLevel,
  cfg: Pick<ImagesConfig, "camera" | "composition">,
): Promise<AnchorWindowPlan | null> {
  const w = cfg.composition.anchorWindow;
  const centre: LonLat = [input.lon, input.lat];
  const coast = await coastDirection(db, centre, cfg);
  if (!coast) return null;
  const highlights = await highlightsNear(db, centre, w);
  const kx = kxAt(coast.shore[1]);

  const candidates: Array<{ camera: RenderCamera; off: number }> = [];
  for (const radius of w.radiiM) {
    const t = coast.shoreM > radius ? radius / coast.shoreM : 1;
    const spot: LonLat = [coast.shore[0] + (centre[0] - coast.shore[0]) * t, coast.shore[1] + (centre[1] - coast.shore[1]) * t];
    const view = normalise(Math.atan2((coast.shore[0] - spot[0]) * kx, (coast.shore[1] - spot[1]) * KY) / RAD);
    const base = normalise(Math.round((view + 180) / cfg.camera.rotateStepDeg) * cfg.camera.rotateStepDeg);
    const rings = [circle(spot, radius), circle(coast.shore, w.shoreRadiusM)];
    for (const tiltDeg of w.tilts) {
      for (const centreY of w.centres) {
        for (const az of candidateAzimuths(base, cfg.camera.rotateStepDeg)) {
          const off = angleOff(az, base);
          if (off > w.spanDeg) continue;
          const camera = fitCamera(rings, az, { tiltDeg, fill: w.fill, centreY, minHeightM: floorHeightFor(floorZoom, tiltDeg, cfg), zoom: floorZoom }, cfg);
          if (camera) candidates.push({ camera, off });
        }
      }
    }
  }
  const overWater = await camerasOverWater(db, candidates.map((c) => c.camera));
  const kept = candidates.filter((_, i) => overWater[i]);
  const shares = await predictSharesBatch(db, kept.map((c) => c.camera), cfg);
  let best: AnchorWindowPlan | null = null;
  for (const [i, { camera, off }] of kept.entries()) {
    const { water } = shares[i]!;
    const score =
      Math.abs(water - w.targetWater) * w.score.water +
      off / w.score.offDegPerPoint +
      Math.max(0, camera.heightM - w.maxHeightM) / w.score.heightMPerPoint -
      highlightScore(camera, highlights, w) * w.score.highlightFactor;
    if (!best || score < best.score) best = { camera, score, water };
  }
  return best;
}
