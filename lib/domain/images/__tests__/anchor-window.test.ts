import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertLandBox, metresFrom, SEA } from "@/test/fixtures/land-box";
import { insertTestGeoObject } from "@/test/text";
import { coastDirection, planAnchorWindow } from "../anchor-window";
import { loadPlaceImageInput } from "../place-input";
import { cameraDetails } from "../render-plan";

const cfg = getConfig().images;

/** A bay open to the south around SEA: west shore 180 m, east shore 220 m, bay head 300 m north. */
async function uBay(tx: Db): Promise<void> {
  await insertLandBox(tx, SEA, -3_000, -3_000, -180, 3_000);
  await insertLandBox(tx, SEA, 220, -3_000, 3_000, 3_000);
  await insertLandBox(tx, SEA, -180, 300, 220, 3_000);
}

async function anchorage(tx: Db): Promise<string> {
  return (await insertPlace(tx, { lon: SEA[0], lat: SEA[1] })).objectId;
}

const angleOff = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

describe("coastDirection", () => {
  it("points into the bay head, not to the nearer side shore", () =>
    withRollback(async (tx) => {
      await uBay(tx);
      const coast = (await coastDirection(tx, SEA, cfg))!;
      // the near west shore (270°) pulls the mean towards it, but it stays nearer the bay head (0°): about 322°
      expect(angleOff(coast.bearingDeg, 0)).toBeLessThan(45);
      expect(angleOff(coast.bearingDeg, 0)).toBeLessThan(angleOff(coast.bearingDeg, 270));
      expect(coast.shoreM).toBeGreaterThan(220);
    }));

  it("open sea without land within 1500 m gives null", () =>
    withRollback(async (tx) => {
      expect(await coastDirection(tx, SEA, cfg)).toBeNull();
    }));
});

describe("planAnchorWindow", () => {
  it("looks into the bay and predicts water near 0.45", () =>
    withRollback(async (tx) => {
      await uBay(tx);
      const input = (await loadPlaceImageInput(tx, await anchorage(tx), cfg))!;
      const plan = (await planAnchorWindow(tx, input, "z3", cfg))!;
      const coast = (await coastDirection(tx, SEA, cfg))!;
      // within spanDeg of the view onto the shore point (the base is rounded to the rotation step)
      expect(angleOff(cameraDetails(plan.camera).viewBearingDeg, coast.bearingDeg)).toBeLessThanOrEqual(cfg.composition.anchorWindow.spanDeg + cfg.camera.rotateStepDeg / 2);
      expect(plan.water).toBeGreaterThan(0.3);
      expect(plan.water).toBeLessThan(0.6);
      expect(plan.camera.zoom).toBe("z3");
    }));

  it("open sea gives null", () =>
    withRollback(async (tx) => {
      const input = (await loadPlaceImageInput(tx, await anchorage(tx), cfg))!;
      expect(await planAnchorWindow(tx, input, "z3", cfg)).toBeNull();
    }));

  it("a highlight in view lowers the score", () =>
    withRollback(async (tx) => {
      await uBay(tx);
      const input = (await loadPlaceImageInput(tx, await anchorage(tx), cfg))!;
      const without = (await planAnchorWindow(tx, input, "z3", cfg))!.score;
      await insertTestGeoObject(tx, { type: "poi", category: "food", geom: geomFromGeoJson({ type: "Point", coordinates: metresFrom(SEA, 20, 320) }) });
      expect((await planAnchorWindow(tx, input, "z3", cfg))!.score).toBeLessThan(without);
    }));

  it("the same input gives the same camera twice", () =>
    withRollback(async (tx) => {
      await uBay(tx);
      const input = (await loadPlaceImageInput(tx, await anchorage(tx), cfg))!;
      expect(await planAnchorWindow(tx, input, "z3", cfg)).toEqual(await planAnchorWindow(tx, input, "z3", cfg));
    }));
});
