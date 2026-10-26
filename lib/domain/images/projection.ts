import { PerspectiveCamera, Vector3 } from "three";
import type { LonLat, RenderCamera } from "./render-plan";

/*
 * The render camera as maths (spec 19): the same three.js camera as `perspective()` in
 * `lib/pipeline/images/scene/scene.ts` and the same local frame (metres around the target: x east with
 * `kx = 111320 cos(lat)`, y north with `ky = 110540`, z up). Both must stay alike, or the plan's checks of a camera
 * (focus in frame, water share, town in frame) no longer describe the image that is rendered.
 */

const RAD = Math.PI / 180;
const KY = 110_540;
const NEAR = 1;
const FAR = 80_000;

const kxAt = (lat: number): number => 111_320 * Math.cos(lat * RAD);

function threeCamera(c: RenderCamera): PerspectiveCamera {
  const az = c.azimuthDeg * RAD;
  const tilt = c.tiltDeg * RAD;
  const camera = new PerspectiveCamera(c.fovDeg, c.width / c.height, NEAR, FAR);
  camera.up.set(0, 0, 1);
  camera.position.set(Math.sin(az) * c.distanceM, Math.cos(az) * c.distanceM, c.heightM);
  camera.lookAt(camera.position.clone().add(new Vector3(-Math.sin(az) * Math.cos(tilt), -Math.cos(az) * Math.cos(tilt), -Math.sin(tilt))));
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

/** Image coordinates (NDC, −1…1, y up) of points at sea level; `null` for a point behind the camera. */
export function projectGround(camera: RenderCamera, points: LonLat[]): Array<[x: number, y: number] | null> {
  const cam = threeCamera(camera);
  const kx = kxAt(camera.target[1]);
  return points.map(([lon, lat]) => {
    const v = new Vector3((lon - camera.target[0]) * kx, (lat - camera.target[1]) * KY, 0);
    if (v.clone().applyMatrix4(cam.matrixWorldInverse).z >= -NEAR) return null;
    v.project(cam);
    return [v.x, v.y];
  });
}

/**
 * Where the ray through `ndc` meets sea level; `null` when it points at or above the horizon or meets the sea farther
 * than `maxM` from the camera.
 */
export function groundAt(camera: RenderCamera, ndc: [number, number], maxM: number): LonLat | null {
  const cam = threeCamera(camera);
  const dir = new Vector3(ndc[0], ndc[1], 0.5).unproject(cam).sub(cam.position).normalize();
  if (dir.z >= -1e-9) return null;
  const t = -cam.position.z / dir.z;
  if (t > maxM) return null;
  const p = cam.position.clone().add(dir.multiplyScalar(t));
  return [camera.target[0] + p.x / kxAt(camera.target[1]), camera.target[1] + p.y / KY];
}
