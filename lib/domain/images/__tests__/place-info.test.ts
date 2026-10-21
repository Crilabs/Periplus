import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places } from "@/lib/db/schema";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestSubdivision } from "@/test/text";
import { loadImagePlaceInfo } from "../place-info";

/*
 * What the review panel and the image tab say about the place an image shows (spec 13, UI-Anteil). Rolled-back
 * fixtures at 19.37° E / 36.61° N (open sea west of the Peloponnese), as in place-input.test.ts.
 */
const cfg = getConfig().images;
const LON = 19.37;
const LAT = 36.61;

describe("loadImagePlaceInfo", () => {
  it("name, ids, Landesteil, anchor point and cove point of an anchorage", async () => {
    await withRollback(async (tx) => {
      const sd = await insertTestSubdivision(tx, "XT-image-info", [19.3, 36.5, 19.5, 36.7]);
      const { objectId, placeId } = await insertPlace(tx, { lon: LON, lat: LAT, name: "Ormos Dokos" });
      // the anchor point 480 m west of the bay's point
      await tx
        .update(places)
        .set({ publicId: "sp_test_info", anchorPosition: geomFromGeoJson({ type: "Point", coordinates: [LON - 480 / 89_390, LAT] }) })
        .where(eq(places.id, placeId));
      await tx.update(geoObjects).set({ subdivisionId: sd.id }).where(eq(geoObjects.id, objectId));

      const info = (await loadImagePlaceInfo(tx, objectId, cfg))!;
      expect(info).toMatchObject({ geoObjectId: objectId, placeId, publicId: "sp_test_info", name: "Ormos Dokos", kind: "anchorage", composition: "open_water", town: null });
      expect(info.subdivision).toMatchObject({ key: "XT-image-info" });
      expect(info.centre.anchor).toBe(true);
      expect(info.centre.lon).toBeCloseTo(LON - 480 / 89_390, 9);
      expect(info.centre.lat).toBeCloseTo(LAT, 9);
      expect(info.cove).toEqual({ lon: LON, lat: LAT });
    });
  });

  it("near a town: the town's name and distance; without an anchor point the position is the centre", async () => {
    await withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { lon: LON, lat: LAT });
      const townId = await insertNamedObject(tx, { type: "settlement", names: [{ name: "Poros" }], lon: LON, lat: LAT + 1000 / 110_960 });
      await tx.update(geoObjects).set({ tags: { place: "town" } }).where(eq(geoObjects.id, townId));

      const info = (await loadImagePlaceInfo(tx, objectId, cfg))!;
      expect(info.composition).toBe("near_town");
      expect(info.town).toMatchObject({ geoObjectId: townId, name: "Poros" });
      expect(Math.abs(info.town!.distanceM - 1000)).toBeLessThanOrEqual(2);
      expect(info.centre).toEqual({ lon: LON, lat: LAT, anchor: false });
      expect(info.cove).toBeNull();
      expect(info.subdivision).toBeNull();
    });
  });

  it("unknown geo object → null", async () => {
    await withRollback(async (tx) => {
      expect(await loadImagePlaceInfo(tx, "00000000-0000-7000-8000-00000000dead", cfg)).toBeNull();
    });
  });
});
