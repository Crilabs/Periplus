import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { RenderCamera } from "../render-plan";
import { coreSizeFor, coreWindow, METRES_PER_DEGREE } from "../window";

const cfg = getConfig().images;

const camera = (heightM: number, tiltDeg = 40): RenderCamera => ({
  target: [23.5, 37.5],
  azimuthDeg: 180,
  heightM,
  distanceM: heightM / Math.tan((tiltDeg * Math.PI) / 180),
  tiltDeg,
  fovDeg: cfg.camera.fovDeg,
  width: cfg.camera.width,
  height: cfg.camera.height,
  zoom: "z2",
});

describe("coreSizeFor", () => {
  it("a camera at 365 m and 40° stays at 1.5 km, one at 600 m needs more", () => {
    expect(coreSizeFor(camera(365), cfg)).toBe(cfg.window.coreSizeM);
    expect(coreSizeFor(camera(600), cfg)).toBeGreaterThan(cfg.window.coreSizeM);
    expect(coreSizeFor(camera(600), cfg)).toBeLessThan(cfg.window.coreMaxSizeM);
  });

  it("a camera at 100 m stays at coreSizeM", () => {
    expect(coreSizeFor(camera(100), cfg)).toBe(cfg.window.coreSizeM);
  });

  it("the size never exceeds coreMaxSizeM", () => {
    expect(coreSizeFor(camera(900, 20), cfg)).toBe(cfg.window.coreMaxSizeM);
  });
});

describe("coreWindow", () => {
  it("takes an explicit size", () => {
    const [, south, , north] = coreWindow(23.5, 37.5, cfg.window, 3_000);
    expect((north - south) * METRES_PER_DEGREE).toBeCloseTo(3_000, 6);
  });
});
