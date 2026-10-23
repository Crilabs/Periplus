import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import type { OverpassElement } from "@/lib/adapters/overpass";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places, rateLimits, tileGeoObjects, wikidataSitelinks, type PlaceStatus } from "@/lib/db/schema";
import { gazetteerScope } from "@/lib/domain/gazetteer/scope";
import { newId } from "@/lib/domain/ids";
import { reachable } from "@/lib/domain/research/reach";
import { tileIdFor } from "@/lib/domain/tiles";
import { importLandThings, ringCenters } from "@/lib/pipeline/gazetteer/land";
import { withRollback } from "@/test/db";
import { testArchive } from "@/test/s3";
import { insertNamedObject, insertTestSubdivision, insertTestTile } from "@/test/text";

/*
 * Stage `gazetteer.land` (N7 4.4, 4.6): things on land in two rings around the research candidates of a subdivision,
 * against a fake Overpass, WDQS and Wikibase API. Synthetic subdivisions at 29-30.5 E x 32-32.25 N, outside the pilot
 * box and the other synthetic test areas. Candidate A at 29.1 E / 32.1 N carries most fixtures; B at 29.48 E and D (in
 * the neighbour subdivision) at 29.52 E share a taverna on the border; C is `no_anchoring`.
 */

const KEY = "XL-LAND";
const NEIGHBOUR = "XL-LAND2";
const EMPTY = "XL-LAND3";
const BOX: [number, number, number, number] = [29.0, 32.0, 29.5, 32.25];
const NEIGHBOUR_BOX: [number, number, number, number] = [29.5, 32.0, 30.0, 32.25];
const EMPTY_BOX: [number, number, number, number] = [30.0, 32.0, 30.5, 32.25];
const TILE = tileIdFor(29.1, 32.1);

const A = { lon: 29.1, lat: 32.1 };
const M_PER_DEG = 111_195;
const at = (dEastM: number, dNorthM: number, from = A) => ({
  lon: from.lon + dEastM / (M_PER_DEG * Math.cos((from.lat * Math.PI) / 180)),
  lat: from.lat + dNorthM / M_PER_DEG,
});

const ID = 9_130_000_000;
const osmId = (n: number) => `node/${ID + n}`;
const qid = (n: number) => `Q${ID + n}`;
const node = (n: number, p: { lon: number; lat: number }, tags: Record<string, string>): OverpassElement => ({ type: "node", id: ID + n, lat: p.lat, lon: p.lon, tags });

const N = {
  taverna: 1, // 1 km north of A, named
  tavernaFar: 2, // 5 km north: outside the near ring
  busStop: 3, // 500 m south, unnamed
  harbourPier: 4, // 300 m east, a pier with harbour=yes
  cafeAtC: 5, // next to the no_anchoring place C
  sharedTaverna: 6, // between B and D
  castle: 11, // 10 km south, Q…11, 12 sitelinks
  tower: 12, // 10 km south, Q…12, 2 sitelinks
  fort: 13, // 10 km south, no wikidata tag
  famousTaverna: 14, // 10 km north, with wikidata: food is not a far category
} as const;
const MONASTERY = 21; // a Wikidata item 8 km south, 3 km west, 25 sitelinks
const SITELINKS: Record<string, number> = { [qid(N.castle)]: 12, [qid(N.tower)]: 2, [qid(N.famousTaverna)]: 30, [qid(MONASTERY)]: 25 };

const C = { lon: 29.25, lat: 32.2 };
const B = { lon: 29.48, lat: 32.1 };
const D = { lon: 29.52, lat: 32.1 };

const NEAR: OverpassElement[] = [
  node(N.taverna, at(0, 1000), { amenity: "restaurant", name: "Taverna Kima" }),
  node(N.tavernaFar, at(0, 5000), { amenity: "restaurant", name: "Taverna Makria" }),
  node(N.busStop, at(0, -500), { highway: "bus_stop" }),
  node(N.harbourPier, at(300, 0), { man_made: "pier", harbour: "yes", name: "Molos" }),
  node(N.cafeAtC, at(500, 0, C), { amenity: "cafe", name: "Kafeneio" }),
  node(N.sharedTaverna, { lon: 29.5, lat: 32.1 }, { amenity: "restaurant", name: "Taverna Synoro" }),
];
const FAR: OverpassElement[] = [
  node(N.castle, at(0, -10_000), { historic: "castle", name: "Kastro", wikidata: qid(N.castle) }),
  node(N.tower, at(1000, -10_000), { historic: "tower", name: "Pyrgos", wikidata: qid(N.tower) }),
  node(N.fort, at(-2000, -10_000), { historic: "fort", name: "Frourio" }),
  node(N.famousTaverna, at(0, 10_000), { amenity: "restaurant", name: "Taverna Diasimi", wikidata: qid(N.famousTaverna) }),
];
const MONASTERY_AT = at(-3000, -8000);
const WDQS_BINDINGS = [
  {
    item: { type: "uri", value: `http://www.wikidata.org/entity/${qid(MONASTERY)}` },
    class: { type: "uri", value: "http://www.wikidata.org/entity/Q44613" },
    coord: { type: "literal", value: `Point(${MONASTERY_AT.lon} ${MONASTERY_AT.lat})` },
    name: { type: "literal", value: "Moni Agiou", "xml:lang": "en" },
    lang: { type: "literal", value: "en" },
    isAlias: { type: "literal", value: "false" },
  },
];
const ALL_OSM = [...NEAR, ...FAR].map((e) => `node/${e.id}`);

type Seen = { overpass: string[]; wdqs: string[]; entities: string[] };

/** Overpass (near query without, far query with the `wikidata` filter), WDQS and `wbgetentities`. */
function transport(seen: Seen = { overpass: [], wdqs: [], entities: [] }): Transport {
  const cfg = getConfig().gazetteer;
  const json = (v: unknown) => makeResponse(200, new TextEncoder().encode(JSON.stringify(v)));
  return async (req: HttpRequest) => {
    if (req.url === cfg.overpass.endpoint) {
      const ql = decodeURIComponent(String(req.body).replace(/^data=/, ""));
      seen.overpass.push(ql);
      return json({ elements: ql.includes('["wikidata"]') ? FAR : NEAR });
    }
    if (req.url.startsWith(cfg.wikidata.endpoint)) {
      seen.wdqs.push(decodeURIComponent(req.url));
      return json({ head: { vars: [] }, results: { bindings: WDQS_BINDINGS } });
    }
    if (req.url.startsWith(cfg.wikidata.apiEndpoint)) {
      const ids = /ids=([^&]+)/.exec(req.url)![1]!.split("|");
      seen.entities.push(...ids);
      const entities = Object.fromEntries(
        ids.map((id) => [id, { id, sitelinks: Object.fromEntries(Array.from({ length: SITELINKS[id] ?? 0 }, (_, i) => [`w${i}wiki`, { site: `w${i}wiki`, title: "T" }])) }]),
      );
      return json({ entities });
    }
    throw new Error(`unexpected request ${req.url}`);
  };
}

/**
 * Full Overpass and Wikidata token buckets (capped at their burst, 2 for Overpass: one near and one far query), rolled
 * back with the test; refilled before every run, so a second run does not wait for a token.
 */
async function fullBuckets(db: Db): Promise<void> {
  for (const key of ["http:overpass", "http:wikidata"]) {
    await db
      .insert(rateLimits)
      .values({ key, tokens: 1_000_000, updatedAt: new Date() })
      .onConflictDoUpdate({ target: rateLimits.key, set: { tokens: 1_000_000, updatedAt: new Date() } });
  }
}

async function place(db: Db, subdivisionId: string, p: { lon: number; lat: number }, name: string, status: PlaceStatus): Promise<string> {
  const objectId = await insertNamedObject(db, { type: "bay", names: [{ name }], lon: p.lon, lat: p.lat, subdivisionId });
  const [row] = await db
    .insert(places)
    .values({ geoObjectId: objectId, kind: "anchorage", status, position: geomFromGeoJson({ type: "Point", coordinates: [p.lon, p.lat] }) })
    .returning({ id: places.id });
  return row!.id;
}

type Fixture = { subId: string; neighbourId: string; a: string; b: string; c: string; d: string };

async function prepare(db: Db): Promise<Fixture> {
  const sub = await insertTestSubdivision(db, KEY, BOX);
  const neighbour = await insertTestSubdivision(db, NEIGHBOUR, NEIGHBOUR_BOX);
  await insertTestSubdivision(db, EMPTY, EMPTY_BOX);
  await insertTestTile(db, TILE);
  return {
    subId: sub.id,
    neighbourId: neighbour.id,
    a: await place(db, sub.id, A, "Ormos Alfa", "candidate"),
    b: await place(db, sub.id, B, "Ormos Vita", "confirmed"),
    c: await place(db, sub.id, C, "Ormos Gamma", "no_anchoring"),
    d: await place(db, neighbour.id, D, "Ormos Delta", "candidate"),
  };
}

const NOW = new Date("2026-10-24T10:00:00Z");
const archive = testArchive();
beforeAll(() => archive.ensureBucket());

async function run(db: Db, key: string, seen?: Seen, placeIds?: string[]) {
  await fullBuckets(db);
  return importLandThings(db, { scope: await gazetteerScope(db, key), runId: newId(), now: NOW, ...(placeIds ? { placeIds } : {}) }, { transport: transport(seen), archive, sleep: async () => {} });
}

async function stored(db: Db) {
  const rows = await db
    .select({ id: geoObjects.id, osmId: geoObjects.osmId, wikidataId: geoObjects.wikidataId, type: geoObjects.type, category: geoObjects.category, subdivisionId: geoObjects.subdivisionId })
    .from(geoObjects)
    .where(and(isNull(geoObjects.validTo), or(inArray(geoObjects.osmId, ALL_OSM), eq(geoObjects.wikidataId, qid(MONASTERY)))));
  return rows;
}

describe("ringCenters", () => {
  it("the research candidates (candidate, confirmed) of the subdivision; no_anchoring makes no center", () =>
    withRollback(async (db) => {
      const f = await prepare(db);
      const centers = await ringCenters(db, { subdivisionKey: KEY });
      expect(centers.map((c) => c.placeId).sort()).toEqual([f.a, f.b].sort());
      expect(centers.find((c) => c.placeId === f.a)).toMatchObject({ lon: expect.closeTo(A.lon, 6), lat: expect.closeTo(A.lat, 6) });
      expect(await ringCenters(db, { placeIds: [f.c, f.d] })).toEqual([{ placeId: f.d, lon: expect.closeTo(D.lon, 6), lat: expect.closeTo(D.lat, 6) }]);
    }));

  it("the anchor position wins over the place position", () =>
    withRollback(async (db) => {
      const f = await prepare(db);
      await db.update(places).set({ anchorPosition: geomFromGeoJson({ type: "Point", coordinates: [29.11, 32.11] }) }).where(eq(places.id, f.a));
      const [center] = await ringCenters(db, { placeIds: [f.a] });
      expect(center).toMatchObject({ lon: expect.closeTo(29.11, 6), lat: expect.closeTo(32.11, 6) });
    }));
});

describe("importLandThings", () => {
  it("near ring: named and unnamed things within 2.4 km; far ring: sights with Wikidata and enough sitelinks", () =>
    withRollback(async (db) => {
      const f = await prepare(db);
      const seen: Seen = { overpass: [], wdqs: [], entities: [] };
      const result = await run(db, KEY, seen);
      expect(result).toEqual({ boxes: 1, near: 3, far: 2, created: 5, outsideRing: 4, belowSitelinks: 1, wrongType: 1 });

      const rows = await stored(db);
      const byOsm = new Map(rows.map((r) => [r.osmId, r]));
      expect([...byOsm.keys()].filter(Boolean).sort()).toEqual([osmId(N.taverna), osmId(N.busStop), osmId(N.sharedTaverna), osmId(N.castle)].sort());
      expect(byOsm.get(osmId(N.busStop))).toMatchObject({ type: "poi", category: "transport" });
      // the castle is linked to its Wikidata item by its tag, so N4a finds its sitelinks
      expect(byOsm.get(osmId(N.castle))).toMatchObject({ type: "poi", category: "culture", wikidataId: qid(N.castle) });
      expect(rows.find((r) => r.wikidataId === qid(MONASTERY))).toMatchObject({ type: "poi", category: "culture", osmId: null });
      // a pier with harbour=yes is not created as a harbour
      expect(byOsm.has(osmId(N.harbourPier))).toBe(false);

      const links = await db.select().from(wikidataSitelinks).where(inArray(wikidataSitelinks.wikidataId, Object.keys(SITELINKS)));
      expect(Object.fromEntries(links.map((l) => [l.wikidataId, l.sitelinks]))).toMatchObject({ [qid(N.castle)]: 12, [qid(N.tower)]: 2, [qid(MONASTERY)]: 25 });

      // one near and one far Overpass query for the one box, the far one only with a wikidata tag and the far categories
      expect(seen.overpass).toHaveLength(2);
      const far = seen.overpass.find((q) => q.includes('["wikidata"]'))!;
      expect(far).toContain('"historic"');
      expect(far).not.toContain("restaurant");
      expect(seen.wdqs).toHaveLength(1);
      expect(seen.wdqs[0]).toContain("wikibase:sitelinks");
      expect(seen.wdqs[0]).toMatch(/>= 5/);
      expect(await archive.exists(`datasets/overpass/land/${KEY}/2026-10-24-near-0.json`)).toBe(true);
      expect(await archive.exists(`datasets/overpass/land/${KEY}/2026-10-24-far-0.json`)).toBe(true);

      // assigned at the end: subdivision and tile links
      const taverna = byOsm.get(osmId(N.taverna))!;
      expect(taverna.subdivisionId).toBe(f.subId);
      const tileLinks = await db.select().from(tileGeoObjects).where(eq(tileGeoObjects.geoObjectId, taverna.id));
      expect(tileLinks.map((l) => l.tileId)).toEqual([TILE]);
    }));

  it("N4a finds the taverna on foot and the castle by bus (bus stop on foot)", () =>
    withRollback(async (db) => {
      await prepare(db);
      await run(db, KEY);
      const rows = await stored(db);
      const id = (n: number) => rows.find((r) => r.osmId === osmId(n))!.id;
      const monastery = rows.find((r) => r.wikidataId === qid(MONASTERY))!.id;
      const out = await reachable(db, [{ kind: "pier", lon: A.lon, lat: A.lat, geoObjectId: null, description: null }], getConfig(), { transportFact: false, factSubjects: [] });
      expect(out.map((n) => [n.geoObjectId, n.access])).toEqual([
        [id(N.busStop), "foot"],
        [id(N.taverna), "foot"],
        [monastery, "transport"],
        [id(N.castle), "transport"],
      ]);
    }));

  it("a second call creates nothing and fetches no sitelinks again", () =>
    withRollback(async (db) => {
      await prepare(db);
      await run(db, KEY);
      const before = (await stored(db)).length;
      const seen: Seen = { overpass: [], wdqs: [], entities: [] };
      const again = await run(db, KEY, seen);
      expect(again.created).toBe(0);
      expect(await stored(db)).toHaveLength(before);
      expect(seen.entities).toEqual([]);
    }));

  it("the neighbour subdivision does not create the shared taverna again", () =>
    withRollback(async (db) => {
      await prepare(db);
      await run(db, KEY);
      const result = await run(db, NEIGHBOUR);
      expect(result).toMatchObject({ boxes: 1, near: 1, created: 0 });
      const shared = await db.select({ id: geoObjects.id }).from(geoObjects).where(and(eq(geoObjects.osmId, osmId(N.sharedTaverna)), isNull(geoObjects.validTo)));
      expect(shared).toHaveLength(1);
    }));

  it("single candidates: only their rings", () =>
    withRollback(async (db) => {
      const f = await prepare(db);
      const result = await run(db, KEY, undefined, [f.b]);
      expect(result).toMatchObject({ boxes: 1, near: 1, far: 0, created: 1 });
      expect((await stored(db)).map((r) => r.osmId)).toEqual([osmId(N.sharedTaverna)]);
    }));

  it("a subdivision without candidates: no boxes, no request", () =>
    withRollback(async (db) => {
      await prepare(db);
      const seen: Seen = { overpass: [], wdqs: [], entities: [] };
      const result = await run(db, EMPTY, seen);
      expect(result).toEqual({ boxes: 0, near: 0, far: 0, created: 0, outsideRing: 0, belowSitelinks: 0, wrongType: 0 });
      expect(seen).toEqual({ overpass: [], wdqs: [], entities: [] });
    }));
});
