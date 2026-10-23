import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { berthStates, geoObjects, places, researchHits, serpQueries, serpResults, wikidataSitelinks, type PlaceStatus, type PoiCategory } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { landsideSubjects } from "@/lib/domain/research/landside-queries";
import { RESEARCH_LANDSIDE_SEARCH_STAGE, planLandsideSearch, searchLandside } from "@/lib/pipeline/research/landside-search";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertNamedObject, insertTestRun, insertTestSubdivision, insertTestTile } from "@/test/text";

const SUB_KEY = "GR-XL1";
const TILE = "q025:84:141";

function answer(urls: string[]): Uint8Array {
  const items = urls.map((url, i) => ({ type: "organic", rank_group: i + 1, rank_absolute: i + 1, url, title: `T${i}`, description: `S${i}` }));
  return new TextEncoder().encode(
    JSON.stringify({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.002, result: [{ items }] }] }),
  );
}
function fakeTransport(urls: string[], requests: HttpRequest[] = []): Transport {
  return async (req) => {
    requests.push(req);
    return makeResponse(200, answer(urls));
  };
}
const cfg = () => getConfig().research;

async function base(tx: Db) {
  const sub = await insertTestSubdivision(tx, SUB_KEY, [21.0, 35.0, 21.5, 35.5], { country: "GR" });
  await insertTestTile(tx, TILE, null, sub.id);
  return sub.id;
}

async function seedPlace(tx: Db, subId: string, lon: number, status: PlaceStatus = "confirmed") {
  const obj = await insertNamedObject(tx, { type: "bay", names: [{ name: `Bay${lon}`, language: "en" }], lon, lat: 35.2, subdivisionId: subId });
  const [p] = await tx
    .insert(places)
    .values({ geoObjectId: obj, kind: "anchorage", status, position: geomFromGeoJson({ type: "Point", coordinates: [lon, 35.2] }) })
    .returning({ id: places.id });
  return p!.id;
}

async function poi(tx: Db, subId: string, name: string, category: PoiCategory, lon: number, sitelinks: number | null, extra: { de?: string } = {}) {
  const wikidataId = sitelinks === null ? null : `Q${Math.floor(Math.random() * 1e9)}`;
  const id = await insertNamedObject(tx, {
    type: "poi",
    category,
    names: [{ name, language: "en" }, ...(extra.de ? [{ name: extra.de, language: "de" }] : [])],
    lon,
    lat: 35.21,
    subdivisionId: subId,
  });
  if (wikidataId) {
    await tx.update(geoObjects).set({ wikidataId }).where(eq(geoObjects.id, id));
    await tx.insert(wikidataSitelinks).values({ wikidataId, sitelinks: sitelinks!, fetchedAt: new Date() });
  }
  return id;
}

async function settlement(tx: Db, subId: string, name: string | null, lon: number) {
  return insertNamedObject(tx, { type: "settlement", names: name ? [{ name, language: "en" }] : [], lon, lat: 35.2, subdivisionId: subId });
}

async function state(tx: Db, placeId: string, nearby: Array<{ geoObjectId: string; category: PoiCategory; distanceM: number }>) {
  await tx.insert(berthStates).values({
    placeId,
    core: {},
    gaps: [],
    facts: [],
    landing: [],
    nearby: nearby.map((n) => ({ ...n, access: "foot" as const })),
  });
}

describe("landsideSubjects", () => {
  it("takes the towns and sights with the most sitelinks, at most maxSubjectsPerPlace, plus the nearest settlement", () =>
    withRollback(async (tx) => {
      const sub = await base(tx);
      const placeId = await seedPlace(tx, sub, 21.1);
      const ids: Record<string, string> = {};
      ids.small = await poi(tx, sub, "Smallville", "town", 21.11, 2);
      ids.big = await poi(tx, sub, "Bigtown", "town", 21.12, 90);
      ids.sight = await poi(tx, sub, "Old Fort", "culture", 21.13, 40);
      ids.taverna = await poi(tx, sub, "Fish Taverna", "food", 21.11, 99);
      const near = await settlement(tx, sub, "Nearby Village", 21.101);
      await state(tx, placeId, [
        { geoObjectId: ids.small!, category: "town", distanceM: 800 },
        { geoObjectId: ids.big!, category: "town", distanceM: 3000 },
        { geoObjectId: ids.sight!, category: "culture", distanceM: 2000 },
        { geoObjectId: ids.taverna!, category: "food", distanceM: 100 },
      ]);
      const subjects = await landsideSubjects(tx, placeId, { ...cfg().landside, maxSubjectsPerPlace: 2 });
      expect(subjects.map((s) => s.name)).toEqual(["Bigtown", "Old Fort", "Nearby Village"]);
      expect(subjects.map((s) => s.geoObjectId)).toEqual([ids.big, ids.sight, near]);
      expect(subjects.every((s) => s.lang === "en")).toBe(true);
    }));

  it("names a subject in every template language it has a name in", () =>
    withRollback(async (tx) => {
      const sub = await base(tx);
      const placeId = await seedPlace(tx, sub, 21.1);
      const town = await poi(tx, sub, "Bigtown", "town", 21.12, 9, { de: "Großstadt" });
      await state(tx, placeId, [{ geoObjectId: town, category: "town", distanceM: 900 }]);
      const subjects = await landsideSubjects(tx, placeId, cfg().landside);
      expect(subjects.filter((s) => s.geoObjectId === town).map((s) => [s.lang, s.name]).sort()).toEqual([["de", "Großstadt"], ["en", "Bigtown"]]);
    }));

  it("a place without berth_states.nearby gets only the nearest settlement and no error", () =>
    withRollback(async (tx) => {
      const sub = await base(tx);
      const placeId = await seedPlace(tx, sub, 21.1);
      await settlement(tx, sub, "Far Village", 21.4);
      const near = await settlement(tx, sub, "Near Village", 21.102);
      expect(await landsideSubjects(tx, placeId, cfg().landside)).toEqual([{ name: "Near Village", lang: "en", geoObjectId: near }]);
      await state(tx, placeId, []);
      expect(await landsideSubjects(tx, placeId, cfg().landside)).toHaveLength(1);
    }));

  it("picks the nearest settlement with a name within settlementMaxM, however many unnamed ones are nearer; none beyond the limit", () =>
    withRollback(async (tx) => {
      const sub = await base(tx);
      const placeId = await seedPlace(tx, sub, 21.1);
      // 0.001 deg longitude at 35.2 N is about 91 m
      for (const lon of [21.1005, 21.101, 21.1015, 21.102]) await settlement(tx, sub, null, lon);
      const named = await settlement(tx, sub, "Named Village", 21.11);
      const beyond = await settlement(tx, sub, "Beyond Village", 21.4);
      expect(beyond).toBeTruthy();
      expect(await landsideSubjects(tx, placeId, cfg().landside)).toEqual([{ name: "Named Village", lang: "en", geoObjectId: named }]);
      expect(await landsideSubjects(tx, placeId, { ...cfg().landside, settlementMaxM: 500 })).toEqual([]);
    }));

  it("is empty without nearby and without a settlement", () =>
    withRollback(async (tx) => {
      const sub = await base(tx);
      const placeId = await seedPlace(tx, sub, 21.1);
      expect(await landsideSubjects(tx, placeId, cfg().landside)).toEqual([]);
    }));
});

describe("searchLandside", () => {
  it("queries each subject with the landside templates of its language and stores hits as landside, caps per subject, skips domains", () =>
    withRollback(async (tx) => {
      const sub = await base(tx);
      const placeId = await seedPlace(tx, sub, 21.1);
      await settlement(tx, sub, "Near Village", 21.102);
      const runId = await insertTestRun(tx);
      const requests: HttpRequest[] = [];
      const urls = ["https://a.example/1", "https://www.navily.com/x", ...Array.from({ length: 14 }, (_, i) => `https://b${i}.example/p`)];
      const deps = { transport: fakeTransport(urls, requests), archive: memoryArchive() };
      const r = await searchLandside(tx, placeId, deps, { db: tx, runId });
      // english templates only (the settlement has an English name only)
      expect(r.queries).toBe(cfg().landside.templates.filter((t) => t.lang === "en").length);
      expect(requests).toHaveLength(r.queries);
      const hits = await tx.select().from(researchHits).where(eq(researchHits.placeId, placeId));
      expect(hits.every((h) => h.purpose === "landside")).toBe(true);
      expect(hits).toHaveLength(cfg().landside.maxHitsPerSubject);
      expect(hits.some((h) => h.domain === "navily.com" || h.domain.endsWith("navily.com"))).toBe(false);
      expect(r.hits).toBe(hits.length);
      const before = requests.length;
      const again = await searchLandside(tx, placeId, deps, { db: tx, runId });
      expect(requests.length).toBe(before);
      expect(again.hits).toBe(0);
    }));

  it("two places reaching the same settlement reuse the query and both get the hits", () =>
    withRollback(async (tx) => {
      const sub = await base(tx);
      const a = await seedPlace(tx, sub, 21.1);
      const b = await seedPlace(tx, sub, 21.104);
      await settlement(tx, sub, "Shared Village", 21.102);
      const runId = await insertTestRun(tx);
      const requests: HttpRequest[] = [];
      const deps = { transport: fakeTransport(["https://a.example/1"], requests), archive: memoryArchive() };
      const first = await searchLandside(tx, a, deps, { db: tx, runId });
      const second = await searchLandside(tx, b, deps, { db: tx, runId });
      expect(requests).toHaveLength(first.queries);
      expect(second.queries).toBe(first.queries);
      for (const id of [a, b]) {
        const hits = await tx.select().from(researchHits).where(eq(researchHits.placeId, id));
        expect(hits.map((h) => [h.purpose, h.urlNormalized])).toEqual([["landside", "https://a.example/1"]]);
      }
      expect(await tx.select().from(serpQueries).where(eq(serpQueries.keyword, "Shared Village beach"))).toHaveLength(1);
    }));

  it("the same URL may be a positive hit and a landside hit of one place", () =>
    withRollback(async (tx) => {
      const sub = await base(tx);
      const placeId = await seedPlace(tx, sub, 21.1);
      await settlement(tx, sub, "Near Village", 21.102);
      const runId = await insertTestRun(tx);
      const [row] = await tx.select({ geoObjectId: places.geoObjectId }).from(places).where(eq(places.id, placeId));
      const [q] = await tx
        .insert(serpQueries)
        .values({ keyword: `pos ${newId()}`, languageCode: "en", locationCode: 2826, depth: 20, level: "research", scopeId: placeId, rawKey: `k/${newId()}`, fetchedAt: new Date() })
        .returning({ id: serpQueries.id });
      const [res] = await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url: "https://a.example/1", urlNormalized: "https://a.example/1", domain: "a.example", title: "t", snippet: "s" }).returning({ id: serpResults.id });
      await tx.insert(researchHits).values({ placeId, geoObjectId: row!.geoObjectId, serpQueryId: q!.id, serpResultId: res!.id, urlNormalized: "https://a.example/1", domain: "a.example", rank: 1, purpose: "positive", runId });
      await searchLandside(tx, placeId, { transport: fakeTransport(["https://a.example/1"]), archive: memoryArchive() }, { db: tx, runId });
      const hits = await tx.select().from(researchHits).where(eq(researchHits.placeId, placeId));
      expect(hits.map((h) => h.purpose).sort()).toEqual(["landside", "positive"]);
    }));

  it("a place without any subject yields queries 0, hits 0", () =>
    withRollback(async (tx) => {
      const sub = await base(tx);
      const placeId = await seedPlace(tx, sub, 21.1);
      const requests: HttpRequest[] = [];
      const r = await searchLandside(tx, placeId, { transport: fakeTransport([], requests), archive: memoryArchive() }, { db: tx, runId: await insertTestRun(tx) });
      expect(r).toEqual({ queries: 0, hits: 0 });
      expect(requests).toHaveLength(0);
    }));
});

describe("planLandsideSearch", () => {
  it("one job per confirmed place of the run params; candidates and merged places are left out", () =>
    withRollback(async (tx) => {
      expect(RESEARCH_LANDSIDE_SEARCH_STAGE).toBe("research.landside_search");
      const sub = await base(tx);
      const conf = await seedPlace(tx, sub, 21.1, "confirmed");
      const cand = await seedPlace(tx, sub, 21.2, "candidate");
      const merged = await seedPlace(tx, sub, 21.3, "confirmed");
      await tx.update(places).set({ mergedIntoId: conf }).where(eq(places.id, merged));
      const bySub = await planLandsideSearch(tx, { id: newId(), params: { subdivisionKey: SUB_KEY } });
      expect(bySub).toEqual([{ key: conf, placeId: conf }]);
      expect(await planLandsideSearch(tx, { id: newId(), params: { placeIds: [conf, cand, merged] } })).toEqual(bySub);
    }));
});
