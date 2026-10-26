import type { ImagesConfig, ZoomLevel } from "@/lib/config";
import { projectGround } from "./projection";
import type { LonLat, RenderCamera } from "./render-plan";

const RAD = Math.PI / 180;
const KY = 110_540;

export type FitOptions = {
  tiltDeg: number;
  /** Share of the image width and height the focus may take at most (never more than the safe area). */
  fill: number;
  /** NDC y the focus centre is put at (0 = image centre, −0.1 = 5 % of the height below it). */
  centreY: number;
  /** Floor of the camera height (the zoom level's height the imagery allows). */
  minHeightM: number;
  /** The zoom level the floor comes from; carried on the camera (generation key, task context). */
  zoom: ZoomLevel;
};

/** Camera `distanceM = h / tan(tilt)` before `target` along `azimuthDeg`, `heightM` up (as `cameraFor`). */
function cameraAt(target: LonLat, azimuthDeg: number, heightM: number, o: FitOptions, cfg: Pick<ImagesConfig, "camera">): RenderCamera {
  const c = cfg.camera;
  return {
    target,
    azimuthDeg,
    heightM,
    distanceM: heightM / Math.tan(o.tiltDeg * RAD),
    tiltDeg: o.tiltDeg,
    fovDeg: c.fovDeg,
    width: c.width,
    height: c.height,
    zoom: o.zoom,
  };
}

/**
 * The lowest camera looking along `azimuthDeg + 180` that shows the focus `rings` whole (spec 19, part A): from
 * `max(minHeightM, fit.minHeightM)` up by `fit.heightStep` to `fit.maxHeightM`, at each height the target is moved
 * (at most `fit.maxIterations` times) until the focus centre sits on `centreY` and the image's centre line; the
 * camera fits when the focus extent is within `fill` (and `1 − 2·margin`) of the width and of the height below and
 * above the centre and both centre offsets are below `fit.centreTolerance`. `null` when no height fits.
 */
export function fitCamera(rings: LonLat[][], azimuthDeg: number, o: FitOptions, cfg: Pick<ImagesConfig, "camera" | "composition">): RenderCamera | null {
  const f = cfg.composition.fit;
  const pts = rings.flat();
  if (pts.length === 0) return null;
  const start: LonLat = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  const kx = 111_320 * Math.cos(start[1] * RAD);
  const az = azimuthDeg * RAD;
  // unit vectors (east, north): along the view (away from the camera) and to the right of it
  const along = [-Math.sin(az), -Math.cos(az)] as const;
  const right = [along[1], -along[0]] as const;
  const lim = Math.min(o.fill, 1 - 2 * f.margin);
  const vHalf = Math.tan((cfg.camera.fovDeg / 2) * RAD);
  const hHalf = vHalf * (cfg.camera.width / cfg.camera.height);
  for (let h = Math.max(o.minHeightM, f.minHeightM); h <= f.maxHeightM; h *= f.heightStep) {
    let target = start;
    for (let it = 0; it < f.maxIterations; it++) {
      const camera = cameraAt(target, azimuthDeg, h, o, cfg);
      const ndc = projectGround(camera, pts);
      if (ndc.some((p) => p === null)) break;
      const xs = ndc.map((p) => p![0]);
      const ys = ndc.map((p) => p![1]);
      const dx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const dy = (Math.min(...ys) + Math.max(...ys)) / 2 - o.centreY;
      const fits =
        Math.max(...xs) - Math.min(...xs) <= 2 * lim &&
        Math.max(...ys) - Math.min(...ys) <= (1 + o.centreY) * 2 * lim &&
        Math.abs(dx) < f.centreTolerance &&
        Math.abs(dy) < f.centreTolerance;
      if (fits) return camera;
      // ground metres per NDC unit near the target: across slant·tan(hfov/2), along slant·tan(vfov/2)/sin(tilt)
      const slant = h / Math.sin(o.tiltDeg * RAD);
      const across = dx * slant * hHalf;
      const ahead = (dy * slant * vHalf) / Math.sin(o.tiltDeg * RAD);
      target = [target[0] + (along[0] * ahead + right[0] * across) / kx, target[1] + (along[1] * ahead + right[1] * across) / KY];
    }
  }
  return null;
}
