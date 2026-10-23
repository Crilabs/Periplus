import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { landPolygons, landingHints, places } from "@/lib/db/schema";
import { landingPoints } from "@/lib/domain/research/landing";
import { insertPlace } from "@/test/consolidation";
import { seedPage, seedVersion } from "@/test/research-state";
import { withRollback } from "@/test/db";
import { insertTestGeoObject } from "@/test/text";

/*
 * Landing points of a berth (plan N4a task 4): the harbour itself for a port or marina, else landing objects and
 * beaches near the anchor area, else the nearest shore point; hints of the texts come on top without a position.
 */

const config = getConfig();
const LON = 21.0;
const LAT = 35.2;
/** Metres of latitude per degree (good enough for synthetic offsets). */
const M_PER_DEG = 111_195;
const north = (m: number) => LAT + m / M_PER_DEG;

const poi = (tx: Parameters<typeof insertTestGeoObject>[0], o: { lat: number; category: "landing" | "beach" | "food"; tags?: Record<string, string> }) =>
  insertTestGeoObject(tx, { type: "poi", category: o.category, tags: o.tags ?? {}, geom: geomFromGeoJson({ type: "Point", coordinates: [LON, o.lat] }) });

/** The text points only: the shared test database may hold land polygons that make a shore point of any berth. */
const texts = async (tx: Parameters<typeof landingPoints>[0], placeId: string) => (await landingPoints(tx, placeId, config)).filter((l) => l.kind === "text");

describe("landingPoints", () => {
  it("a marina or port: the harbour itself, no search for beaches", async () => {
    await withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx, { type: "harbour" });
      await tx.update(places).set({ kind: "marina" }).where(eq(places.id, placeId));
      await poi(tx, { lat: north(100), category: "beach" });
      const out = await landingPoints(tx, placeId, config);
      expect(out).toEqual([{ kind: "harbour", lon: LON, lat: LAT, geoObjectId: objectId, description: null }]);
    });
  });

  it("a bay with a pier 300 m away: the pier; one beyond the radius is left out", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const pier = await poi(tx, { lat: north(300), category: "landing", tags: { man_made: "pier" } });
      await poi(tx, { lat: north(900), category: "landing", tags: { man_made: "pier" } });
      await poi(tx, { lat: north(200), category: "food" });
      const out = await landingPoints(tx, placeId, config);
      expect(out).toEqual([{ kind: "pier", lon: LON, lat: expect.closeTo(north(300), 6), geoObjectId: pier, description: null }]);
    });
  });

  it("a slipway and a beach get their kinds, nearest first", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      await poi(tx, { lat: north(500), category: "beach" });
      await poi(tx, { lat: north(100), category: "landing", tags: { leisure: "slipway" } });
      const out = await landingPoints(tx, placeId, config);
      expect(out.map((l) => l.kind)).toEqual(["slipway", "beach"]);
    });
  });

  it("measures from the anchor position when the place has one", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      await tx.update(places).set({ anchorPosition: geomFromGeoJson({ type: "Point", coordinates: [LON, north(2000)] }) }).where(eq(places.id, placeId));
      await poi(tx, { lat: north(300), category: "landing" });
      const near = await poi(tx, { lat: north(2100), category: "landing" });
      const out = await landingPoints(tx, placeId, config);
      expect(out.map((l) => l.geoObjectId)).toEqual([near]);
    });
  });

  it("nothing near: the nearest shore point of the land polygon", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      // land starting about 700 m east of the berth
      const lonE = LON + 700 / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180));
      await tx.insert(landPolygons).values({
        geom: geomFromGeoJson({ type: "Polygon", coordinates: [[[lonE, LAT - 0.01], [lonE + 0.02, LAT - 0.01], [lonE + 0.02, LAT + 0.01], [lonE, LAT + 0.01], [lonE, LAT - 0.01]]] }),
        datasetVersion: "test",
      });
      const out = await landingPoints(tx, placeId, config);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: "shore", geoObjectId: null, description: null });
      expect(out[0]!.lon).toBeCloseTo(lonE, 5);
      expect(out[0]!.lat).toBeCloseTo(LAT, 5);
    });
  });

  it("a shore beyond shoreMaxM is no landing point", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const lonE = LON + 5000 / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180));
      await tx.insert(landPolygons).values({
        geom: geomFromGeoJson({ type: "Polygon", coordinates: [[[lonE, LAT - 0.01], [lonE + 0.02, LAT - 0.01], [lonE + 0.02, LAT + 0.01], [lonE, LAT + 0.01], [lonE, LAT - 0.01]]] }),
        datasetVersion: "test",
      });
      expect(await landingPoints(tx, placeId, config)).toEqual([]);
    });
  });

  it("the same hint of two pages counts once", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const a = await seedPage(tx, config, placeId);
      const b = await seedPage(tx, config, placeId);
      const row = (p: { unitId: string; versionId: string }, description: string) => ({
        unitId: p.unitId, placeId, documentVersionId: p.versionId, description, quote: "q", quoteStart: 0, quoteEnd: 1, observedAt: "2025-06-15",
      });
      await tx.insert(landingHints).values([row(a, "Small quay on the left"), row(b, "small quay on the left ")]);
      expect(await texts(tx, placeId)).toHaveLength(1);
    });
  });

  it("a hint of a done unit comes as a text without position; a failed unit's hint does not", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const good = await seedPage(tx, config, placeId);
      const failed = await seedPage(tx, config, placeId, { status: "failed" });
      const wrongModel = await seedPage(tx, config, placeId, { model: "other-model" });
      const row = (p: { unitId: string; versionId: string }, description: string) => ({
        unitId: p.unitId, placeId, documentVersionId: p.versionId, description, quote: "synthetic quote", quoteStart: 0, quoteEnd: 15, observedAt: "2025-06-15",
      });
      await tx.insert(landingHints).values([row(good, "dinghy to the small quay on the left"), row(failed, "hint of a failed unit"), row(wrongModel, "hint of another model")]);
      const out = await texts(tx, placeId);
      expect(out).toEqual([{ kind: "text", lon: null, lat: null, geoObjectId: null, description: "dinghy to the small quay on the left" }]);
    });
  });

  it("a hint of a superseded version does not count", async () => {
    await withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const first = await seedPage(tx, config, placeId);
      await seedVersion(tx, config, placeId, first.documentId);
      await tx.insert(landingHints).values({ unitId: first.unitId, placeId, documentVersionId: first.versionId, description: "old hint", quote: "q", quoteStart: 0, quoteEnd: 1, observedAt: "2025-06-15" });
      expect(await texts(tx, placeId)).toEqual([]);
    });
  });
});
