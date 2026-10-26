import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { groundAt, projectGround } from "../projection";
import type { LonLat, RenderCamera } from "../render-plan";

const cfg = getConfig().images;
const TARGET: LonLat = [23.5, 37.5];
const KY = 110_540;
const KX = 111_320 * Math.cos((TARGET[1] * Math.PI) / 180);

/** Camera 260 m up, 40° tilt, standing south of the target (azimuth 180) and looking north. */
const camera: RenderCamera = {
  target: TARGET,
  azimuthDeg: 180,
  heightM: 260,
  distanceM: 260 / Math.tan((40 * Math.PI) / 180),
  tiltDeg: 40,
  fovDeg: cfg.camera.fovDeg,
  width: cfg.camera.width,
  height: cfg.camera.height,
  zoom: "z1",
};

const at = (east: number, north: number): LonLat => [TARGET[0] + east / KX, TARGET[1] + north / KY];

describe("projectGround", () => {
  it("the target projects to the image centre", () => {
    const [p] = projectGround(camera, [TARGET]);
    expect(p![0]).toBeCloseTo(0, 9);
    expect(p![1]).toBeCloseTo(0, 9);
  });

  it("a point beyond the target lies above the centre, one to the right of the view lies right", () => {
    const [beyond, right] = projectGround(camera, [at(0, 200), at(100, 0)]);
    expect(beyond![1]).toBeGreaterThan(0.05);
    expect(Math.abs(beyond![0])).toBeLessThan(1e-9);
    expect(right![0]).toBeGreaterThan(0.05);
  });

  it("a point behind the camera is null", () => {
    expect(projectGround(camera, [at(0, -camera.distanceM - 1000)])[0]).toBeNull();
  });
});

describe("groundAt", () => {
  it("inverts projectGround", () => {
    const ground = groundAt(camera, [0.5, -0.5], 20_000)!;
    const [p] = projectGround(camera, [ground]);
    const back = groundAt(camera, p!, 20_000)!;
    expect(Math.abs(back[0] - ground[0]) * KX).toBeLessThan(0.01);
    expect(Math.abs(back[1] - ground[1]) * KY).toBeLessThan(0.01);
  });

  it("a ray above the horizon is null", () => {
    // 10° tilt: the upper image edge looks 15° above the horizon
    expect(groundAt({ ...camera, tiltDeg: 10, distanceM: 260 / Math.tan((10 * Math.PI) / 180) }, [0, 0.99], 20_000)).toBeNull();
  });

  it("a ray reaching the sea beyond maxM is null", () => {
    // the upper edge at 40° tilt meets the sea about 950 m from the camera
    expect(groundAt(camera, [0, 0.99], 500)).toBeNull();
    expect(groundAt(camera, [0, 0.99], 2_000)).not.toBeNull();
  });
});
