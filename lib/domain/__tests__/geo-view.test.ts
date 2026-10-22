import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  externalCalls,
  geoNames,
  geoObjects,
  places,
  runs,
  tileGeoObjects,
  tiles,
  type GeoObjectType,
} from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { geoObjectDetail, placeDetail, tileDetail, tileExists } from "@/lib/domain/geo-view";
import { createReviewTask } from "@/lib/domain/review";
import { tileIdFor } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";
import { insertTestSubdivision } from "@/test/text";

// Synthetic data in open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N, at a spot no other test uses.
const LON = 25.47;
const LAT = 35.93;
const TILE = tileIdFor(LON, LAT);
const point = (lon: number, lat: number): GeoJSON.Point => ({ type: "Point", coordinates: [lon, lat] });
const square = (d: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[[LON - d, LAT - d], [LON + d, LAT - d], [LON + d, LAT + d], [LON - d, LAT + d], [LON - d, LAT - d]]],
});

async function insertObject(
  tx: Db,
  type: GeoObjectType,
  name: string,
  parentId: string | null,
  extra: Partial<typeof geoObjects.$inferInsert> = {},
): Promise<string> {
  const [o] = await tx
    .insert(geoObjects)
    .values({ type, origin: "osm", parentId, geom: geomFromGeoJson(square(0.01)), ...extra })
    .returning({ id: geoObjects.id });
  await tx.insert(geoNames).values({
    geoObjectId: o!.id,
    name,
    nameNormalized: name.toLowerCase(),
    language: "en",
    script: "latin",
    origin: "osm",
    isPreferred: true,
  });
  return o!.id;
}

/** Sea → area → island → bay, with a place on the bay. */
async function insertChain(tx: Db) {
  const sea = await insertObject(tx, "sea", "Test Sea", null);
  const area = await insertObject(tx, "area", "Test Area", sea, { configKey: `test-${newId()}` });
  const island = await insertObject(tx, "island", "Test Island", area, {
    osmId: `relation/${Date.now()}`,
    wikidataId: "Q999999991",
  });
  const bay = await insertObject(tx, "bay", "Test Bay", island);
  const cape = await insertObject(tx, "cape", "Test Cape", island);
  return { sea, area, island, bay, cape };
}

async function insertTile(tx: Db, subdivisionId: string | null) {
  await tx.insert(tiles).values({
    id: TILE,
    bbox: sql`ST_MakeEnvelope(25.25, 35.75, 25.5, 36.0, 4326)`,
    subdivisionId,
    hasCoast: true,
  });
}

describe("geo view", () => {
  it("geoObjectDetail returns names, the parent chain up to the root, children, external ids, place and tiles", () =>
    withRollback(async (tx) => {
      const c = await insertChain(tx);
      await tx.insert(geoNames).values([
        { geoObjectId: c.island, name: "Testinsel", nameNormalized: "testinsel", language: "de", script: "latin", origin: "manual", isPreferred: true },
        { geoObjectId: c.island, name: "Old Name", nameNormalized: "old name", language: "en", script: "latin", origin: "geonames", validTo: sql`current_date` },
      ]);
      await insertTile(tx, null);
      await tx.insert(tileGeoObjects).values({ tileId: TILE, geoObjectId: c.island });

      const detail = await geoObjectDetail(tx, c.island);
      expect(detail?.object).toMatchObject({
        id: c.island,
        type: "island",
        name: "Testinsel",
        origin: "osm",
        wikidataId: "Q999999991",
      });
      expect(detail?.object.osmId).toMatch(/^relation\//);
      // The geometry for the page's map, as GeoJSON.
      expect(detail?.object.geometry.type).toMatch(/Polygon|Point/);
      expect(detail?.names).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Testinsel", language: "de", script: "latin", origin: "manual", isPreferred: true, valid: true }),
          expect.objectContaining({ name: "Test Island", language: "en", origin: "osm", valid: true }),
          expect.objectContaining({ name: "Old Name", language: "en", origin: "geonames", isPreferred: false, valid: false }),
        ]),
      );
      expect(detail?.names).toHaveLength(3);
      expect(detail?.ancestors).toEqual([
        { id: c.area, type: "area", name: "Test Area" },
        { id: c.sea, type: "sea", name: "Test Sea" },
      ]);
      expect(detail?.children).toEqual([
        { id: c.bay, type: "bay", name: "Test Bay" },
        { id: c.cape, type: "cape", name: "Test Cape" },
      ]);
      expect(detail?.place).toBeNull();
      expect(detail?.tileIds).toEqual([TILE]);

      const bay = await geoObjectDetail(tx, c.bay);
      expect(bay?.ancestors.map((a) => a.name)).toEqual(["Testinsel", "Test Area", "Test Sea"]);
      expect(bay?.children).toEqual([]);

      const [place] = await tx
        .insert(places)
        .values({ geoObjectId: c.bay, kind: "anchorage", position: geomFromGeoJson(point(LON, LAT)) })
        .returning({ id: places.id });
      expect((await geoObjectDetail(tx, c.bay))?.place).toEqual({ id: place!.id, kind: "anchorage", status: "candidate" });

      expect(await geoObjectDetail(tx, newId())).toBeNull();
    }));

  it("tileDetail returns the tile, area, geo objects, places, related runs and costs", () =>
    withRollback(async (tx) => {
      const c = await insertChain(tx);
      const sub = await insertTestSubdivision(tx, "XT-GEO", [25.0, 35.5, 25.75, 36.25], { country: "XT" });
      await insertTile(tx, sub.id);
      await tx.insert(tileGeoObjects).values([
        { tileId: TILE, geoObjectId: c.island },
        { tileId: TILE, geoObjectId: c.bay },
      ]);
      const [place] = await tx
        .insert(places)
        .values({ geoObjectId: c.bay, kind: "anchorage", position: geomFromGeoJson(point(LON, LAT)) })
        .returning({ id: places.id });
      const [tileRun] = await tx
        .insert(runs)
        .values({ kind: "stage", scopeType: "tile", scopeId: TILE, stages: ["seed.tile"], params: { tileIds: [TILE] }, triggeredBy: "test" })
        .returning({ id: runs.id });
      const [paramRun] = await tx
        .insert(runs)
        .values({ kind: "stage", scopeType: "area", scopeId: "test", stages: ["seed.tile"], params: { tileIds: ["q025:1:1", TILE] }, triggeredBy: "test" })
        .returning({ id: runs.id });
      await tx
        .insert(runs)
        .values({ kind: "stage", scopeType: "tile", scopeId: "q025:1:1", stages: ["seed.tile"], params: { tileIds: ["q025:1:1"] }, triggeredBy: "test" });
      await tx.insert(externalCalls).values([
        { service: "overpass", operation: "query", units: "1", unit: "request", costEur: "0", tileId: TILE },
        { service: "llm", operation: "extract", units: "100", unit: "token", costEur: "0.25", tileId: TILE },
        { service: "llm", operation: "extract", units: "100", unit: "token", costEur: "0.5", tileId: TILE },
        { service: "llm", operation: "extract", units: "100", unit: "token", costEur: "9", tileId: "q025:1:1" },
      ]);

      const detail = await tileDetail(tx, TILE);
      expect(detail?.tile).toMatchObject({ id: TILE, hasCoast: true });
      expect(detail?.subdivision).toEqual({ key: "XT-GEO", name: null });
      expect(detail?.geoObjects).toEqual([
        { id: c.bay, type: "bay", name: "Test Bay" },
        { id: c.island, type: "island", name: "Test Island" },
      ]);
      expect(detail?.places).toEqual([{ id: place!.id, name: "Test Bay", kind: "anchorage", status: "candidate" }]);
      expect(detail?.runs.map((r) => r.id)).toEqual([paramRun!.id, tileRun!.id]);
      expect(detail?.costs).toEqual([
        { service: "llm", calls: 2, costEur: 0.75 },
        { service: "overpass", calls: 1, costEur: 0 },
      ]);
      expect(detail?.costEur).toBeCloseTo(0.75, 6);

      expect(await tileExists(tx, TILE)).toBe(true);
      expect(await tileExists(tx, "q025:1:1")).toBe(false);
      expect(await tileDetail(tx, "q025:1:1")).toBeNull();
    }));

  it("placeDetail returns the header, the open review task and the status history newest first", () =>
    withRollback(async (tx) => {
      const c = await insertChain(tx);
      const [place] = await tx
        .insert(places)
        .values({ geoObjectId: c.bay, kind: "anchorage", position: geomFromGeoJson(point(LON, LAT)) })
        .returning({ id: places.id });
      const id = place!.id;
      const { id: taskId } = await createReviewTask(tx, {
        kind: "place_candidate",
        subjectType: "place",
        subjectId: id,
        context: { name: "Test Bay" },
      });

      let detail = await placeDetail(tx, id);
      expect(detail?.place).toMatchObject({
        id,
        name: "Test Bay",
        geoObjectId: c.bay,
        kind: "anchorage",
        status: "candidate",
        statusReason: null,
        publicId: null,
        tileId: TILE,
      });
      expect(detail?.place.position.lon).toBeCloseTo(LON, 6);
      expect(detail?.place.position.lat).toBeCloseTo(LAT, 6);
      expect(detail?.openReviewTask).toEqual({ id: taskId, kind: "place_candidate" });
      expect(detail?.statusHistory).toEqual([]);

      // candidate → (position change, same status) → confirmed → abandoned
      await tx.update(places).set({ position: geomFromGeoJson(point(LON + 0.001, LAT)) }).where(eq(places.id, id));
      await tx.update(places).set({ status: "confirmed" }).where(eq(places.id, id));
      await tx.update(places).set({ status: "abandoned", statusReason: "gone" }).where(eq(places.id, id));

      detail = await placeDetail(tx, id);
      expect(detail?.place).toMatchObject({ status: "abandoned", statusReason: "gone" });
      expect(detail?.statusHistory.map((h) => h.status)).toEqual(["confirmed", "candidate"]);
      expect(detail?.statusHistory[0]!.changedAt).toBeInstanceOf(Date);

      expect(await placeDetail(tx, newId())).toBeNull();
    }));
});
