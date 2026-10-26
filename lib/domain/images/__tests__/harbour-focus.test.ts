import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, harbourStructures, places } from "@/lib/db/schema";
import { insertComputation, insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertLandBox, metresFrom, SEA } from "@/test/fixtures/land-box";
import { harbourFocus, planHarbour } from "../harbour-focus";
import { loadPlaceImageInput } from "../place-input";
import { projectGround } from "../projection";

const cfg = getConfig().images;

/** A ring of the rectangle `west…east`, `south…north` metres from SEA. */
const rect = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n], [w, s]].map(([x, y]) => metresFrom(SEA, x!, y!));

async function marina(tx: Db, o: { polygon?: boolean; water?: ReturnType<typeof rect> | null } = {}): Promise<string> {
  const { objectId, placeId } = await insertPlace(tx, { lon: SEA[0], lat: SEA[1], type: "harbour" });
  await tx.update(places).set({ kind: "marina" }).where(eq(places.id, placeId));
  if (o.polygon) await tx.update(geoObjects).set({ geom: geomFromGeoJson({ type: "Polygon", coordinates: [rect(-150, -100, 150, 100)] }) }).where(eq(geoObjects.id, objectId));
  const water = o.water === undefined ? rect(-140, -90, 140, 90) : o.water;
  await insertComputation(tx, objectId, "anchor_area", { anchor_area: { areaM2: 1 } }, { outputs: { water: water ? { type: "Polygon", coordinates: [water] } : null, area: null, gaps: [] } });
  return objectId;
}

async function structure(tx: Db, osmId: string, line: Array<[number, number]>): Promise<void> {
  await tx.insert(harbourStructures).values({
    osmId,
    manMade: "pier",
    geom: sql`${geomFromGeoJson({ type: "LineString", coordinates: line.map(([e, n]) => metresFrom(SEA, e, n)) })}`,
    datasetVersion: "test",
  });
}

describe("harbourFocus", () => {
  it("a polygon marina uses its water area", () =>
    withRollback(async (tx) => {
      const id = await marina(tx, { polygon: true });
      const focus = await harbourFocus(tx, (await loadPlaceImageInput(tx, id, cfg))!, cfg);
      expect(focus!.source).toBe("basin");
      expect(focus!.rings[0]).toHaveLength(5);
    }));

  it("a point marina uses the hull of structures within 300 m, a structure 400 m away is ignored", () =>
    withRollback(async (tx) => {
      const id = await marina(tx);
      await structure(tx, "way/1", [[-100, 0], [-100, 120]]);
      await structure(tx, "way/2", [[100, 0], [100, 120]]);
      await structure(tx, "way/3", [[400, 0], [450, 0]]);
      const focus = (await harbourFocus(tx, (await loadPlaceImageInput(tx, id, cfg))!, cfg))!;
      expect(focus.source).toBe("structures");
      const easts = focus.rings[0]!.map(([lon]) => (lon - SEA[0]) * 111_320 * Math.cos((SEA[1] * Math.PI) / 180));
      // the hull spans both piers widened by 25 m, and stops well short of the far structure
      expect(Math.min(...easts)).toBeCloseTo(-125, -1);
      expect(Math.max(...easts)).toBeCloseTo(125, -1);
    }));

  it("a polygon marina whose water is empty falls back to structures", () =>
    withRollback(async (tx) => {
      const id = await marina(tx, { polygon: true, water: null });
      await structure(tx, "way/1", [[-50, 0], [50, 0]]);
      expect((await harbourFocus(tx, (await loadPlaceImageInput(tx, id, cfg))!, cfg))!.source).toBe("structures");
    }));

  it("no focus gives null", () =>
    withRollback(async (tx) => {
      const id = await marina(tx);
      expect(await harbourFocus(tx, (await loadPlaceImageInput(tx, id, cfg))!, cfg)).toBeNull();
    }));
});

describe("planHarbour", () => {
  it("keeps every focus corner inside the safe area, with the camera over water", () =>
    withRollback(async (tx) => {
      const id = await marina(tx, { polygon: true });
      await insertLandBox(tx, SEA, -2_000, 100, 2_000, 2_000);
      const input = (await loadPlaceImageInput(tx, id, cfg))!;
      const camera = (await planHarbour(tx, input, "z3", cfg))!;
      expect(camera.tiltDeg).toBe(40);
      expect(camera.zoom).toBe("z3");
      for (const p of projectGround(camera, rect(-140, -90, 140, 90))) {
        expect(Math.abs(p![0])).toBeLessThanOrEqual(0.8);
        expect(Math.abs(p![1])).toBeLessThanOrEqual(0.8);
      }
    }));
});
