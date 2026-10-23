import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { externalCalls, placeWebsites, places, researchHits, serpQueries, serpResults, type PlaceStatus } from "@/lib/db/schema";
import { researchCandidates } from "@/lib/domain/research/candidates";
import { newId } from "@/lib/domain/ids";
import { getConfig } from "@/lib/config";
import { recordHits, recordWebsiteHit } from "@/lib/domain/research/hits";
import { planResearchSearch, searchCandidate } from "@/lib/pipeline/research/search";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertNamedObject, insertTestRun, insertTestSubdivision, insertTestTile } from "@/test/text";

const SUB_KEY = "GR-XR1";
const TILE = "q025:84:140";

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

async function seed(tx: Db, name: string | null, status: PlaceStatus = "candidate", opts: { merged?: boolean } = {}) {
  const sub = await insertTestSubdivision(tx, SUB_KEY, [21.0, 35.0, 21.5, 35.5], { country: "GR" });
  await insertTestTile(tx, TILE, null, sub.id);
  const island = await insertNamedObject(tx, { type: "island", names: [{ name: "Methana", language: "en" }], lon: 21.1, lat: 35.2, subdivisionId: sub.id });
  const objectId = name
    ? await insertNamedObject(tx, { type: "bay", names: [{ name, language: "en" }, { name: "Βαθύ", language: "el" }], lon: 21.12, lat: 35.21, parentId: island, subdivisionId: sub.id })
    : await insertNamedObject(tx, { type: "bay", names: [], lon: 21.13, lat: 35.22, parentId: island, subdivisionId: sub.id });
  const [place] = await tx
    .insert(places)
    .values({ geoObjectId: objectId, kind: "anchorage", status, position: geomFromGeoJson({ type: "Point", coordinates: [21.12, 35.21] }) })
    .returning({ id: places.id });
  if (opts.merged) {
    const [other] = await tx.insert(places).values({ geoObjectId: (await insertNamedObject(tx, { type: "bay", names: [], lon: 21.2, lat: 35.3 })), kind: "anchorage", position: geomFromGeoJson({ type: "Point", coordinates: [21.2, 35.3] }) }).returning({ id: places.id });
    await tx.update(places).set({ mergedIntoId: other!.id }).where(eq(places.id, place!.id));
  }
  return { placeId: place!.id, objectId, subdivisionId: sub.id };
}

describe("searchCandidate", () => {
  it("stores research queries and one hit; navily is skipped; a second call within reuseDays searches nothing", () =>
    withRollback(async (tx) => {
      const { placeId } = await seed(tx, "Vathi");
      const runId = await insertTestRun(tx);
      const requests: HttpRequest[] = [];
      const deps = { transport: fakeTransport(["https://sailblog.example/vathi", "https://www.navily.com/x"], requests), archive: memoryArchive() };
      const first = await searchCandidate(tx, placeId, deps, { db: tx, runId });
      expect(first.queries).toBeGreaterThan(0);
      expect(requests.length).toBe(first.queries);
      const qs = await tx.select().from(serpQueries).where(eq(serpQueries.level, "research"));
      expect(qs.filter((q) => q.scopeId === placeId).length).toBe(first.queries);
      const hits = await tx.select().from(researchHits).where(eq(researchHits.placeId, placeId));
      // the same URL for every positive query and for the negative ones: one row per purpose
      expect(hits.filter((h) => h.purpose === "positive")).toHaveLength(1);
      expect(hits.every((h) => h.domain === "sailblog.example")).toBe(true);
      expect(first.hits).toBe(hits.length);

      const before = requests.length;
      const second = await searchCandidate(tx, placeId, deps, { db: tx, runId });
      expect(requests.length).toBe(before);
      expect(second.hits).toBe(0);
      expect(await tx.select().from(researchHits).where(eq(researchHits.placeId, placeId))).toHaveLength(hits.length);
    }));

  it("books the cost of a research query on the candidate's tile", () =>
    withRollback(async (tx) => {
      const { placeId } = await seed(tx, "Vathi");
      const [{ tileId }] = (await tx.select({ tileId: places.tileId }).from(places).where(eq(places.id, placeId))) as [{ tileId: string | null }];
      expect(tileId).toBeTruthy();
      const runId = await insertTestRun(tx);
      const first = await searchCandidate(tx, placeId, { transport: fakeTransport(["https://sailblog.example/vathi"]), archive: memoryArchive() }, { db: tx, runId });
      const calls = await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId));
      expect(first.queries).toBeGreaterThan(0);
      expect(calls).toHaveLength(first.queries);
      expect(calls.map((c) => c.tileId)).toEqual(calls.map(() => tileId));
    }));

  it("a candidate without names yields queries 0, hits 0", () =>
    withRollback(async (tx) => {
      const { placeId } = await seed(tx, null);
      const runId = await insertTestRun(tx);
      const requests: HttpRequest[] = [];
      const r = await searchCandidate(tx, placeId, { transport: fakeTransport([], requests), archive: memoryArchive() }, { db: tx, runId });
      expect(r).toEqual({ queries: 0, hits: 0 });
      expect(requests).toHaveLength(0);
    }));
});

async function website(tx: Db, placeId: string, geoObjectId: string, url: string, o: { bound?: boolean; createdAt?: Date } = {}) {
  await tx.insert(placeWebsites).values({ placeId, geoObjectId, url, urlNormalized: url, origin: "osm", bound: o.bound ?? true, ...(o.createdAt ? { createdAt: o.createdAt } : {}) });
}

describe("searchCandidate: bound marina website (N3b)", () => {
  it("records the newest website as a positive rank-0 hit of origin place_website when it is bound, without a serp query", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx, "Vathi");
      await website(tx, placeId, objectId, "https://old-marina.example/", { createdAt: new Date("2024-01-01") });
      await website(tx, placeId, objectId, "https://marina.example/", { createdAt: new Date("2025-01-01") });
      const runId = await insertTestRun(tx);
      const deps = { transport: fakeTransport(["https://sailblog.example/vathi"]), archive: memoryArchive() };
      await searchCandidate(tx, placeId, deps, { db: tx, runId });
      const own = (await tx.select().from(researchHits).where(eq(researchHits.placeId, placeId))).filter((h) => h.origin === "place_website");
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({ urlNormalized: "https://marina.example/", purpose: "positive", rank: 0, serpQueryId: null, serpResultId: null, domain: "marina.example" });
      await searchCandidate(tx, placeId, deps, { db: tx, runId });
      expect((await tx.select().from(researchHits).where(eq(researchHits.placeId, placeId))).filter((h) => h.origin === "place_website")).toHaveLength(1);
    }));

  it("does not count against maxHitsPerCandidate", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx, "Vathi");
      await website(tx, placeId, objectId, "https://marina.example/");
      const runId = await insertTestRun(tx);
      const [q] = await tx
        .insert(serpQueries)
        .values({ keyword: `cap ${newId()}`, languageCode: "en", locationCode: 2826, depth: 20, level: "research", scopeId: placeId, rawKey: `k/${newId()}`, fetchedAt: new Date() })
        .returning({ id: serpQueries.id });
      await tx.insert(serpResults).values([1, 2].map((rank) => ({ serpQueryId: q!.id, rank, url: `https://s${rank}.example/p`, urlNormalized: `https://s${rank}.example/p`, domain: `s${rank}.example`, title: "t", snippet: "s" })));
      const cfg = { ...getConfig().research, maxHitsPerCandidate: 2 };
      expect(await recordWebsiteHit(tx, { placeId, geoObjectId: objectId, runId })).toBe(1);
      expect(await recordHits(tx, { placeId, geoObjectId: objectId, serpQueryIds: [q!.id], purpose: "positive", runId }, cfg)).toBe(2);
    }));

  it("records nothing when the newest website row is unbound, even if an older one was bound", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx, "Vathi");
      await website(tx, placeId, objectId, "https://marina.example/", { createdAt: new Date("2025-01-01") });
      await website(tx, placeId, objectId, "https://marina.example/", { bound: false, createdAt: new Date("2026-01-01") });
      expect(await recordWebsiteHit(tx, { placeId, geoObjectId: objectId, runId: await insertTestRun(tx) })).toBe(0);
      expect(await tx.select().from(researchHits).where(eq(researchHits.placeId, placeId))).toHaveLength(0);
    }));

  it("upgrades a search hit on the same URL to origin place_website", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx, "Vathi");
      await website(tx, placeId, objectId, "https://marina.example/");
      const runId = await insertTestRun(tx);
      await searchCandidate(tx, placeId, { transport: fakeTransport(["https://marina.example/"]), archive: memoryArchive() }, { db: tx, runId });
      const pos = (await tx.select().from(researchHits).where(eq(researchHits.placeId, placeId))).filter((h) => h.purpose === "positive" && h.urlNormalized === "https://marina.example/");
      expect(pos).toHaveLength(1);
      expect(pos[0]!.origin).toBe("place_website");
    }));

  it("records nothing for a place without a bound website", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx, "Vathi");
      await website(tx, placeId, objectId, "https://unbound.example/", { bound: false });
      const runId = await insertTestRun(tx);
      await searchCandidate(tx, placeId, { transport: fakeTransport([]), archive: memoryArchive() }, { db: tx, runId });
      expect((await tx.select().from(researchHits).where(eq(researchHits.placeId, placeId))).filter((h) => h.origin === "place_website")).toHaveLength(0);
    }));
});

describe("researchCandidates", () => {
  it("returns candidate and confirmed places, not rejected, no_anchoring or merged ones", () =>
    withRollback(async (tx) => {
      const a = await seed(tx, "Aaa", "candidate");
      const mk = async (status: PlaceStatus, lon: number) => {
        const o = await insertNamedObject(tx, { type: "bay", names: [{ name: `N${status}`, language: "en" }], lon, lat: 35.3, subdivisionId: a.subdivisionId });
        const [p] = await tx.insert(places).values({ geoObjectId: o, kind: "anchorage", status, position: geomFromGeoJson({ type: "Point", coordinates: [lon, 35.3] }) }).returning({ id: places.id });
        return p!.id;
      };
      const confirmed = await mk("confirmed", 21.31);
      await mk("rejected", 21.32);
      await mk("no_anchoring", 21.33);
      const merged = await mk("candidate", 21.34);
      await tx.update(places).set({ mergedIntoId: a.placeId }).where(eq(places.id, merged));
      const ids = await researchCandidates(tx, { subdivisionKey: SUB_KEY });
      expect(ids).toEqual([a.placeId, confirmed].sort());
      expect(await researchCandidates(tx, { placeIds: [confirmed, merged, newId()] })).toEqual([confirmed]);
    }));

  it("plan: one job per candidate, keyed by place id", () =>
    withRollback(async (tx) => {
      const a = await seed(tx, "Aaa");
      const jobs = await planResearchSearch(tx, { id: newId(), params: { subdivisionKey: SUB_KEY } });
      expect(jobs).toEqual([{ key: a.placeId, placeId: a.placeId }]);
      const byIds = await planResearchSearch(tx, { id: newId(), params: { placeIds: [a.placeId] } });
      expect(byIds).toEqual(jobs);
    }));
});

describe("recordHits cap", () => {
  it("keeps the best ranks across all queries, not the first query's ranks", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx, "Vathi");
      const runId = await insertTestRun(tx);
      const ids: string[] = [];
      for (const q of ["A", "B"]) {
        const [row] = await tx
          .insert(serpQueries)
          .values({ keyword: `cap ${q} ${newId()}`, languageCode: "en", locationCode: 2826, depth: 20, level: "research", scopeId: placeId, rawKey: `k/${newId()}`, fetchedAt: new Date() })
          .returning({ id: serpQueries.id });
        ids.push(row!.id);
        await tx.insert(serpResults).values(
          [1, 2, 3, 4, 5].map((rank) => ({
            serpQueryId: row!.id,
            rank,
            url: `https://${q.toLowerCase()}${rank}.example/p`,
            urlNormalized: `https://${q.toLowerCase()}${rank}.example/p`,
            domain: `${q.toLowerCase()}${rank}.example`,
            title: "t",
            snippet: "s",
          })),
        );
      }
      const cfg = { ...getConfig().research, maxHitsPerCandidate: 3 };
      const input = { placeId, geoObjectId: objectId, serpQueryIds: ids, purpose: "positive" as const, runId };
      expect(await recordHits(tx, input, cfg)).toBe(3);
      const hits = await tx.select().from(researchHits).where(eq(researchHits.placeId, placeId));
      expect(hits.map((h) => h.urlNormalized).sort()).toEqual(["https://a1.example/p", "https://a2.example/p", "https://b1.example/p"]);
      expect(await recordHits(tx, input, cfg)).toBe(0);
    }));
});
