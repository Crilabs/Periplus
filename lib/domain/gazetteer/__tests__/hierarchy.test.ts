import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, tileGeoObjects, type GeoObjectType } from "@/lib/db/schema";
import { syncAreas } from "@/lib/domain/gazetteer/areas";
import { assignParents, assignTiles } from "@/lib/domain/gazetteer/hierarchy";
import { ensureTiles } from "@/lib/domain/gazetteer/tiles-ensure";
import { tileIdFor } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";

// Synthetic areas outside the pilot box 23.0-23.75 E x 37.0-38.0 N: "hier-test" (25.0-25.5 E x 35.0-35.5 N,
// four tiles) with a coast section in its south-east corner, inside the larger "hier-outer".
type Polygon = { type: "Polygon"; coordinates: [number, number][][] };
const box = (w: number, s: number, e: number, n: number): Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

const area = (key: string, polygon: Polygon, coastSections: AreaConfig["coastSections"] = []): AreaConfig => ({
  key,
  names: { de: key, en: key },
  polygon,
  tileBbox: null,
  sourceLanguages: ["de", "en", "el"],
  season: { fromMonth: 4, toMonth: 10 },
  cycleDays: 30,
  coastSections,
});

const AREAS = vi.hoisted(() => ({ list: [] as AreaConfig[] }));
AREAS.list = [
  area("hier-test", box(25.0, 35.0, 25.5, 35.5), [
    { key: "south-east", names: { en: "South East" }, polygon: box(25.35, 35.0, 25.5, 35.1) },
  ]),
  area("hier-outer", box(24.5, 34.0, 26.0, 36.0)),
];

vi.mock("@/lib/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/config")>();
  const getConfig = () => ({ ...original.getConfig(), areas: [...original.getConfig().areas, ...AREAS.list] });
  return {
    ...original,
    getConfig,
    areaByKey: (key: string) => {
      const found = getConfig().areas.find((a) => a.key === key);
      if (!found) throw new Error(`Unknown area ${key}`);
      return found;
    },
  };
});

async function insert(db: Db, type: GeoObjectType, geometry: GeoJSON.Geometry): Promise<string> {
  const [row] = await db
    .insert(geoObjects)
    .values({ type, origin: "osm", geom: sql`${geomFromGeoJson(geometry)}` })
    .returning({ id: geoObjects.id });
  return row!.id;
}

const point = (lon: number, lat: number): GeoJSON.Point => ({ type: "Point", coordinates: [lon, lat] });

async function parentOf(db: Db, id: string): Promise<string | null> {
  const [row] = await db.select({ parentId: geoObjects.parentId }).from(geoObjects).where(eq(geoObjects.id, id));
  return row!.parentId;
}

async function setup(db: Db) {
  const ids = await syncAreas(db, AREAS.list);
  return { areaId: ids.get("hier-test")!, outerId: ids.get("hier-outer")!, sectionId: ids.get("hier-test/south-east")! };
}

// Island 25.10-25.20 E x 35.20-35.30 N; 0.001 degree latitude is ~111 m.
const ISLAND = box(25.1, 35.2, 25.2, 35.3);

describe("assignParents", () => {
  it("bay inside an island buffer gets the island", () =>
    withRollback(async (db) => {
      await setup(db);
      const island = await insert(db, "island", ISLAND);
      const bay = await insert(db, "bay", point(25.15, 35.3011)); // ~120 m north of the shore
      const far = await insert(db, "bay", point(25.15, 35.303)); // ~330 m: outside the 200 m buffer
      const r = await assignParents(db, "hier-test");
      expect(r.updated).toBeGreaterThan(0);
      expect(await parentOf(db, bay)).toBe(island);
      expect(await parentOf(db, far)).not.toBe(island);

      // Unchanged rerun writes nothing.
      expect(await assignParents(db, "hier-test")).toEqual({ updated: 0 });
    }));

  it("a point island does not act as parent", () =>
    withRollback(async (db) => {
      const { areaId } = await setup(db);
      await insert(db, "island", point(25.3, 35.3));
      const bay = await insert(db, "bay", point(25.3005, 35.3));
      await assignParents(db, "hier-test");
      expect(await parentOf(db, bay)).toBe(areaId);
    }));

  it("bay on the mainland without coast section gets the area", () =>
    withRollback(async (db) => {
      const { areaId } = await setup(db);
      await insert(db, "island", ISLAND);
      const bay = await insert(db, "bay", point(25.4, 35.4));
      await assignParents(db, "hier-test");
      expect(await parentOf(db, bay)).toBe(areaId);
    }));

  it("bay inside a coast section gets the section", () =>
    withRollback(async (db) => {
      const { areaId, sectionId } = await setup(db);
      const bay = await insert(db, "bay", point(25.4, 35.05));
      const harbour = await insert(db, "harbour", point(25.42, 35.06));
      await assignParents(db, "hier-test");
      expect(await parentOf(db, bay)).toBe(sectionId);
      expect(await parentOf(db, harbour)).toBe(sectionId);
      expect(await parentOf(db, sectionId)).toBe(areaId);
    }));

  it("island gets the smallest containing area, or its archipelago", () =>
    withRollback(async (db) => {
      const { areaId } = await setup(db);
      const island = await insert(db, "island", ISLAND);
      expect((await assignParents(db, "hier-test")).updated).toBeGreaterThan(0);
      expect(await parentOf(db, island)).toBe(areaId);

      const archipelago = await insert(db, "archipelago", box(25.05, 35.15, 25.25, 35.35));
      await assignParents(db, "hier-test");
      expect(await parentOf(db, island)).toBe(archipelago);
      expect(await parentOf(db, archipelago)).toBe(areaId);
    }));

  it("area gets the containing sea, else none", () =>
    withRollback(async (db) => {
      const { areaId, outerId } = await setup(db);
      await assignParents(db, "hier-test");
      expect(await parentOf(db, areaId)).toBeNull();

      const sea = await insert(db, "sea", box(24.0, 34.0, 27.0, 37.0));
      const gulf = await insert(db, "gulf", box(24.9, 35.1, 25.6, 35.6)); // covers hier-test's centroid, not hier-outer's
      await assignParents(db, "hier-test");
      expect(await parentOf(db, areaId)).toBe(gulf);
      expect(await parentOf(db, outerId)).toBe(sea);
      // The gulf belongs to the smallest area containing it, except hier-test whose parent it is (no cycle).
      expect(await parentOf(db, gulf)).toBe(outerId);
    }));

  it("a bay outside every island, section and area gets the sea", () =>
    withRollback(async (db) => {
      await setup(db);
      const sea = await insert(db, "sea", box(24.0, 34.0, 27.0, 37.0));
      // Just east of hier-outer's polygon, within its box plus the 5 km buffer, outside every area.
      const bay = await insert(db, "bay", point(26.02, 35.0));
      await assignParents(db, "hier-outer");
      expect(await parentOf(db, bay)).toBe(sea);
    }));
});

describe("assignTiles", () => {
  it("assignTiles links a polygon to every tile it touches", () =>
    withRollback(async (db) => {
      const ids = await setup(db);
      await ensureTiles(db, AREAS.list[0]!, new Map([["hier-test", ids.areaId]]));
      // Crosses 25.25 E within the band 35.1-35.2 N: the two southern tiles.
      const poly = await insert(db, "bay", box(25.2, 35.1, 25.3, 35.2));
      const pt = await insert(db, "harbour", point(25.4, 35.4));
      const r = await assignTiles(db, "hier-test");
      expect(r.links).toBeGreaterThanOrEqual(2);

      const linksOf = async (id: string) =>
        (await db.select({ tileId: tileGeoObjects.tileId }).from(tileGeoObjects).where(eq(tileGeoObjects.geoObjectId, id)))
          .map((l) => l.tileId)
          .sort();
      expect(await linksOf(poly)).toEqual([tileIdFor(25.2, 35.1), tileIdFor(25.3, 35.1)].sort());
      expect(await linksOf(pt)).toEqual([tileIdFor(25.4, 35.4)]);
      // The area polygon covers all four tiles.
      expect(await linksOf(ids.areaId)).toHaveLength(4);

      // Rerun rewrites the same links.
      expect(await assignTiles(db, "hier-test")).toEqual(r);
      expect(await linksOf(poly)).toHaveLength(2);

      // An object no longer valid loses its links.
      await db.update(geoObjects).set({ validTo: sql`current_date` }).where(eq(geoObjects.id, pt));
      await assignTiles(db, "hier-test");
      expect(await linksOf(pt)).toEqual([]);
    }));
});
