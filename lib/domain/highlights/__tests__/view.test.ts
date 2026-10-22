import { describe, expect, it } from "vitest";
import { insertPlace, insertProfile, provenanceEntry } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertNamedObject } from "@/test/text";
import { placeHighlightsView } from "../view";

/* The highlights panel of the place page (spec 16), synthetic data at 21.5° E / 35.7° N (outside the pilot box). */

const LON = 21.5;
const LAT = 35.7;

const cand = (geoObjectId: string, importance: number, distanceKm: number) => ({ geoObjectId, importance, score: importance * 10, distanceKm });

describe("placeHighlightsView", () => {
  it("lists the categories in label order with highlights by rank, the level label and the other candidates", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { lon: LON, lat: LAT });
      const taverna = await insertNamedObject(tx, { type: "poi", category: "food", names: [{ name: "Taverna Eins" }], lon: LON, lat: LAT });
      const beachA = await insertNamedObject(tx, { type: "poi", category: "beach", names: [{ name: "Strand A" }], lon: LON, lat: LAT });
      const beachB = await insertNamedObject(tx, { type: "poi", category: "beach", names: [{ name: "Strand B" }], lon: LON, lat: LAT });
      const beachC = await insertNamedObject(tx, { type: "poi", category: "beach", names: [{ name: "Strand C" }], lon: LON, lat: LAT });
      await insertProfile(
        tx,
        objectId,
        { "derived.highlights": { food: { ids: [taverna], level: "none" }, beach: { ids: [beachB, beachA], level: "many" } } },
        {
          "derived.highlights": provenanceEntry("derived", {
            derivedFrom: {
              food: { ids: [taverna], level: "none", candidates: [cand(taverna, 3, 0.4)], textNames: [] },
              beach: {
                ids: [beachB, beachA],
                level: "many",
                candidates: [cand(beachA, 2, 1.2), cand(beachB, 4, 2.5), cand(beachC, 1, 3)],
                textNames: [],
              },
            },
          }),
        },
      );

      const view = await placeHighlightsView(tx, objectId);
      expect(view.map((v) => v.category)).toEqual(["food", "beach"]);
      expect(view[0]).toEqual({
        category: "food",
        label: "Essen",
        level: "none",
        levelLabel: "nur das",
        highlights: [{ geoObjectId: taverna, name: "Taverna Eins", importance: 3, distanceKm: 0.4 }],
        others: 0,
      });
      expect(view[1]!.levelLabel).toBe("sehr viel mehr");
      expect(view[1]!.highlights.map((h) => h.name)).toEqual(["Strand B", "Strand A"]);
      expect(view[1]!.others).toBe(1);
    }));

  it("a category with only text names has no highlights; no profile or no attribute gives an empty list", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { lon: LON, lat: LAT });
      expect(await placeHighlightsView(tx, objectId)).toEqual([]);
      await insertProfile(tx, objectId, {}, {});
      expect(await placeHighlightsView(tx, objectId)).toEqual([]);
      await insertProfile(
        tx,
        objectId,
        { "derived.highlights": { culture: { ids: [], level: "some" } } },
        { "derived.highlights": provenanceEntry("derived", { derivedFrom: { culture: { ids: [], level: "some", candidates: [], textNames: ["Kloster"] } } }) },
        { version: 2 },
      );
      const view = await placeHighlightsView(tx, objectId);
      expect(view).toEqual([{ category: "culture", label: "Kultur", level: "some", levelLabel: "einiges mehr", highlights: [], others: 0 }]);
    }));
});
