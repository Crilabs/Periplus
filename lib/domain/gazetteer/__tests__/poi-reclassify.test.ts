import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places } from "@/lib/db/schema";
import { reclassifyPois } from "@/lib/domain/gazetteer/poi-reclassify";
import { upsertGeoObject, type GeoObjectDraft } from "@/lib/domain/gazetteer/store";
import { withRollback } from "@/test/db";

const { categories } = loadConfig();

// Outside the pilot box, so committed rows of other tests never matter; rolled back anyway.
const LON = 27.05;
const LAT = 35.35;
const osmId = () => `node/${Date.now()}${Math.floor(Math.random() * 1e9)}`;

async function poi(db: Db, draft: Partial<GeoObjectDraft> & { lon?: number }) {
  const r = await upsertGeoObject(db, {
    type: "poi",
    origin: "osm",
    osmId: osmId(),
    geometry: { type: "Point", coordinates: [draft.lon ?? LON, LAT] },
    names: [],
    ...draft,
  });
  if ("skipped" in r) throw new Error(r.skipped);
  return r.id;
}

async function categoryOf(db: Db, id: string) {
  return (await db.select({ c: geoObjects.category }).from(geoObjects).where(eq(geoObjects.id, id)))[0]!.c;
}

describe("reclassifyPois", () => {
  it("clears fuel and pharmacy, keeps supermarkets, prefers a supply tag, leaves tagless POIs alone, is idempotent", () =>
    withRollback(async (db) => {
      const fuel = await poi(db, { category: "supply", tags: { amenity: "fuel" } });
      const pharmacy = await poi(db, { category: "supply", tags: { amenity: "pharmacy" } });
      const market = await poi(db, { category: "supply", tags: { shop: "supermarket" } });
      const both = await poi(db, { category: "supply", tags: { amenity: "fuel", shop: "convenience" } });
      const wikidata = await poi(db, { origin: "wikidata", osmId: undefined, wikidataId: `Q${Date.now()}`, category: "culture", tags: {} });

      const [bay] = await db.insert(geoObjects).values({ type: "bay", origin: "osm", geom: geomFromGeoJson({ type: "Point", coordinates: [LON, LAT + 0.005] }) }).returning({ id: geoObjects.id });
      await db.insert(places).values({ geoObjectId: bay!.id, kind: "anchorage", status: "candidate", position: geomFromGeoJson({ type: "Point", coordinates: [LON, LAT + 0.005] }) });
      const [far] = await db.insert(geoObjects).values({ type: "bay", origin: "osm", geom: geomFromGeoJson({ type: "Point", coordinates: [LON + 1, LAT] }) }).returning({ id: geoObjects.id });
      await db.insert(places).values({ geoObjectId: far!.id, kind: "anchorage", status: "candidate", position: geomFromGeoJson({ type: "Point", coordinates: [LON + 1, LAT] }) });

      const dry = await reclassifyPois(db, categories, { dryRun: true });
      expect(dry.cleared).toBeGreaterThanOrEqual(2);
      expect(await categoryOf(db, fuel)).toBe("supply");

      const first = await reclassifyPois(db, categories);
      expect(first.cleared).toBeGreaterThanOrEqual(2);
      expect(first.geoObjectIds).toContain(bay!.id);
      expect(first.geoObjectIds).not.toContain(far!.id);
      expect(await categoryOf(db, fuel)).toBeNull();
      expect(await categoryOf(db, pharmacy)).toBeNull();
      expect(await categoryOf(db, market)).toBe("supply");
      expect(await categoryOf(db, both)).toBe("supply");
      expect(await categoryOf(db, wikidata)).toBe("culture");

      const second = await reclassifyPois(db, categories);
      expect(second).toEqual({ cleared: 0, changed: 0, geoObjectIds: [] });
    }));

  it("changed counts a category change that is not a clearing", () =>
    withRollback(async (db) => {
      const id = await poi(db, { category: "supply", tags: { shop: "scuba_diving", tourism: "viewpoint" } });
      const r = await reclassifyPois(db, categories);
      expect(r.changed).toBeGreaterThanOrEqual(1);
      expect(await categoryOf(db, id)).toBe("active");
    }));
});
