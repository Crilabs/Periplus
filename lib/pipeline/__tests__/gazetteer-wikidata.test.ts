import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import type { GazetteerScope } from "@/lib/domain/gazetteer/scope";
import type { Db } from "@/lib/db/client";
import { geoNames, geoObjects, rateLimits, reviewTasks } from "@/lib/db/schema";
import { mergeGeoObjects } from "@/lib/domain/gazetteer/merge";
import { newId } from "@/lib/domain/ids";
import { upsertGeoObject, type GeoObjectDraft } from "@/lib/domain/gazetteer/store";
import { importWikidata } from "@/lib/pipeline/gazetteer/wikidata";
import { withRollback } from "@/test/db";
import { createdInThisTransaction, ownGeoObjectIds, pairTasksOf } from "@/test/gazetteer";

// Synthetic subdivision scope outside the pilot box 23.0-23.75 E x 37.0-38.0 N.
function scope(): GazetteerScope {
  return { subdivisionId: newId(), key: "wikidata-test", country: "GR", bbox: [26.0, 35.6, 26.4, 35.9], sourceLanguages: ["de", "en", "el"] };
}

const ID = 9_140_000_000;
const q = (n: number) => `Q${ID + n}`;
const osm = (type: string, n: number) => `${type}/${ID + n}`;

const uri = (id: string) => ({ type: "uri", value: `http://www.wikidata.org/entity/${id}` });
const lit = (value: string) => ({ type: "literal", value });
const bool = (b: boolean) => ({ type: "literal", datatype: "http://www.w3.org/2001/XMLSchema#boolean", value: String(b) });
const wkt = (lon: number, lat: number) => ({
  type: "literal",
  datatype: "http://www.opengis.net/ont/geosparql#wktLiteral",
  value: `Point(${lon} ${lat})`,
});

type Name = [value: string, language: string, alias?: boolean];
function rows(id: string, cls: string, lon: number, lat: number, names: Name[]) {
  return names.map(([value, language, alias = false]) => ({
    item: uri(id),
    class: uri(cls),
    coord: wkt(lon, lat),
    name: lit(value),
    lang: lit(language),
    isAlias: bool(alias),
  }));
}

// Metres per degree at 35.75 N: latitude ~110,950, longitude ~90,100.
const ITEMS = {
  // Island whose OSM object carries the tag wikidata=<item>.
  island: rows(q(1), "Q23442", 26.1, 35.7, [["Testinsel", "de"], ["Test Island", "en"]]),
  // Bay ~450 m east of an OSM bay with the same English name, no tag.
  bay: rows(q(2), "Q39594", 26.205, 35.75, [["Testbucht", "de"], ["Kalm Bay", "en"]]),
  // Monastery without OSM counterpart.
  monastery: rows(q(3), "Q44613", 26.3, 35.8, [["Moni Dokimis", "en"], ["Μονή Δοκιμής", "el"], ["Test Monastery", "en", true]]),
  // Cape ~1500 m north of an OSM cape with the same name: beyond 1 km, within 2 km.
  cape: rows(q(4), "Q185113", 26.35, 35.6635, [["Akrotiri Kavos", "en"]]),
  // Settlement without OSM counterpart: skipped.
  settlement: rows(q(5), "Q486972", 26.05, 35.85, [["Testdorf", "de"]]),
};

const OSM_OBJECTS: GeoObjectDraft[] = [
  {
    type: "island",
    origin: "osm",
    osmId: osm("relation", 1),
    tags: { place: "island", wikidata: q(1) },
    geometry: { type: "Polygon", coordinates: [[[26.08, 35.68], [26.12, 35.68], [26.12, 35.72], [26.08, 35.72], [26.08, 35.68]]] },
    names: [{ name: "Νήσος Δοκιμή", language: "el", origin: "osm" }],
  },
  {
    type: "bay",
    origin: "osm",
    osmId: osm("node", 2),
    tags: { natural: "bay" },
    geometry: { type: "Point", coordinates: [26.2, 35.75] },
    names: [{ name: "Kalm Bay", language: "en", origin: "osm" }],
  },
  {
    type: "cape",
    origin: "osm",
    osmId: osm("node", 4),
    tags: { natural: "cape" },
    geometry: { type: "Point", coordinates: [26.35, 35.65] },
    names: [{ name: "Akrotiri Kavos", language: "en", origin: "osm" }],
  },
];

function transport(bindings: unknown[], seen: HttpRequest[] = []): Transport {
  return async (req) => {
    seen.push(req);
    return makeResponse(200, new TextEncoder().encode(JSON.stringify({ head: { vars: [] }, results: { bindings } })));
  };
}

const allRows = () => Object.values(ITEMS).flat();

/** The pre-existing OSM objects and a full wikidata token bucket, all rolled back with the test. */
async function prepare(db: Db): Promise<Record<string, string>> {
  await db
    .insert(rateLimits)
    .values({ key: "http:wikidata", tokens: 1_000_000, updatedAt: new Date() })
    .onConflictDoUpdate({ target: rateLimits.key, set: { tokens: 1_000_000, updatedAt: new Date() } });
  const ids: Record<string, string> = {};
  for (const draft of OSM_OBJECTS) {
    const r = await upsertGeoObject(db, draft);
    if ("skipped" in r) throw new Error(r.skipped);
    ids[draft.osmId!] = r.id;
  }
  return ids;
}

async function byWikidata(db: Db, id: string) {
  return db
    .select({ id: geoObjects.id, osmId: geoObjects.osmId, type: geoObjects.type, category: geoObjects.category, origin: geoObjects.origin })
    .from(geoObjects)
    .where(and(eq(geoObjects.wikidataId, id), isNull(geoObjects.validTo)));
}

async function names(db: Db, geoObjectId: string) {
  return db
    .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin, isPreferred: geoNames.isPreferred })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, geoObjectId), isNull(geoNames.validTo)));
}

const run = (db: Db, bindings = allRows(), seen?: HttpRequest[]) =>
  importWikidata(db, { scope: scope(), runId: newId() }, { transport: transport(bindings, seen) });

describe("importWikidata", () => {
  it("links via osm wikidata tag", () =>
    withRollback(async (db) => {
      const ids = await prepare(db);
      const seen: HttpRequest[] = [];
      const result = await run(db, ITEMS.island, seen);
      expect(result).toEqual({ linked: 1, created: 0, uncertain: 0, names: 2 });

      const [island] = await byWikidata(db, q(1));
      expect(island).toMatchObject({ id: ids[osm("relation", 1)], osmId: osm("relation", 1), origin: "osm" });
      expect(await names(db, island!.id)).toEqual(
        expect.arrayContaining([
          { name: "Testinsel", language: "de", origin: "wikidata", isPreferred: true },
          { name: "Test Island", language: "en", origin: "wikidata", isPreferred: true },
          { name: "Νήσος Δοκιμή", language: "el", origin: "osm", isPreferred: true },
        ]),
      );

      // Query for the area box plus 5 km, the configured classes and languages.
      expect(seen).toHaveLength(1);
      const sparql = decodeURIComponent(new URL(seen[0]!.url).searchParams.get("query")!);
      expect(sparql).toContain("wd:Q23442");
      expect(sparql).toContain("wd:Q44613");
      expect(sparql).toContain('"hr"');
      const sw = /cornerSouthWest "Point\(([\d.]+) ([\d.]+)\)"/.exec(sparql)!.slice(1).map(Number);
      expect(sw[1]).toBeCloseTo(35.6 - 5 / 111.32, 6);
    }));

  it("links by name within 1 km", () =>
    withRollback(async (db) => {
      const ids = await prepare(db);
      const result = await run(db, ITEMS.bay);
      // The English label equals the OSM name but is its own row (origin wikidata), not preferred.
      expect(result).toEqual({ linked: 1, created: 0, uncertain: 0, names: 2 });
      const [bay] = await byWikidata(db, q(2));
      expect(bay).toMatchObject({ id: ids[osm("node", 2)], type: "bay", origin: "osm" });
      expect(await names(db, bay!.id)).toEqual(
        expect.arrayContaining([
          { name: "Testbucht", language: "de", origin: "wikidata", isPreferred: true },
          { name: "Kalm Bay", language: "en", origin: "osm", isPreferred: true },
          { name: "Kalm Bay", language: "en", origin: "wikidata", isPreferred: false },
        ]),
      );
    }));

  it("creates a monastery poi with category culture", () =>
    withRollback(async (db) => {
      await prepare(db);
      const result = await run(db, ITEMS.monastery);
      expect(result).toMatchObject({ linked: 0, created: 1, uncertain: 0 });
      const [monastery] = await byWikidata(db, q(3));
      expect(monastery).toMatchObject({ type: "poi", category: "culture", origin: "wikidata", osmId: null });
      const rows = await names(db, monastery!.id);
      expect(rows).toEqual(
        expect.arrayContaining([
          { name: "Moni Dokimis", language: "en", origin: "wikidata", isPreferred: true },
          { name: "Test Monastery", language: "en", origin: "wikidata", isPreferred: false },
          { name: "Μονή Δοκιμής", language: "el", origin: "wikidata", isPreferred: true },
          { name: "Moni Dokimis", language: "el", origin: "transliteration", isPreferred: false },
        ]),
      );
      expect(result.names).toBe(rows.length);
    }));

  it("skips a settlement without OSM counterpart", () =>
    withRollback(async (db) => {
      await prepare(db);
      const result = await run(db, ITEMS.settlement);
      expect(result).toEqual({ linked: 0, created: 0, uncertain: 0, names: 0 });
      expect(await byWikidata(db, q(5))).toEqual([]);
    }));

  it("uncertain match opens a pair task", () =>
    withRollback(async (db) => {
      const ids = await prepare(db);
      const result = await run(db, ITEMS.cape);
      expect(result).toMatchObject({ linked: 0, created: 1, uncertain: 1 });
      const [cape] = await byWikidata(db, q(4));
      expect(cape).toMatchObject({ type: "cape", origin: "wikidata", osmId: null });
      const osmCape = ids[osm("node", 4)]!;
      const subjectId = [cape!.id, osmCape].sort().join(":");
      const tasks = await db.select().from(reviewTasks).where(eq(reviewTasks.subjectId, subjectId));
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ kind: "place_candidate", subjectType: "geo_object_pair", status: "open" });
      expect(tasks[0]!.context).toMatchObject({ source: "wikidata", similarity: 1 });
      expect((tasks[0]!.context as { distanceM: number }).distanceM).toBeGreaterThan(1000);
      expect((tasks[0]!.context as { distanceM: number }).distanceM).toBeLessThan(2000);
    }));

  it("same match whose object carries another QID creates a new object and a pair task", () =>
    withRollback(async (db) => {
      const ids = await prepare(db);
      const osmBay = ids[osm("node", 2)]!;
      await db.update(geoObjects).set({ wikidataId: q(7) }).where(eq(geoObjects.id, osmBay));

      const result = await run(db, ITEMS.bay);
      expect(result).toMatchObject({ linked: 0, created: 1, uncertain: 1 });
      const [bay] = await byWikidata(db, q(2));
      expect(bay).toMatchObject({ type: "bay", origin: "wikidata", osmId: null });
      expect(bay!.id).not.toBe(osmBay);
      const [osmRow] = await db.select({ wikidataId: geoObjects.wikidataId }).from(geoObjects).where(eq(geoObjects.id, osmBay));
      expect(osmRow!.wikidataId).toBe(q(7));
      const tasks = await db
        .select()
        .from(reviewTasks)
        .where(eq(reviewTasks.subjectId, [bay!.id, osmBay].sort().join(":")));
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.context).toMatchObject({ source: "wikidata", similarity: 1 });
    }));

  it("an item merged into an object with another QID links to the survivor on the next run", () =>
    withRollback(async (db) => {
      const ids = await prepare(db);
      const osmCape = ids[osm("node", 4)]!;
      await db.update(geoObjects).set({ wikidataId: q(6) }).where(eq(geoObjects.id, osmCape));

      expect(await run(db, ITEMS.cape)).toMatchObject({ created: 1, uncertain: 1 });
      const [cape] = await byWikidata(db, q(4));
      // A reviewer decided "same": the wikidata cape is merged into the OSM cape, which keeps its own QID.
      await mergeGeoObjects(db, osmCape, cape!.id);
      expect(await byWikidata(db, q(4))).toEqual([]);

      const count = async () => ({
        objects: (await db.select({ id: geoObjects.id }).from(geoObjects).where(and(eq(geoObjects.type, "cape"), createdInThisTransaction)))
          .length,
        tasks: (await pairTasksOf(db, await ownGeoObjectIds(db))).length,
      });
      const before = await count();
      const second = await run(db, ITEMS.cape);
      expect(second).toEqual({ linked: 1, created: 0, uncertain: 0, names: 0 });
      expect(await count()).toEqual(before);
      expect(await names(db, osmCape)).toEqual(
        expect.arrayContaining([{ name: "Akrotiri Kavos", language: "en", origin: "wikidata", isPreferred: false }]),
      );
    }));

  it("does not match an object known only from GeoNames", () =>
    withRollback(async (db) => {
      await prepare(db);
      // GeoNames objects come from a later stage; matching them here would link differently on every rerun.
      const created = await upsertGeoObject(db, {
        type: "settlement",
        origin: "geonames",
        geonamesId: String(ID + 5),
        geometry: { type: "Point", coordinates: [26.05, 35.85] },
        names: [{ name: "Testdorf", language: "de", origin: "geonames" }],
      });
      if ("skipped" in created) throw new Error(created.skipped);
      const result = await run(db, ITEMS.settlement);
      expect(result).toEqual({ linked: 0, created: 0, uncertain: 0, names: 0 });
      const [row] = await db.select({ wikidataId: geoObjects.wikidataId }).from(geoObjects).where(eq(geoObjects.id, created.id));
      expect(row!.wikidataId).toBeNull();
      expect(await pairTasksOf(db, await ownGeoObjectIds(db))).toEqual([]);
    }));

  it("links an OSM tag only to an object of a compatible type", () =>
    withRollback(async (db) => {
      await prepare(db);
      // A village node whose wikidata tag names a museum in it.
      const village = await upsertGeoObject(db, {
        type: "settlement",
        origin: "osm",
        osmId: osm("node", 8),
        tags: { place: "village", wikidata: q(8) },
        geometry: { type: "Point", coordinates: [26.25, 35.85] },
        names: [{ name: "Testchori", language: "en", origin: "osm" }],
      });
      if ("skipped" in village) throw new Error(village.skipped);
      // An islet item tagged on an island object: same type group, linked.
      const islet = rows(q(1), "Q207524", 26.1, 35.7, [["Testinsel", "de"]]);
      const museum = rows(q(8), "Q33506", 26.2505, 35.8505, [["Test Museum", "en"]]);

      const result = await run(db, [...islet, ...museum]);
      expect(result).toMatchObject({ linked: 1, created: 1, uncertain: 0 });
      const [poi] = await byWikidata(db, q(8));
      expect(poi).toMatchObject({ type: "poi", category: "culture", origin: "wikidata", osmId: null });
      const [row] = await db.select({ wikidataId: geoObjects.wikidataId }).from(geoObjects).where(eq(geoObjects.id, village.id));
      expect(row!.wikidataId).toBeNull();
      expect(await byWikidata(db, q(1))).toMatchObject([{ osmId: osm("relation", 1), type: "island" }]);
    }));

  it("matches by name only after every ID and tag link, independent of item order", () =>
    withRollback(async (db) => {
      await prepare(db);
      const village = await upsertGeoObject(db, {
        type: "settlement",
        origin: "osm",
        osmId: osm("node", 9),
        tags: { place: "village", wikidata: q(9) },
        geometry: { type: "Point", coordinates: [26.15, 35.65] },
        names: [{ name: "Nisida", language: "en", origin: "osm" }],
      });
      if ("skipped" in village) throw new Error(village.skipped);
      // q(10) comes first but resembles the village only by the label that the tag-linked q(9) brings.
      const items = [
        ...rows(q(10), "Q486972", 26.1505, 35.6505, [["Nisida Troizinas", "en"]]),
        ...rows(q(9), "Q486972", 26.15, 35.65, [["Nisida Troizinias", "en"]]),
      ];
      expect(await run(db, items)).toMatchObject({ linked: 1, created: 1, uncertain: 1 });
      expect(await byWikidata(db, q(9))).toMatchObject([{ id: village.id }]);
      expect(await run(db, items)).toEqual({ linked: 0, created: 0, uncertain: 0, names: 0 });
    }));

  it("second run changes nothing", () =>
    withRollback(async (db) => {
      const ids = await prepare(db);
      const first = await run(db);
      expect(first).toMatchObject({ linked: 2, created: 2, uncertain: 1 });
      const qids = [1, 2, 3, 4, 5].map(q);
      const objects = await db
        .select({ id: geoObjects.id, wikidataId: geoObjects.wikidataId })
        .from(geoObjects)
        .where(or(inArray(geoObjects.wikidataId, qids), inArray(geoObjects.id, Object.values(ids))))
        .orderBy(geoObjects.id);
      const objectIds = objects.map((o) => o.id);
      const historyCount = async (table: "geo_objects_history" | "geo_names_history") => {
        const { rows } = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from ${sql.identifier(table)} where row_id in ${objectIds}`,
        );
        return rows[0]!.n;
      };
      const snapshot = async () => ({
        objects: await db
          .select({ id: geoObjects.id, wikidataId: geoObjects.wikidataId })
          .from(geoObjects)
          .where(or(inArray(geoObjects.wikidataId, qids), inArray(geoObjects.id, Object.values(ids))))
          .orderBy(geoObjects.id),
        objectHistory: await historyCount("geo_objects_history"),
        names: await db
          .select({ id: geoNames.id, validTo: geoNames.validTo, isPreferred: geoNames.isPreferred })
          .from(geoNames)
          .where(inArray(geoNames.geoObjectId, objectIds))
          .orderBy(geoNames.id),
        tasks: await pairTasksOf(db, objectIds),
      });
      const before = await snapshot();
      expect(before.objects.map((o) => o.wikidataId).sort()).toEqual([q(1), q(2), q(3), q(4), null].sort());
      const second = await run(db);
      expect(second).toEqual({ linked: 0, created: 0, uncertain: 0, names: 0 });
      expect(await snapshot()).toEqual(before);
    }));
});
