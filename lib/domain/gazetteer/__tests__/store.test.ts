import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { geoNames, geoObjects } from "@/lib/db/schema";
import { isPublicId } from "@/lib/domain/ids";
import { upsertGeoObject, type GeoObjectDraft } from "@/lib/domain/gazetteer/store";
import { withRollback } from "@/test/db";

// Outside the pilot box 23.0-23.75 E x 37.0-38.0 N; osm ids unique per test so committed rows of other tests never match.
const osmId = (kind: string) => `${kind}/${Date.now()}${Math.floor(Math.random() * 1e6)}`;

function line(coords: [number, number][]): GeoJSON.LineString {
  return { type: "LineString", coordinates: coords };
}

async function shape(db: Parameters<Parameters<typeof withRollback>[0]>[0], id: string) {
  const [row] = await db
    .select({
      type: sql<string>`GeometryType(${geoObjects.geom})`,
      area: sql<number>`ST_Area(${geoObjects.geom})`,
    })
    .from(geoObjects)
    .where(eq(geoObjects.id, id));
  return row!;
}

describe("upsertGeoObject", () => {
  it("upsertGeoObject builds a polygon from relation outer lines", () =>
    withRollback(async (db) => {
      const draft: GeoObjectDraft = {
        type: "island",
        origin: "osm",
        osmId: osmId("relation"),
        geometry: {
          lines: [
            line([[25.0, 35.3], [25.1, 35.3], [25.1, 35.4]]),
            line([[25.1, 35.4], [25.0, 35.4], [25.0, 35.3]]),
          ],
        },
        names: [{ name: "Test Island", language: "en", origin: "osm" }],
      };
      const r = await upsertGeoObject(db, draft);
      expect(r.created).toBe(true);
      const s = await shape(db, r.id);
      expect(s.type).toBe("POLYGON");
      expect(s.area).toBeCloseTo(0.01, 6);
      const names = await db.select().from(geoNames).where(eq(geoNames.geoObjectId, r.id));
      expect(names.map((n) => n.name)).toEqual(["Test Island"]);
    }));

  it("falls back to the centroid of the lines when they enclose no area", () =>
    withRollback(async (db) => {
      const r = await upsertGeoObject(db, {
        type: "bay",
        origin: "osm",
        osmId: osmId("relation"),
        geometry: { lines: [line([[25.0, 35.3], [25.2, 35.3]])] },
        names: [],
      });
      const [row] = await db
        .select({ x: sql<number>`ST_X(${geoObjects.geom})`, type: sql<string>`GeometryType(${geoObjects.geom})` })
        .from(geoObjects)
        .where(eq(geoObjects.id, r.id));
      expect(row).toEqual({ x: 25.1, type: "POINT" });
    }));

  it("upsert twice → one row, created false", () =>
    withRollback(async (db) => {
      const draft: GeoObjectDraft = {
        type: "bay",
        origin: "osm",
        osmId: osmId("way"),
        tags: { natural: "bay" },
        geometry: { type: "Point", coordinates: [25.05, 35.35] },
        names: [{ name: "Ormos Test", language: "und", origin: "osm" }],
      };
      const first = await upsertGeoObject(db, draft);
      const second = await upsertGeoObject(db, draft);
      expect(first).toMatchObject({ created: true, changed: true, names: 1 });
      expect(second).toEqual({ id: first.id, created: false, changed: false, names: 0 });
      const rows = await db.select().from(geoObjects).where(eq(geoObjects.osmId, draft.osmId!));
      expect(rows).toHaveLength(1);
      const history = await db.execute(sql`SELECT 1 FROM geo_objects_history WHERE row_id = ${first.id}`);
      expect(history.rows).toHaveLength(0);
    }));

  it("updates a changed geometry and writes history", () =>
    withRollback(async (db) => {
      const draft: GeoObjectDraft = {
        type: "cape",
        origin: "osm",
        osmId: osmId("node"),
        geometry: { type: "Point", coordinates: [25.05, 35.35] },
        names: [],
      };
      const first = await upsertGeoObject(db, draft);
      const second = await upsertGeoObject(db, { ...draft, geometry: { type: "Point", coordinates: [25.06, 35.35] } });
      expect(second).toMatchObject({ id: first.id, created: false, changed: true });
      const history = await db.execute(sql`SELECT 1 FROM geo_objects_history WHERE row_id = ${first.id}`);
      expect(history.rows).toHaveLength(1);
    }));

  it("matches on the first external id present", () =>
    withRollback(async (db) => {
      const wikidataId = `Q${Date.now()}${Math.floor(Math.random() * 1e3)}`;
      const first = await upsertGeoObject(db, {
        type: "poi",
        category: "culture",
        origin: "wikidata",
        wikidataId,
        geometry: { type: "Point", coordinates: [25.05, 35.35] },
        names: [],
      });
      const second = await upsertGeoObject(db, {
        type: "poi",
        category: "culture",
        origin: "wikidata",
        wikidataId,
        geometry: { type: "Point", coordinates: [25.05, 35.35] },
        names: [{ name: "Monastery", language: "en", origin: "wikidata" }],
      });
      expect(second).toMatchObject({ id: first.id, created: false, names: 1 });
    }));

  it("assigns public ids by type", () =>
    withRollback(async (db) => {
      const point: GeoJSON.Point = { type: "Point", coordinates: [25.05, 35.35] };
      const make = (type: GeoObjectDraft["type"]) =>
        upsertGeoObject(db, { type, origin: "osm", osmId: osmId("node"), geometry: point, names: [] });
      const ids = {
        island: (await make("island")).id,
        poi: (await make("poi")).id,
        bay: (await make("bay")).id,
        gulf: (await make("gulf")).id,
      };
      const rows = await db
        .select({ id: geoObjects.id, publicId: geoObjects.publicId })
        .from(geoObjects)
        .where(sql`${geoObjects.id} in ${Object.values(ids)}`);
      const byId = new Map(rows.map((r) => [r.id, r.publicId]));
      expect(isPublicId(byId.get(ids.island)!, "rg")).toBe(true);
      expect(isPublicId(byId.get(ids.gulf)!, "rg")).toBe(true);
      expect(isPublicId(byId.get(ids.poi)!, "hl")).toBe(true);
      expect(byId.get(ids.bay)).toBeNull();
    }));
});
