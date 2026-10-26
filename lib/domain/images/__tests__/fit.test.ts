import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { fitCamera } from "../fit";
import { projectGround } from "../projection";
import type { LonLat } from "../render-plan";

const cfg = getConfig().images;
const C: LonLat = [23.5, 37.5];
const KY = 110_540;
const KX = 111_320 * Math.cos((C[1] * Math.PI) / 180);

/** Square of `sideM` around C. */
const square = (sideM: number): LonLat[][] => {
  const h = sideM / 2;
  return [[[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([e, n]) => [C[0] + e! / KX, C[1] + n! / KY] as LonLat)];
};

const opts = { tiltDeg: 40, fill: 0.6, centreY: -0.1, minHeightM: 100, zoom: "z3" as const };

describe("fitCamera", () => {
  it("a 200 m square fits inside the safe area at fill 0.6", () => {
    const camera = fitCamera(square(200), 180, opts, cfg)!;
    expect(camera).not.toBeNull();
    const pts = projectGround(camera, square(200)[0]!);
    for (const p of pts) {
      expect(Math.abs(p![0])).toBeLessThanOrEqual(0.8);
      expect(Math.abs(p![1])).toBeLessThanOrEqual(0.8);
    }
    const ys = pts.map((p) => p![1]);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(-0.1, 1);
    expect(camera.tiltDeg).toBe(40);
    expect(camera.zoom).toBe("z3");
    expect(camera.distanceM).toBeCloseTo(camera.heightM / Math.tan((40 * Math.PI) / 180), 6);
  });

  it("a larger square needs a higher camera", () => {
    expect(fitCamera(square(400), 180, opts, cfg)!.heightM).toBeGreaterThan(fitCamera(square(200), 180, opts, cfg)!.heightM);
  });

  it("the camera never goes below minHeightM", () => {
    expect(fitCamera(square(20), 180, { ...opts, minHeightM: 260 }, cfg)!.heightM).toBeGreaterThanOrEqual(260);
  });

  it("a focus too large for maxHeightM gives null", () => {
    expect(fitCamera(square(20_000), 180, opts, cfg)).toBeNull();
  });
});
