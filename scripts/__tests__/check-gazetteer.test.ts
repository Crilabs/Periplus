import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, tiles, type GeoObjectType } from "@/lib/db/schema";
import { addNames } from "@/lib/domain/gazetteer/names";
import { createReviewTask } from "@/lib/domain/review";
import { tileBbox, tileIdFor, type Bbox } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";
import { checkGazetteer, parseArgs } from "../check-gazetteer";

// One tile outside the pilot box 23.0-23.75 E x 37.0-38.0 N.
const BOX: Bbox = [27.0, 35.0, 27.25, 35.25];
const FULL = { de: "Vollinsel", en: "Fullisland", el: "Πλήρης" };

async function addObject(tx: Db, type: GeoObjectType, lon: number, lat: number, names: Record<string, string>) {
  const [row] = await tx
    .insert(geoObjects)
    .values({ type, origin: "osm", geom: sql`${geomFromGeoJson({ type: "Point", coordinates: [lon, lat] })}` })
    .returning({ id: geoObjects.id });
  await addNames(tx, row!.id, Object.entries(names).map(([language, name]) => ({ name, language, origin: "manual" as const })));
  return row!.id;
}

describe("checkGazetteer", () => {
  // Repeatable read: the open-task count is database-wide, and other test files commit and decide place_candidate
  // tasks meanwhile (review decisions, the geometry lock-order test).
  it("reports an island without an el name and counts coast tiles", () =>
    withRollback(async (tx) => {
      const before = await checkGazetteer(tx, BOX);
      expect(before.missing).toEqual([]);

      await addObject(tx, "island", 27.1, 35.1, FULL);
      const incomplete = await addObject(tx, "island", 27.12, 35.12, { de: "Teilinsel", en: "Partisland" });
      await addObject(tx, "bay", 27.14, 35.14, {}); // unnamed bay is not checked
      await addObject(tx, "bay", 27.16, 35.16, { de: "Bucht", en: "Bay", el: "Κόλπος" });
      await addObject(tx, "settlement", 28.5, 35.1, { de: "Draußen" }); // centroid outside the box

      await tx.insert(tiles).values({
        id: tileIdFor(27.1, 35.1),
        bbox: sql`${geomFromGeoJson({
          type: "Polygon",
          coordinates: [(() => {
            const [w, s, e, n] = tileBbox(tileIdFor(27.1, 35.1));
            return [[w, s], [e, s], [e, n], [w, n], [w, s]];
          })()],
        })}`,
        hasCoast: true,
      }).onConflictDoUpdate({ target: tiles.id, set: { hasCoast: true } });
      await createReviewTask(tx, { kind: "place_candidate", subjectType: "place", subjectId: "check-gazetteer-test", context: {} });

      const r = await checkGazetteer(tx, BOX);
      expect(r.missing).toHaveLength(1);
      expect(r.missing[0]).toEqual({ id: incomplete, type: "island", name: expect.any(String), languages: ["de", "en"] });
      expect(r.tilesWithCoast).toBeGreaterThanOrEqual(1);
      expect(r.openCandidateTasks).toBe(before.openCandidateTasks + 1);
    }, { isolationLevel: "repeatable read" }));

  it("treats a fallback de name as valid", () =>
    withRollback(async (tx) => {
      const id = await addObject(tx, "island", 27.2, 35.2, { en: "Onlyen", el: "Μόνο" });
      await tx.insert(geoNames).values({
        geoObjectId: id, name: "Onlyen", nameNormalized: "onlyen", language: "de", script: "latin", origin: "fallback",
      });
      expect((await checkGazetteer(tx, BOX)).missing).toEqual([]);
    }));
});

describe("check-gazetteer CLI", () => {
  it("parses --area and rejects anything else", () => {
    expect(parseArgs(["--area", "saronic"])).toEqual({ area: "saronic" });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["--area"])).toThrow(/usage/);
  });
});
