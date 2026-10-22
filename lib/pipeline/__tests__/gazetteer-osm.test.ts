import { inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { RetryableHttpError, makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import type { OverpassElement } from "@/lib/adapters/overpass";
import type { GazetteerScope } from "@/lib/domain/gazetteer/scope";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, landPolygons, rateLimits } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { importOsm } from "@/lib/pipeline/gazetteer/osm";
import { withRollback } from "@/test/db";
import { testArchive } from "@/test/s3";

// Synthetic subdivision scope outside the pilot box 23.0-23.75 E x 37.0-38.0 N: sea north of 35.35 N, land south of it.
function scope(key = "osm-test"): GazetteerScope {
  return { subdivisionId: newId(), key, country: "GR", bbox: [24.9, 35.2, 25.3, 35.5], sourceLanguages: ["de", "en", "el"] };
}

// The land south of 35.35 N as two pieces sharing the cut line 25.0 E, like the split land polygons dataset.
const LAND: GeoJSON.Polygon[] = [
  { type: "Polygon", coordinates: [[[24.5, 34.9], [25.0, 34.9], [25.0, 35.35], [24.5, 35.35], [24.5, 34.9]]] },
  { type: "Polygon", coordinates: [[[25.0, 34.9], [25.7, 34.9], [25.7, 35.35], [25.0, 35.35], [25.0, 34.9]]] },
];

const ID = 9_120_000_000;
const osm = (type: string, n: number) => `${type}/${ID + n}`;
const pts = (coords: [number, number][]) => coords.map(([lon, lat]) => ({ lat, lon }));

const ELEMENTS: OverpassElement[] = [
  {
    type: "relation",
    id: ID + 1,
    tags: { type: "multipolygon", place: "island", name: "Νήσος Δοκιμή", "name:en": "Test Island", wikidata: "Q999" },
    members: [
      { type: "way", ref: 1, role: "outer", geometry: pts([[25.0, 35.42], [25.05, 35.42], [25.05, 35.45]]) },
      { type: "way", ref: 2, role: "outer", geometry: pts([[25.05, 35.45], [25.0, 35.45], [25.0, 35.42]]) },
      { type: "node", ref: 3, role: "label" },
    ],
  },
  {
    type: "way",
    id: ID + 2,
    tags: { natural: "bay", name: "Όρμος Δοκιμής", "name:de": "Testbucht", source: "survey" },
    nodes: [1, 2, 3],
    geometry: pts([[25.15, 35.35], [25.17, 35.36], [25.19, 35.35]]),
  },
  { type: "node", id: ID + 3, lat: 35.352, lon: 25.12, tags: { leisure: "marina", name: "Test Marina", website: "https://marina.example/", "contact:website": "https://contact.example/", "harbour:category": "marina", phone: "123" } },
  { type: "node", id: ID + 4, lat: 35.345, lon: 25.1, tags: { place: "village", name: "Παραλία" } },
  { type: "node", id: ID + 5, lat: 35.3, lon: 25.1, tags: { place: "village", name: "Mesogeia" } },
  { type: "node", id: ID + 6, lat: 35.348, lon: 25.11, tags: { amenity: "restaurant", name: "Taverna Test" } },
  { type: "node", id: ID + 7, lat: 35.36, lon: 25.2, tags: { natural: "bay" } },
  { type: "node", id: ID + 8, lat: 35.351, lon: 25.25, tags: { natural: "cape", "name:el": "Ακρωτήρι" } },
  { type: "node", id: ID + 9, lat: 35.37, lon: 25.16, tags: { "seamark:type": "anchorage", name: "Test Anchorage" } },
  { type: "node", id: ID + 10, lat: 35.34, lon: 25.11, tags: { amenity: "bench", name: "Bench" } },
];

const IMPORTED = [osm("relation", 1), osm("way", 2), osm("node", 3), osm("node", 4), osm("node", 6), osm("node", 8), osm("node", 9)];
const ALL = [...IMPORTED, osm("node", 5), osm("node", 7), osm("node", 10)];

function transport(payload: unknown, seen: HttpRequest[] = [], status = 200): Transport {
  return async (req) => {
    seen.push(req);
    return makeResponse(status, new TextEncoder().encode(JSON.stringify(payload)));
  };
}

/** Land polygon of the area and a full overpass token bucket, both rolled back with the test. */
async function prepare(db: Db): Promise<void> {
  await db.insert(landPolygons).values(LAND.map((p) => ({ geom: sql`${geomFromGeoJson(p)}`, datasetVersion: "test" })));
  await db
    .insert(rateLimits)
    .values({ key: "http:overpass", tokens: 1_000_000, updatedAt: new Date() })
    .onConflictDoUpdate({ target: rateLimits.key, set: { tokens: 1_000_000, updatedAt: new Date() } });
}

async function objects(db: Db, ids = ALL) {
  return db
    .select({ id: geoObjects.id, osmId: geoObjects.osmId, type: geoObjects.type, category: geoObjects.category, tags: geoObjects.tags })
    .from(geoObjects)
    .where(inArray(geoObjects.osmId, ids));
}

const archive = testArchive();
beforeAll(() => archive.ensureBucket());

describe("importOsm", () => {
  it("imports the fixture: island, bay, marina, coastal village and taverna, not the inland village", () =>
    withRollback(async (db) => {
      await prepare(db);
      const seen: HttpRequest[] = [];
      const result = await importOsm(db, { scope: scope(), runId: newId() }, { transport: transport({ elements: ELEMENTS }, seen), archive });
      expect(result).toMatchObject({ created: 7, updated: 0, skipped: 3 });
      expect(result.names).toBeGreaterThan(7);

      const rows = await objects(db);
      const byOsm = new Map(rows.map((r) => [r.osmId, r]));
      expect([...byOsm.keys()].sort()).toEqual([...IMPORTED].sort());
      expect(byOsm.get(osm("relation", 1))).toMatchObject({ type: "island", tags: { place: "island", wikidata: "Q999" } });
      expect(byOsm.get(osm("way", 2))).toMatchObject({ type: "bay", tags: { natural: "bay" } });
      expect(byOsm.get(osm("node", 3))?.type).toBe("harbour");
      expect(byOsm.get(osm("node", 4))?.type).toBe("settlement");
      expect(byOsm.get(osm("node", 6))).toMatchObject({ type: "poi", category: "food" });
      expect(byOsm.get(osm("node", 8))?.type).toBe("cape");
      expect(byOsm.get(osm("node", 9))?.type).toBe("bay");

      // Tag whitelist: name, type and source are not kept.
      expect(byOsm.get(osm("relation", 1))?.tags).toEqual({ place: "island", wikidata: "Q999" });
      expect(byOsm.get(osm("way", 2))?.tags).toEqual({ natural: "bay" });
      // website, contact:website and harbour:category are kept (spec 16 C); phone is not.
      expect(byOsm.get(osm("node", 3))?.tags).toEqual({
        leisure: "marina",
        website: "https://marina.example/",
        "contact:website": "https://contact.example/",
        "harbour:category": "marina",
      });

      const [island] = await db
        .select({ type: sql<string>`GeometryType(${geoObjects.geom})` })
        .from(geoObjects)
        .where(inArray(geoObjects.osmId, [osm("relation", 1)]));
      expect(island?.type).toBe("POLYGON");

      const islandNames = await db
        .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin })
        .from(geoNames)
        .where(inArray(geoNames.geoObjectId, [byOsm.get(osm("relation", 1))!.id]));
      expect(islandNames).toEqual(
        expect.arrayContaining([
          { name: "Νήσος Δοκιμή", language: "el", origin: "osm" },
          { name: "Test Island", language: "en", origin: "osm" },
          { name: "Nisos Dokimi", language: "el", origin: "transliteration" },
        ]),
      );

      expect(seen).toHaveLength(1);
      const ql = decodeURIComponent(String(seen[0]!.body).replace(/^data=/, ""));
      // Area box 24.9-25.3 E x 35.2-35.5 N plus 5 km.
      const box = /\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\);/.exec(ql)!.slice(1).map(Number);
      expect(box[0]).toBeCloseTo(35.2 - 5 / 111.32, 6);
      expect(box[3]).toBeLessThan(25.3 + 0.06);
      expect(box[3]).toBeGreaterThan(25.3 + 0.05);
    }));

  it("a second run with the same answer creates and updates nothing", () =>
    withRollback(async (db) => {
      await prepare(db);
      const input = { scope: scope(), runId: newId() };
      const deps = { transport: transport({ elements: ELEMENTS }), archive };
      await importOsm(db, input, deps);
      const second = await importOsm(db, input, deps);
      expect(second).toEqual({ created: 0, updated: 0, skipped: 3, names: 0 });
    }));

  it("archives the raw overpass response under datasets/overpass/<subdivision key>/<date>.json", () =>
    withRollback(async (db) => {
      await prepare(db);
      const key = `osm-test-${newId()}`;
      const payload = { elements: ELEMENTS };
      await importOsm(
        db,
        { scope: scope(key), runId: newId(), now: new Date("2026-10-18T22:30:00Z") },
        { transport: transport(payload), archive },
      );
      const body = await archive.get(`datasets/overpass/${key}/2026-10-18.json`);
      expect(body).not.toBeNull();
      expect(new TextDecoder().decode(body!)).toBe(JSON.stringify(payload));
    }));

  it("no partial import: a failing upsert rolls back every object of the run", () =>
    withRollback(async (db) => {
      // A real database failure on the last imported element, after six successful upserts.
      await db.execute(sql`
        CREATE FUNCTION test_fail_geo_object_insert() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'injected insert failure'; END $$`);
      await db.execute(sql.raw(`
        CREATE TRIGGER test_fail_geo_object_insert BEFORE INSERT ON geo_objects
        FOR EACH ROW WHEN (NEW.osm_id = '${osm("node", 9)}') EXECUTE FUNCTION test_fail_geo_object_insert()`));
      await prepare(db);
      const error = await importOsm(db, { scope: scope(), runId: newId() }, { transport: transport({ elements: ELEMENTS }), archive }).then(
        () => null,
        (e: unknown) => e as Error & { cause?: Error },
      );
      expect(`${error?.message} ${error?.cause?.message}`).toContain("injected insert failure");
      expect(await objects(db)).toEqual([]);
      const names = await db.execute(sql`SELECT 1 FROM geo_names WHERE name IN ('Test Marina', 'Taverna Test')`);
      expect(names.rows).toEqual([]);
    }));

  it("repairs a self-intersecting way, skips an unrepairable one and still imports the rest", () =>
    withRollback(async (db) => {
      await prepare(db);
      const bowtie: OverpassElement = {
        type: "way",
        id: ID + 11,
        tags: { natural: "bay", name: "Bowtie Bay" },
        nodes: [1, 2, 3, 4, 1],
        geometry: pts([[25.2, 35.36], [25.22, 35.38], [25.22, 35.36], [25.2, 35.38], [25.2, 35.36]]),
      };
      const broken: OverpassElement = {
        type: "way",
        id: ID + 12,
        tags: { natural: "bay", name: "Broken Bay" },
        nodes: [1],
        geometry: pts([[25.2, 35.36]]),
      };
      const result = await importOsm(
        db,
        { scope: scope(), runId: newId() },
        { transport: transport({ elements: [...ELEMENTS, bowtie, broken] }), archive },
      );
      expect(result).toMatchObject({ created: 8, updated: 0, skipped: 4 });
      const rows = await objects(db, [...ALL, osm("way", 11), osm("way", 12)]);
      expect(rows.map((r) => r.osmId).sort()).toEqual([...IMPORTED, osm("way", 11)].sort());
      const [repaired] = await db
        .select({ type: sql<string>`GeometryType(${geoObjects.geom})`, valid: sql<boolean>`ST_IsValid(${geoObjects.geom})` })
        .from(geoObjects)
        .where(inArray(geoObjects.osmId, [osm("way", 11)]));
      expect(repaired).toEqual({ type: "MULTIPOLYGON", valid: true });
    }));

  it("a settlement near a cut line between land pieces is inland, one near the water is coastal", () =>
    withRollback(async (db) => {
      await prepare(db);
      const villages: OverpassElement[] = [
        // ~500 m east of the shared edge 25.0 E, ~11 km from the water.
        { type: "node", id: ID + 21, lat: 35.25, lon: 25.0055, tags: { place: "village", name: "Kopi" } },
        // ~500 m south of the coastline 35.35 N.
        { type: "node", id: ID + 22, lat: 35.3455, lon: 25.15, tags: { place: "village", name: "Akti" } },
      ];
      const result = await importOsm(db, { scope: scope(), runId: newId() }, { transport: transport({ elements: villages }), archive });
      expect(result).toMatchObject({ created: 1, skipped: 1 });
      const rows = await objects(db, [osm("node", 21), osm("node", 22)]);
      expect(rows.map((r) => r.osmId)).toEqual([osm("node", 22)]);
    }));

  it("relations use inner and role-less members too: an island with a hole", () =>
    withRollback(async (db) => {
      await prepare(db);
      const island: OverpassElement = {
        type: "relation",
        id: ID + 31,
        tags: { type: "multipolygon", place: "island", name: "Ring Island" },
        members: [
          { type: "way", ref: 1, role: "", geometry: pts([[25.1, 35.4], [25.2, 35.4], [25.2, 35.48], [25.1, 35.48], [25.1, 35.4]]) },
          { type: "way", ref: 2, role: "inner", geometry: pts([[25.13, 35.42], [25.17, 35.42], [25.17, 35.46], [25.13, 35.46], [25.13, 35.42]]) },
        ],
      };
      await importOsm(db, { scope: scope(), runId: newId() }, { transport: transport({ elements: [island] }), archive });
      const [row] = await db
        .select({ type: sql<string>`GeometryType(${geoObjects.geom})`, holes: sql<number>`ST_NumInteriorRings(${geoObjects.geom})` })
        .from(geoObjects)
        .where(inArray(geoObjects.osmId, [osm("relation", 31)]));
      expect(row).toEqual({ type: "POLYGON", holes: 1 });
    }));

  it("missing land polygons fails with a clear message", () =>
    withRollback(async (db) => {
      const seen: HttpRequest[] = [];
      await expect(
        importOsm(db, { scope: scope(), runId: newId() }, { transport: transport({ elements: ELEMENTS }, seen), archive }),
      ).rejects.toThrow("land polygons missing for osm-test – run npm run import:land-polygons");
      expect(seen).toHaveLength(0);
    }));

  it("a 429 from overpass leaves the database untouched and throws RetryableHttpError", () =>
    withRollback(async (db) => {
      await prepare(db);
      // Only rows this transaction wrote (`created_at = now()`): other test files commit geo rows meanwhile.
      const written = async () => ({
        objects: (await db.select({ n: sql<number>`count(*)::int` }).from(geoObjects).where(sql`${geoObjects.createdAt} = now()`))[0]!.n,
        names: (await db.select({ n: sql<number>`count(*)::int` }).from(geoNames).where(sql`${geoNames.createdAt} = now()`))[0]!.n,
      });
      await expect(
        importOsm(db, { scope: scope(), runId: newId() }, { transport: transport({}, [], 429), archive }),
      ).rejects.toBeInstanceOf(RetryableHttpError);
      expect(await written()).toEqual({ objects: 0, names: 0 });
      expect(await objects(db)).toEqual([]);
    }));
});
