import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { withRollback } from "@/test/db";
import { insertLandBox, SEA } from "@/test/fixtures/land-box";
import { predictShares } from "../prediction";
import type { RenderCamera } from "../render-plan";

const cfg = getConfig().images;

/** 260 m up, 40° tilt, south of SEA looking north at it. */
const camera: RenderCamera = {
  target: SEA,
  azimuthDeg: 180,
  heightM: 260,
  distanceM: 260 / Math.tan((40 * Math.PI) / 180),
  tiltDeg: 40,
  fovDeg: cfg.camera.fovDeg,
  width: cfg.camera.width,
  height: cfg.camera.height,
  zoom: "z1",
};

describe("predictShares", () => {
  it("without land everything below the horizon is water", () =>
    withRollback(async (tx) => {
      const s = await predictShares(tx, camera, cfg);
      expect(s.land).toBe(0);
      expect(s.water + s.sky).toBeCloseTo(1, 9);
      expect(s.water).toBeGreaterThan(0.9);
    }));

  it("land behind the target covers the upper part", () =>
    withRollback(async (tx) => {
      await insertLandBox(tx, SEA, -5_000, 100, 5_000, 5_000);
      const s = await predictShares(tx, camera, cfg);
      expect(s.land).toBeGreaterThan(0.3);
      expect(s.water).toBeGreaterThan(0.3);
      expect(s.water + s.land + s.sky).toBeCloseTo(1, 9);
    }));
});
