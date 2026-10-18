import { and, eq, inArray, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import type { AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoNames, geoObjects, rateLimits, reviewTasks } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { upsertGeoObject, type GeoObjectDraft } from "@/lib/domain/gazetteer/store";
import { importWikidata } from "@/lib/pipeline/gazetteer/wikidata";
import { withRollback } from "@/test/db";

// Synthetic area outside the pilot box 23.0-23.75 E x 37.0-38.0 N.
function area(): AreaConfig {
  return {
    key: "wikidata-test",
    names: { de: "Testrevier", en: "Test area" },
    polygon: { type: "Polygon", coordinates: [[[26.0, 35.6], [26.4, 35.6], [26.4, 35.9], [26.0, 35.9], [26.0, 35.6]]] },
    tileBbox: null,
    sourceLanguages: ["de", "en", "el"],
    season: { fromMonth: 4, toMonth: 10 },
    cycleDays: 30,
    coastSections: [],
  };
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
  importWikidata(db, { area: area(), runId: newId() }, { transport: transport(bindings, seen) });

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

  it("second run changes nothing", () =>
    withRollback(async (db) => {
      const ids = await prepare(db);
      const first = await run(db);
      expect(first).toMatchObject({ linked: 2, created: 2, uncertain: 1 });
      const snapshot = async () => ({
        objects: await db
          .select({ id: geoObjects.id, wikidataId: geoObjects.wikidataId, updatedAt: geoObjects.updatedAt })
          .from(geoObjects)
          .where(inArray(geoObjects.wikidataId, [1, 2, 3, 4, 5].map(q))),
        names: await db.select({ id: geoNames.id }).from(geoNames).where(inArray(geoNames.geoObjectId, Object.values(ids))),
        tasks: await db.select({ id: reviewTasks.id }).from(reviewTasks).where(eq(reviewTasks.kind, "place_candidate")),
      });
      const before = await snapshot();
      const second = await run(db);
      expect(second).toEqual({ linked: 0, created: 0, uncertain: 0, names: 0 });
      expect(await snapshot()).toEqual(before);
    }));
});
