import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places } from "@/lib/db/schema";
import { insertComputation, insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestGeoObject, insertTestSubdivision } from "@/test/text";
import { compositionFor, lightFor } from "../light";
import { loadPlaceImageInput } from "../place-input";

/*
 * Rolled-back fixtures at 19.37° E / 36.61° N (open sea west of the Peloponnese, outside the pilot box and away from
 * the other test fixtures). A degree of latitude is ~110 960 m there, so `northM / 111_000` is a little short of
 * `northM`: 1400 m stays inside 1500 m, 1600 m stays outside.
 */
const cfg = getConfig().images;
const LON = 19.37;
const LAT = 36.61;

async function insertSettlement(tx: Db, northM: number, place: string): Promise<string> {
  return insertTestGeoObject(tx, {
    type: "settlement",
    tags: { place },
    geom: geomFromGeoJson({ type: "Point", coordinates: [LON, LAT + northM / 111_000] }),
  });
}

describe("loadPlaceImageInput", () => {
  it("reads centre, subdivision, opening and rays", async () => {
    await withRollback(async (tx) => {
      const sd = await insertTestSubdivision(tx, "test-ionian", [19.3, 36.5, 19.5, 36.7]);
      const { objectId, placeId } = await insertPlace(tx, { lon: LON, lat: LAT });
      await tx
        .update(places)
        .set({ publicId: "sp_test_input", anchorPosition: geomFromGeoJson({ type: "Point", coordinates: [LON + 0.001, LAT] }) })
        .where(eq(places.id, placeId));
      await tx.update(geoObjects).set({ subdivisionId: sd.id }).where(eq(geoObjects.id, objectId));
      await insertComputation(tx, objectId, "shelter", { opening_bearing: { bearingDeg: 120, widthDeg: 40 } });
      const rays = Array.from({ length: 72 }, (_, i) => (i === 10 ? 5000 : 100));
      await insertComputation(tx, objectId, "fetch", { "fetch.n": 5000 }, { outputs: { rays } });

      const input = await loadPlaceImageInput(tx, objectId, cfg);
      expect(input).toMatchObject({
        geoObjectId: objectId,
        publicId: "sp_test_input",
        kind: "anchorage",
        country: "GR",
        subdivisionKey: "test-ionian",
        openingBearing: 120,
        rays,
        town: null,
      });
      expect(input!.lon).toBeCloseTo(LON + 0.001, 9);
      expect(input!.lat).toBeCloseTo(LAT, 9);
      // the named cove: the place's position, 89 m from the anchor point
      expect(input!.cove![0]).toBeCloseTo(LON, 9);
      expect(input!.cove![1]).toBeCloseTo(LAT, 9);
    });
  });

  it("cove point only with an anchor point at least coveMinDistanceM away", async () => {
    await withRollback(async (tx) => {
      const { objectId, placeId } = await insertPlace(tx, { lon: LON, lat: LAT });
      // no anchor point: the position is the centre, there is no separate cove
      expect((await loadPlaceImageInput(tx, objectId, cfg))!.cove).toBeNull();
      // 30 m east: too close to count as a cove of its own
      await tx.update(places).set({ anchorPosition: geomFromGeoJson({ type: "Point", coordinates: [LON + 30 / 89_390, LAT] }) }).where(eq(places.id, placeId));
      expect((await loadPlaceImageInput(tx, objectId, cfg))!.cove).toBeNull();
      // 60 m east: the position is the cove, the anchor point the centre
      await tx.update(places).set({ anchorPosition: geomFromGeoJson({ type: "Point", coordinates: [LON + 60 / 89_390, LAT] }) }).where(eq(places.id, placeId));
      const input = (await loadPlaceImageInput(tx, objectId, cfg))!;
      expect(input.cove).toEqual([LON, LAT]);
      expect(input.lon).toBeCloseTo(LON + 60 / 89_390, 9);
    });
  });

  it("unknown geo object → null", async () => {
    await withRollback(async (tx) => {
      expect(await loadPlaceImageInput(tx, "00000000-0000-7000-8000-00000000dead", cfg)).toBeNull();
    });
  });

  it("town at 1400 m counts, at 1600 m it does not", async () => {
    await withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { lon: LON, lat: LAT });
      await insertSettlement(tx, 1600, "town");
      expect((await loadPlaceImageInput(tx, objectId, cfg))!.town).toBeNull();
      const near = await insertSettlement(tx, 1400, "village");
      const input = (await loadPlaceImageInput(tx, objectId, cfg))!;
      expect(input.town?.geoObjectId).toBe(near);
      expect(input.town!.lat).toBeCloseTo(LAT + 1400 / 111_000, 9);
      expect(lightFor(input, cfg)).toBe("midday");
      expect(compositionFor(input)).toBe("near_town");
    });
  });

  it("the nearest town wins", async () => {
    await withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { lon: LON, lat: LAT });
      await insertSettlement(tx, 1200, "town");
      const nearer = await insertSettlement(tx, -800, "town");
      expect((await loadPlaceImageInput(tx, objectId, cfg))!.town?.geoObjectId).toBe(nearer);
    });
  });

  it("hamlet does not count", async () => {
    await withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { lon: LON, lat: LAT });
      await insertSettlement(tx, 600, "hamlet");
      const input = (await loadPlaceImageInput(tx, objectId, cfg))!;
      expect(input.town).toBeNull();
      expect(lightFor(input, cfg)).toBe("midday");
      expect(compositionFor(input)).toBe("open_water");
    });
  });

  it("marina near a town stays evening, open_water", async () => {
    await withRollback(async (tx) => {
      const { objectId, placeId } = await insertPlace(tx, { lon: LON, lat: LAT });
      await tx.update(places).set({ kind: "marina" }).where(eq(places.id, placeId));
      await insertSettlement(tx, 600, "town");
      const input = (await loadPlaceImageInput(tx, objectId, cfg))!;
      expect(input.town).toBeNull();
      expect(lightFor(input, cfg)).toBe("evening");
      expect(compositionFor(input)).toBe("open_water");
    });
  });
});
