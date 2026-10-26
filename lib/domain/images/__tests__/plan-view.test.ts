import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places } from "@/lib/db/schema";
import { insertComputation, insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertLandBox, metresFrom, SEA } from "@/test/fixtures/land-box";
import { harbourFocus } from "../harbour-focus";
import { loadPlaceImageInput } from "../place-input";
import { planView } from "../plan-view";
import { planRender } from "../render-plan";

const cfg = getConfig().images;
const rect = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n], [w, s]].map(([x, y]) => metresFrom(SEA, x!, y!));

async function basinMarina(tx: Parameters<Parameters<typeof withRollback>[0]>[0]) {
  const { objectId, placeId } = await insertPlace(tx, { lon: SEA[0], lat: SEA[1], type: "harbour" });
  await tx.update(places).set({ kind: "marina" }).where(eq(places.id, placeId));
  await tx.update(geoObjects).set({ geom: geomFromGeoJson({ type: "Polygon", coordinates: [rect(-150, -100, 150, 100)] }) }).where(eq(geoObjects.id, objectId));
  await insertComputation(tx, objectId, "anchor_area", { anchor_area: { areaM2: 1 } }, { outputs: { water: { type: "Polygon", coordinates: [rect(-140, -90, 140, 90)] }, area: null } });
  return objectId;
}

describe("planView", () => {
  it("the automatic title of a marina with a basin uses the fitted camera, a view with a zoom uses camera-3", () =>
    withRollback(async (tx) => {
      await insertLandBox(tx, SEA, -2_000, 100, 2_000, 2_000);
      const input = (await loadPlaceImageInput(tx, await basinMarina(tx), cfg))!;
      expect(await harbourFocus(tx, input, cfg)).not.toBeNull();
      const title = await planView(tx, input, { slot: "title" }, "z2", cfg);
      expect(title.ok && title.camera.tiltDeg).toBe(cfg.composition.harbour.tiltDeg);
      expect(title.ok && title.camera.zoom).toBe("z2");
      const view = await planView(tx, input, { slot: "view-2", zoom: "z2" }, "z2", cfg);
      expect(view).toEqual(await planRender(tx, input, "z2", cfg, null));
    }));

  it("an anchorage on open sea falls back to camera-3", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { lon: SEA[0], lat: SEA[1] });
      const input = (await loadPlaceImageInput(tx, objectId, cfg))!;
      expect(await planView(tx, input, { slot: "title" }, "z2", cfg)).toEqual(await planRender(tx, input, "z2", cfg, null));
    }));

  it("the fitted camera never goes below the height of the title zoom", () =>
    withRollback(async (tx) => {
      await insertLandBox(tx, SEA, -2_000, 100, 2_000, 2_000);
      const input = (await loadPlaceImageInput(tx, await basinMarina(tx), cfg))!;
      const plan = await planView(tx, input, { slot: "title" }, "z1", cfg);
      expect(plan.ok && plan.camera.heightM).toBeGreaterThanOrEqual(cfg.camera.zooms.z1.heightM);
    }));
});
