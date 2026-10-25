import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, landPolygons, subdivisions, tileGeoObjects, type GeoObjectType } from "@/lib/db/schema";
import {
  assignObjects,
  assignParentOf,
  assignParents,
  assignSeas,
  assignSubdivisions,
  assignSubdivisionTiles,
  assignTiles,
} from "@/lib/domain/gazetteer/hierarchy";
import { ensureSubdivisionTiles } from "@/lib/domain/gazetteer/tiles-ensure";
import { newPublicId } from "@/lib/domain/ids";
import { tileIdFor, type Bbox } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";

// Synthetic subdivision "GR-HT" outside the pilot box 23.0-23.75 E x 37.0-38.0 N: 25.0-25.5 E x 35.0-35.5 N
// (four tiles), all of it land, with a coast section in its south-east corner. Kastellorizo lives at 29.6 E.
type Polygon = { type: "Polygon"; coordinates: [number, number][][] };
const box = (w: number, s: number, e: number, n: number): Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});
const HT: Bbox = [25.0, 35.0, 25.5, 35.5];

const envelope = ([w, s, e, n]: Bbox) => sql`ST_Multi(ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326))`;

async function insert(db: Db, type: GeoObjectType, geometry: GeoJSON.Geometry, patch: Partial<typeof geoObjects.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(geoObjects)
    .values({ type, origin: "osm", geom: sql`${geomFromGeoJson(geometry)}`, ...patch })
    .returning({ id: geoObjects.id });
  return row!.id;
}

const point = (lon: number, lat: number): GeoJSON.Point => ({ type: "Point", coordinates: [lon, lat] });

async function parentOf(db: Db, id: string): Promise<string | null> {
  const [row] = await db.select({ parentId: geoObjects.parentId }).from(geoObjects).where(eq(geoObjects.id, id));
  return row!.parentId;
}

async function subdivisionOf(db: Db, id: string): Promise<string | null> {
  const [row] = await db.select({ subdivisionId: geoObjects.subdivisionId }).from(geoObjects).where(eq(geoObjects.id, id));
  return row!.subdivisionId;
}

async function seaOf(db: Db, id: string): Promise<string | null> {
  const [row] = await db.select({ seaId: geoObjects.seaId }).from(geoObjects).where(eq(geoObjects.id, id));
  return row!.seaId;
}

/** A first-level admin region and its subdivision; `geom` is the padded polygon, `land` the land of the unit. */
async function addSubdivision(db: Db, key: string, geom: Bbox, land: Bbox | null, country = "GR") {
  const regionId = await insert(db, "admin_region", box(...geom), { origin: "manual", adminLevel: 5, tags: { country } });
  const [row] = await db
    .insert(subdivisions)
    .values({
      publicId: newPublicId("sd"),
      key,
      country,
      geoObjectId: regionId,
      geom: envelope(geom),
      landGeom: land ? envelope(land) : null,
    })
    .returning({ id: subdivisions.id });
  return { id: row!.id, regionId };
}

async function addCountry(db: Db, iso: string, geom: Bbox): Promise<string> {
  return insert(db, "country", box(...geom), { origin: "manual", tags: { country: iso } });
}

/** `assignSubdivisions`, `assignSeas`, then `assignParents` for the box of GR-HT: the order of the hierarchy stage. */
async function assignAll(db: Db, bbox: Bbox = HT) {
  await assignSubdivisions(db, bbox);
  await assignSeas(db, bbox);
  return assignParents(db, bbox);
}

async function setup(db: Db) {
  const countryId = await addCountry(db, "GR", [24.0, 34.0, 26.0, 36.0]);
  const sub = await addSubdivision(db, "GR-HT", HT, HT);
  const sectionId = await insert(db, "coast_section", box(25.35, 35.0, 25.5, 35.1), {
    origin: "manual",
    configKey: "GR-HT/south-east",
  });
  return { countryId, subdivisionId: sub.id, regionId: sub.regionId, sectionId };
}

// Island 25.10-25.20 E x 35.20-35.30 N; 0.001 degree latitude is ~111 m.
const ISLAND = box(25.1, 35.2, 25.2, 35.3);

describe("assignSubdivisions", () => {
  it("an island near a foreign coast belongs to its own country's subdivision", () =>
    withRollback(async (db) => {
      // Kastellorizo: a Greek island ~3 km off the Turkish coast, its centroid inside the Turkish padded polygon
      // (12 nm of water) but outside the Greek one's land.
      const turkey = await addSubdivision(db, "TR-TEST", [28.9, 36.0, 29.9, 36.4], [28.9, 36.0, 29.6, 36.4], "TR");
      const greece = await addSubdivision(db, "GR-TEST", [29.55, 36.05, 29.95, 36.25], [29.633, 36.14, 29.653, 36.15]);
      const island = await insert(db, "island", box(29.633, 36.14, 29.653, 36.15));
      const harbour = await insert(db, "harbour", point(29.64, 36.1445));
      const turkishBay = await insert(db, "bay", point(29.55, 36.2));

      expect(await assignSubdivisions(db, [29.0, 36.0, 30.0, 36.4])).toBe(3);
      expect(await subdivisionOf(db, island)).toBe(greece.id);
      expect(await subdivisionOf(db, harbour)).toBe(greece.id);
      expect(await subdivisionOf(db, turkishBay)).toBe(turkey.id);

      // Only changed rows are written.
      expect(await assignSubdivisions(db, [29.0, 36.0, 30.0, 36.4])).toBe(0);
    }));

  it("an object without land within 30 km gets no subdivision; countries, regions and seas are not assigned", () =>
    withRollback(async (db) => {
      const { regionId, countryId } = await setup(db);
      const far = await insert(db, "bay", point(25.4, 36.0)); // ~55 km north of the land (35.5 N), outside the box
      const near = await insert(db, "bay", point(25.4, 35.4));
      const sea = await insert(db, "sea", box(24.0, 34.0, 27.0, 37.0), { origin: "manual" });
      await assignSubdivisions(db, [25.0, 35.0, 25.5, 36.5]);
      expect(await subdivisionOf(db, far)).toBeNull();
      expect(await subdivisionOf(db, near)).not.toBeNull();
      for (const id of [regionId, countryId, sea]) expect(await subdivisionOf(db, id)).toBeNull();
    }));

  it("gulfs, archipelagos, straits and channels take the nearest land without the radius limit", () =>
    withRollback(async (db) => {
      const { subdivisionId } = await setup(db);
      // 60 km north of the land (35.5 N): beyond subdivisionRadiusM for a bay.
      const bay = await insert(db, "bay", point(25.25, 36.05));
      const kinds = await Promise.all(
        (["gulf", "archipelago", "strait", "channel"] as const).map((t) => insert(db, t, point(25.25, 36.05))),
      );
      await assignSubdivisions(db, [25.0, 35.9, 25.5, 36.2]);
      expect(await subdivisionOf(db, bay)).toBeNull();
      for (const id of kinds) expect(await subdivisionOf(db, id)).toBe(subdivisionId);
    }));

  it("a subdivision without land (land_geom null) takes no objects", () =>
    withRollback(async (db) => {
      await addSubdivision(db, "GR-NOLAND", HT, null);
      const bay = await insert(db, "bay", point(25.4, 35.4));
      expect(await assignSubdivisions(db, HT)).toBe(0);
      expect(await subdivisionOf(db, bay)).toBeNull();
    }));
});

describe("assignSeas", () => {
  it("sets sea_id to the smallest sea covering the centroid, else the nearest", () =>
    withRollback(async (db) => {
      await setup(db);
      const big = await insert(db, "sea", box(24.0, 34.0, 27.0, 37.0), { origin: "manual" });
      const small = await insert(db, "sea", box(24.9, 35.1, 25.6, 35.6), { origin: "manual" });
      const inSmall = await insert(db, "bay", point(25.4, 35.4));
      const inBig = await insert(db, "bay", point(26.5, 36.5));
      const outside = await insert(db, "bay", point(27.2, 36.5)); // nearest sea: big
      // Rows other test files committed to the shared database may lie in the box too: count only our own.
      expect(await assignSeas(db, [24.0, 34.0, 28.0, 37.0])).toBeGreaterThanOrEqual(3);
      expect(await seaOf(db, inSmall)).toBe(small);
      expect(await seaOf(db, inBig)).toBe(big);
      expect(await seaOf(db, outside)).toBe(big);
      expect(await assignSeas(db, [24.0, 34.0, 28.0, 37.0])).toBe(0); // only changed rows
    }));
});

describe("assignParents", () => {
  it("bay inside an island buffer gets the island", () =>
    withRollback(async (db) => {
      await setup(db);
      const island = await insert(db, "island", ISLAND);
      const bay = await insert(db, "bay", point(25.15, 35.3011)); // ~120 m north of the shore
      const far = await insert(db, "bay", point(25.15, 35.3108)); // ~1.2 km: outside the buffer and islandParentNearestM
      const r = await assignAll(db);
      expect(r.updated).toBeGreaterThan(0);
      expect(await parentOf(db, bay)).toBe(island);
      expect(await parentOf(db, far)).not.toBe(island);

      // Unchanged rerun writes nothing.
      expect(await assignParents(db, HT)).toEqual({ updated: 0 });
    }));

  describe("nearest island within islandParentNearestM (B10)", () => {
    // ISLAND's north shore is 35.30 N; 0.0054 degree latitude is ~600 m. The island's own land is in land_polygons
    // too: it lies within the island polygon and does not count as mainland.
    const OFF = 35.3054;
    async function land(db: Db, polygon: Polygon) {
      await db.insert(landPolygons).values({ geom: sql`${geomFromGeoJson(polygon)}`, datasetVersion: "test" });
    }

    it("a bay, islet and cape 600 m off the island and 3 km from the mainland get the island", () =>
      withRollback(async (db) => {
        await setup(db);
        const island = await insert(db, "island", ISLAND);
        await land(db, ISLAND);
        await land(db, box(25.0, 35.333, 25.5, 35.5)); // mainland ~3 km north of the bay
        const bay = await insert(db, "bay", point(25.15, OFF));
        // a point islet (Wikidata, GeoNames) on its own rock: land no island polygon covers, but no mainland
        const islet = await insert(db, "islet", point(25.14, OFF));
        await land(db, box(25.1395, 35.305, 25.1405, 35.3058));
        const cape = await insert(db, "cape", point(25.16, OFF));
        await assignAll(db);
        for (const id of [bay, islet, cape]) expect(await parentOf(db, id)).toBe(island);
        expect(await assignParents(db, HT)).toEqual({ updated: 0 });
        // the same rule for the objects of the stage gazetteer.land
        const landed = await insert(db, "bay", point(25.17, OFF));
        await assignObjects(db, [landed]);
        expect(await parentOf(db, landed)).toBe(island);
      }));

    it("a bay 600 m off the island but 300 m from the mainland keeps the subdivision", () =>
      withRollback(async (db) => {
        const { regionId } = await setup(db);
        await insert(db, "island", ISLAND);
        await land(db, ISLAND);
        await land(db, box(25.0, 35.3081, 25.5, 35.5)); // mainland ~300 m north of the bay
        const bay = await insert(db, "bay", point(25.15, OFF));
        const islet = await insert(db, "islet", point(25.14, OFF));
        await assignAll(db);
        expect(await parentOf(db, bay)).toBe(regionId);
        expect(await parentOf(db, islet)).toBe(regionId);
      }));

    it("a bay with a rock islet 300 m away and an island 600 m away gets the island", () =>
      withRollback(async (db) => {
        await setup(db);
        const island = await insert(db, "island", ISLAND);
        await land(db, ISLAND);
        await land(db, box(25.0, 35.333, 25.5, 35.5)); // mainland ~3 km north of the bay
        // an islet polygon ~310 m north of the bay: outside the buffer, nearer than the island
        const rock = box(25.149, 35.3082, 25.151, 35.3086);
        const islet = await insert(db, "islet", rock);
        await land(db, rock);
        const bay = await insert(db, "bay", point(25.15, OFF));
        await assignAll(db);
        expect(await parentOf(db, bay)).toBe(island);
        expect(await parentOf(db, islet)).toBe(island);
      }));

    it("a bay 1,500 m off the island keeps the subdivision", () =>
      withRollback(async (db) => {
        const { regionId } = await setup(db);
        await insert(db, "island", ISLAND);
        await land(db, ISLAND);
        await land(db, box(25.0, 35.345, 25.5, 35.5)); // mainland ~3.5 km north of the bay
        const bay = await insert(db, "bay", point(25.15, 35.3135));
        await assignAll(db);
        expect(await parentOf(db, bay)).toBe(regionId);
      }));
  });

  it("a point island does not act as parent", () =>
    withRollback(async (db) => {
      const { regionId } = await setup(db);
      await insert(db, "island", point(25.3, 35.3));
      const bay = await insert(db, "bay", point(25.3005, 35.3));
      await assignAll(db);
      expect(await parentOf(db, bay)).toBe(regionId);
    }));

  it("bay on the mainland without coast section gets the subdivision's admin region", () =>
    withRollback(async (db) => {
      const { regionId } = await setup(db);
      await insert(db, "island", ISLAND);
      const bay = await insert(db, "bay", point(25.4, 35.4));
      await assignAll(db);
      expect(await parentOf(db, bay)).toBe(regionId);
    }));

  it("bay inside a coast section gets the section", () =>
    withRollback(async (db) => {
      const { regionId, sectionId } = await setup(db);
      const bay = await insert(db, "bay", point(25.4, 35.05));
      const harbour = await insert(db, "harbour", point(25.42, 35.06));
      await assignAll(db);
      expect(await parentOf(db, bay)).toBe(sectionId);
      expect(await parentOf(db, harbour)).toBe(sectionId);
      expect(await parentOf(db, sectionId)).toBe(regionId);
    }));

  it("only a configured coast section is a parent: one without config_key is none, whatever its size (B6)", () =>
    withRollback(async (db) => {
      const { regionId, sectionId } = await setup(db);
      // An OSM-like section of ~230 km2 without config_key around the bay: no parent.
      await insert(db, "coast_section", box(25.3, 35.3, 25.45, 35.45));
      const bay = await insert(db, "bay", point(25.4, 35.4));
      // A bay in the configured section keeps it, even inside a smaller (~16 km2) section without config_key.
      await insert(db, "coast_section", box(25.38, 35.03, 25.42, 35.07));
      const sectionBay = await insert(db, "bay", point(25.4, 35.05));
      await assignAll(db);
      expect(await parentOf(db, bay)).toBe(regionId);
      expect(await parentOf(db, sectionBay)).toBe(sectionId);
    }));

  it("island gets its subdivision's admin region, or its archipelago", () =>
    withRollback(async (db) => {
      const { regionId } = await setup(db);
      const island = await insert(db, "island", ISLAND);
      expect((await assignAll(db)).updated).toBeGreaterThan(0);
      expect(await parentOf(db, island)).toBe(regionId);

      const archipelago = await insert(db, "archipelago", box(25.05, 35.15, 25.25, 35.35));
      await assignAll(db);
      expect(await parentOf(db, island)).toBe(archipelago);
      expect(await parentOf(db, archipelago)).toBe(regionId);
    }));

  it("a gulf belongs to its subdivision's admin region", () =>
    withRollback(async (db) => {
      const { regionId } = await setup(db);
      const gulf = await insert(db, "gulf", box(25.2, 35.2, 25.4, 35.4));
      await assignAll(db);
      expect(await parentOf(db, gulf)).toBe(regionId);
    }));

  it("bay -> island -> admin_region -> country chain", () =>
    withRollback(async (db) => {
      const { regionId, countryId } = await setup(db);
      const island = await insert(db, "island", ISLAND);
      const bay = await insert(db, "bay", point(25.15, 35.3011));
      await assignAll(db);
      expect(await parentOf(db, bay)).toBe(island);
      expect(await parentOf(db, island)).toBe(regionId);
      expect(await parentOf(db, regionId)).toBe(countryId);
      expect(await parentOf(db, countryId)).toBeNull();
    }));

  it("an admin region of a split group has its country as parent", () =>
    withRollback(async (db) => {
      const { countryId } = await setup(db);
      const group = await insert(db, "admin_region", box(25.0, 35.0, 25.2, 35.2), {
        origin: "manual",
        configKey: "GR-HT-GROUP",
        adminLevel: 5,
        tags: { country: "GR" },
      });
      await assignAll(db);
      expect(await parentOf(db, group)).toBe(countryId);
    }));

  it("a second-level admin region gets the smallest first-level or group region covering its point, else the country", () =>
    withRollback(async (db) => {
      const { countryId, regionId } = await setup(db);
      const group = await insert(db, "admin_region", box(25.0, 35.0, 25.2, 35.2), {
        origin: "manual",
        configKey: "GR-HT-GROUP",
        adminLevel: 5,
        tags: { country: "GR" },
      });
      const inGroup = await insert(db, "admin_region", box(25.0, 35.0, 25.1, 35.1), { origin: "osm", adminLevel: 6, tags: { country: "GR" } });
      const inRegion = await insert(db, "admin_region", box(25.3, 35.3, 25.4, 35.4), { origin: "osm", adminLevel: 6, tags: { country: "GR" } });
      const outside = await insert(db, "admin_region", box(24.2, 34.2, 24.4, 34.4), { origin: "osm", adminLevel: 6, tags: { country: "GR" } });
      // Another country's first-level region covering the point is no parent.
      await insert(db, "admin_region", box(25.25, 35.25, 25.45, 35.45), { origin: "osm", adminLevel: 5, tags: { country: "TR" } });
      await assignAll(db, [24.0, 34.0, 26.0, 36.0]);
      expect(await parentOf(db, inGroup)).toBe(group);
      expect(await parentOf(db, inRegion)).toBe(regionId);
      expect(await parentOf(db, outside)).toBe(countryId);
      // A second-level region is never the parent of another.
      expect(await parentOf(db, group)).toBe(countryId);
    }));

  it("an extra unit gets its configured country; a country with two level-2 rows takes its own ISO3166-1 relation", () =>
    withRollback(async (db) => {
      // The decoy sorts first by id; the country's own relation is told by ISO3166-1.
      const decoy = await insert(db, "country", box(25.0, 35.0, 25.5, 35.5), {
        id: "00000000-0000-4000-8000-000000000001",
        origin: "osm",
        adminLevel: 2,
        tags: { country: "GB", admin_level: "2" },
      });
      const own = await insert(db, "country", box(24.0, 34.0, 26.0, 36.0), {
        id: "ffffffff-0000-4000-8000-000000000001",
        origin: "osm",
        adminLevel: 2,
        tags: { country: "GB", admin_level: "2", "ISO3166-1": "GB" },
      });
      // Like GB-SBA: an extra unit without config_key, level 6, in a "whole" country.
      const sub = await addSubdivision(db, "GB-SBA", HT, HT, "GB");
      await db.update(geoObjects).set({ adminLevel: 6 }).where(eq(geoObjects.id, sub.regionId));
      await assignAll(db);
      expect(await parentOf(db, sub.regionId)).toBe(own);
      expect(own).not.toBe(decoy);
    }));

  it("area object keeps no parent", () =>
    withRollback(async (db) => {
      await setup(db);
      const gulf = await insert(db, "gulf", box(24.9, 35.1, 25.6, 35.6));
      const area = await insert(db, "area", box(25.0, 35.0, 25.5, 35.5), { origin: "manual", configKey: "hier-revier", parentId: gulf });
      await assignAll(db);
      expect(await parentOf(db, area)).toBeNull();
    }));

  it("a bay outside every subdivision, island and section gets no parent", () =>
    withRollback(async (db) => {
      await setup(db);
      await insert(db, "sea", box(24.0, 34.0, 27.0, 37.0), { origin: "manual" });
      const bay = await insert(db, "bay", point(25.4, 36.2)); // 80 km north of the land
      await assignAll(db, [25.0, 35.0, 25.5, 36.5]);
      expect(await parentOf(db, bay)).toBeNull();
    }));
});

describe("assignParentOf", () => {
  it("assigns subdivision, sea and parent of one new object", () =>
    withRollback(async (db) => {
      const { regionId, subdivisionId } = await setup(db);
      const sea = await insert(db, "sea", box(24.0, 34.0, 27.0, 37.0), { origin: "manual" });
      const bay = await insert(db, "bay", point(25.4, 35.4), { origin: "text" });
      expect(await assignParentOf(db, bay)).toBe(regionId);
      expect(await subdivisionOf(db, bay)).toBe(subdivisionId);
      expect(await seaOf(db, bay)).toBe(sea);
    }));
});

describe("assignObjects", () => {
  it("assigns subdivision, sea, parent and tile links of the given objects only; links are added, never rewritten", () =>
    withRollback(async (db) => {
      const { regionId, subdivisionId } = await setup(db);
      const sea = await insert(db, "sea", box(24.0, 34.0, 27.0, 37.0), { origin: "manual" });
      await db.insert(landPolygons).values({ geom: sql`ST_MakeEnvelope(25.0, 35.0, 25.5, 35.5, 4326)`, datasetVersion: "test" });
      await ensureSubdivisionTiles(db, subdivisionId);
      const poi = await insert(db, "poi", point(25.4, 35.4), { category: "food" });
      const other = await insert(db, "bay", point(25.3, 35.3));
      const kept = await insert(db, "bay", point(25.1, 35.1));
      await db.insert(tileGeoObjects).values({ tileId: tileIdFor(25.1, 35.1), geoObjectId: kept });

      const r = await assignObjects(db, [poi]);
      expect(r).toMatchObject({ subdivisions: 1, seas: 1, links: 1 });
      expect(await subdivisionOf(db, poi)).toBe(subdivisionId);
      expect(await seaOf(db, poi)).toBe(sea);
      expect(await parentOf(db, poi)).toBe(regionId);
      const links = await db.select({ tileId: tileGeoObjects.tileId, id: tileGeoObjects.geoObjectId }).from(tileGeoObjects);
      expect(links.filter((l) => l.id === poi).map((l) => l.tileId)).toEqual([tileIdFor(25.4, 35.4)]);
      // other objects stay as they are, their links too
      expect(await subdivisionOf(db, other)).toBeNull();
      expect(await parentOf(db, other)).toBeNull();
      expect(links.filter((l) => l.id === kept).map((l) => l.tileId)).toEqual([tileIdFor(25.1, 35.1)]);
      // a rerun adds nothing
      expect(await assignObjects(db, [poi])).toEqual({ subdivisions: 0, seas: 0, updated: 0, links: 0 });
      expect(await assignObjects(db, [])).toEqual({ subdivisions: 0, seas: 0, updated: 0, links: 0 });
    }));
});

describe("assignTiles", () => {
  it("assignTiles links a polygon to every tile it touches", () =>
    withRollback(async (db) => {
      const { regionId, countryId, subdivisionId } = await setup(db);
      const seaId = await insert(db, "sea", box(24.0, 34.0, 27.0, 37.0), { origin: "manual" });
      await db.insert(landPolygons).values({ geom: sql`ST_MakeEnvelope(25.0, 35.0, 25.5, 35.5, 4326)`, datasetVersion: "test" });
      await ensureSubdivisionTiles(db, subdivisionId);
      // Crosses 25.25 E within the band 35.1-35.2 N: the two southern tiles.
      const poly = await insert(db, "bay", box(25.2, 35.1, 25.3, 35.2));
      const pt = await insert(db, "harbour", point(25.4, 35.4));
      const r = await assignSubdivisionTiles(db, subdivisionId);
      expect(r.links).toBeGreaterThanOrEqual(2);

      const linksOf = async (id: string) =>
        (await db.select({ tileId: tileGeoObjects.tileId }).from(tileGeoObjects).where(eq(tileGeoObjects.geoObjectId, id)))
          .map((l) => l.tileId)
          .sort();
      expect(await linksOf(poly)).toEqual([tileIdFor(25.2, 35.1), tileIdFor(25.3, 35.1)].sort());
      expect(await linksOf(pt)).toEqual([tileIdFor(25.4, 35.4)]);
      // Country, admin region and sea polygons are not tile content: mentions reach their tiles through the hierarchy.
      expect(await linksOf(regionId)).toEqual([]);
      expect(await linksOf(seaId)).toEqual([]);
      expect(await linksOf(countryId)).toEqual([]);

      // Rerun rewrites the same links.
      expect(await assignSubdivisionTiles(db, subdivisionId)).toEqual(r);
      expect(await linksOf(poly)).toHaveLength(2);

      // An object no longer valid loses its links.
      await db.update(geoObjects).set({ validTo: sql`current_date` }).where(eq(geoObjects.id, pt));
      await assignSubdivisionTiles(db, subdivisionId);
      expect(await linksOf(pt)).toEqual([]);
    }));

  it("assignTiles without tiles writes nothing", () =>
    withRollback(async (db) => {
      expect(await assignTiles(db, [])).toEqual({ links: 0 });
    }));
});
