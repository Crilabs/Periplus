import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeResponse, type Transport } from "@/lib/adapters/http";
import { getConfig, getConsolidationConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { externalCalls, geoNames, placeDiscoveryRequests, places, serpQueries, serpResults, sources } from "@/lib/db/schema";
import { thinPlaces } from "@/lib/domain/consolidation/followup";
import { placeQueries } from "@/lib/domain/discovery/queries";
import { newId } from "@/lib/domain/ids";
import { candidateTiles } from "@/lib/domain/mentions/scope";
import { tileIdFor } from "@/lib/domain/tiles";
import { DISCOVERY_PLACE_STAGE, planPlaceDiscovery } from "@/lib/pipeline/discovery";
import { runQueries } from "@/lib/domain/search/run-queries";
import { sql } from "drizzle-orm";
import { freezeTextRunParams } from "@/lib/pipeline/text/versions";
import { insertMention, insertPlace, insertSource } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertTestRun, insertTestSubdivision, insertTestTile, insertTestVersion } from "@/test/text";

/** The transport and archive the `discovery.place` handler gets (no network: the recorded DataForSEO answer). */
const adapters = vi.hoisted(() => ({ transport: undefined as unknown, archive: undefined as unknown }));
vi.mock("@/lib/adapters/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters/http")>()),
  getTransport: () => adapters.transport,
}));
vi.mock("@/lib/adapters/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/adapters/s3")>()),
  getArchive: () => adapters.archive,
}));

/*
 * Follow-up of a consolidation (plan Task 15): thin places, their queries and the place discovery run, in withRollback
 * at a spot outside the pilot box no other test uses (20.13° E / 34.13° N); assertions only on the test's own rows.
 */

const LON = 20.13;
const LAT = 34.13;
const TILE = tileIdFor(LON, LAT);
// Fixture rows are valid from the test database's current_date (UTC) and requests are stamped with now(), so the
// test runs on the database's date, read once before the tests (not the JS clock at import, OPS-5).
let TODAY = "";
let NOW = new Date(0);
beforeAll(async () => {
  const { rows } = await testDb().execute<{ today: string }>(sql`select current_date::text as today`);
  TODAY = rows[0]!.today;
  NOW = new Date(`${TODAY}T12:00:00Z`);
});
const DAY_MS = 86_400_000;
const followup = () => getConsolidationConfig().followup;

/** A Greek subdivision (source languages el, de, en) and the test tile labelled with it. */
async function areaTile(tx: Db): Promise<string> {
  const sub = await insertTestSubdivision(tx, "XT-F1", [20.0, 34.0, 20.5, 34.5]);
  return insertTestTile(tx, TILE, null, sub.id);
}

/** A place in the test tile with a preferred name in each of `languages`. */
async function place(tx: Db, name: string, o: { languages?: string[]; status?: "candidate" | "confirmed" | "rejected"; lon?: number } = {}) {
  const p = await insertPlace(tx, { lon: o.lon ?? LON, lat: LAT, name, status: o.status ?? "confirmed" });
  for (const language of o.languages ?? []) {
    await tx.insert(geoNames).values({
      geoObjectId: p.objectId,
      name: `${name}-${language}`,
      nameNormalized: `${name}-${language}`.toLowerCase(),
      language,
      script: "latin",
      origin: "osm",
      isPreferred: true,
    });
  }
  return p;
}

/** `n` documents (each of its own source) mentioning the object. */
async function documents(tx: Db, objectId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await insertMention(tx, objectId, { sourceId: await insertSource(tx) });
}

const answer = (): Transport => {
  const body = readFileSync("test/fixtures/http/dataforseo/hand/organic-20-paa.json");
  return async () => makeResponse(200, new Uint8Array(body));
};

describe("place queries", () => {
  it("a confirmed place with one document gets tile templates with its names", () =>
    withRollback(async (tx) => {
      await areaTile(tx);
      const { objectId } = await place(tx, `Vathy${newId().slice(0, 8)}`, { languages: ["de", "en", "el"] });
      await documents(tx, objectId, 1);
      expect(await thinPlaces(tx, [objectId], followup(), TODAY)).toEqual([objectId]);

      const queries = await placeQueries(tx, objectId, getConfig().discovery);
      const names = await tx.select({ name: geoNames.name, language: geoNames.language }).from(geoNames).where(and(eq(geoNames.geoObjectId, objectId), eq(geoNames.isPreferred, true)));
      const nameOf = (lang: string) => names.find((n) => n.language === lang)!.name;
      expect(queries).toEqual([
        { keyword: `Ankerplatz ${nameOf("de")}`, languageCode: "de", locationCode: 2276, level: "place", scopeId: objectId, priority: 1, tileId: TILE },
        { keyword: `anchorage ${nameOf("en")}`, languageCode: "en", locationCode: 2826, level: "place", scopeId: objectId, priority: 1, tileId: TILE },
        { keyword: `αγκυροβόλιο ${nameOf("el")}`, languageCode: "el", locationCode: 2300, level: "place", scopeId: objectId, priority: 1, tileId: TILE },
      ]);
    }));

  it("a place in a tile without a subdivision gets no queries", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE, null);
      const { objectId } = await place(tx, "Ohnelandesteil", { languages: ["de", "en"] });
      expect(await placeQueries(tx, objectId, getConfig().discovery)).toEqual([]);
    }));

  it("a place query is booked on the place's tile", () =>
    withRollback(async (tx) => {
      await areaTile(tx);
      const { objectId } = await place(tx, "Kosten", { languages: ["en"] });
      const runId = await insertTestRun(tx);
      const [q] = await placeQueries(tx, objectId, getConfig().discovery);
      const unique = { ...q!, keyword: `${q!.keyword} ${newId()}` };
      await runQueries(tx, [unique], { transport: answer(), archive: memoryArchive() }, { db: tx, runId, stage: DISCOVERY_PLACE_STAGE });
      const calls = await tx.select().from(externalCalls).where(eq(externalCalls.runId, runId));
      expect(calls.map((c) => [c.service, c.tileId, c.stage])).toEqual([["dataforseo", TILE, DISCOVERY_PLACE_STAGE]]);
      const [row] = await tx.select().from(serpQueries).where(eq(serpQueries.runId, runId));
      expect(row).toMatchObject({ level: "place", scopeId: objectId });
    }));

  it("a document of a source found by a place search gets the place's tile as candidate space", () =>
    withRollback(async (tx) => {
      await areaTile(tx);
      const { objectId } = await place(tx, "Fundort", { languages: ["en"] });
      const sourceId = await insertSource(tx);
      const [source] = await tx.select({ domain: sources.domain }).from(sources).where(eq(sources.id, sourceId));
      const [q] = await tx
        .insert(serpQueries)
        .values({ keyword: `anchorage Fundort ${newId()}`, languageCode: "en", locationCode: 2826, depth: 20, level: "place", scopeId: objectId, rawKey: "serp/x.json", fetchedAt: NOW })
        .returning({ id: serpQueries.id });
      await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url: `https://${source!.domain}/`, urlNormalized: `https://${source!.domain}/`, domain: source!.domain, title: "t", snippet: "s" });
      const v = await insertTestVersion(tx, ["Ein Text ohne bekannte Namen."], { sourceId });

      const cfg = getConfig();
      const space = await candidateTiles(tx, v.versionId, cfg.mentions, { nameAffixes: cfg.nameAffixes, subdivisionKeys: [] });
      expect(space.basis).toBe("source");
      expect(space.tiles).toContain(TILE);
      // and a text run of the tile takes the pending version of that source in
      const { documentVersionIds } = await freezeTextRunParams(tx, { tileId: TILE }, cfg);
      expect(documentVersionIds).toContain(v.versionId);
    }));
});

describe("thin places", () => {
  it("a place with two documents or a recent request is not thin", () =>
    withRollback(async (tx) => {
      await areaTile(tx);
      const two = await place(tx, "Zweidok");
      await documents(tx, two.objectId, 2);
      const requested = await place(tx, "Angefragt");
      await tx.insert(placeDiscoveryRequests).values({ geoObjectId: requested.objectId, requestedAt: new Date(NOW.getTime() - 10 * DAY_MS) });
      const longAgo = await place(tx, "Langeher");
      await tx.insert(placeDiscoveryRequests).values({ geoObjectId: longAgo.objectId, requestedAt: new Date(NOW.getTime() - (followup().cooldownDays + 1) * DAY_MS) });
      const rejected = await place(tx, "Verworfen", { status: "rejected" });
      const candidate = await place(tx, "Kandidat", { status: "candidate" });

      const ids = [two.objectId, requested.objectId, longAgo.objectId, rejected.objectId, candidate.objectId];
      expect((await thinPlaces(tx, ids, followup(), TODAY)).sort()).toEqual([longAgo.objectId, candidate.objectId].sort());
    }));

  it("at most maxPlacesPerRun places, fewest documents first", () =>
    withRollback(async (tx) => {
      await areaTile(tx);
      const one = await place(tx, "Eins");
      await documents(tx, one.objectId, 1);
      const none = await place(tx, "Keins");
      const cfg = { ...followup(), maxPlacesPerRun: 1 };
      expect(await thinPlaces(tx, [one.objectId, none.objectId], cfg, TODAY)).toEqual([none.objectId]);
      expect(await thinPlaces(tx, [one.objectId, none.objectId], { ...cfg, maxPlacesPerRun: 5 }, TODAY)).toEqual([none.objectId, one.objectId]);
    }));
});

describe("follow-up refinements (ruling M5-H-R2)", () => {
  const withSerpCap = (max: number): AppConfig => {
    const c = getConfig();
    return { ...c, discovery: { ...c.discovery, serp: { ...c.discovery.serp, maxQueriesPerRun: max } } };
  };

  it("a merged place adds no tile in either candidate-space mapper", () =>
    withRollback(async (tx) => {
      await areaTile(tx);
      const other = tileIdFor(LON + 0.5, LAT);
      await insertTestTile(tx, other, null);
      const live = await place(tx, "Lebend", { languages: ["en"] });
      // a place in the other tile, searched for before it was merged into the live one
      const merged = await place(tx, "Verschmolzen", { lon: LON + 0.5, languages: ["en"] });
      await tx.update(places).set({ mergedIntoId: live.placeId }).where(eq(places.id, merged.placeId));
      const sourceId = await insertSource(tx);
      const [source] = await tx.select({ domain: sources.domain }).from(sources).where(eq(sources.id, sourceId));
      const [q] = await tx
        .insert(serpQueries)
        .values({ keyword: `anchorage Lebend ${newId()}`, languageCode: "en", locationCode: 2826, depth: 20, level: "place", scopeId: merged.objectId, rawKey: "serp/x.json", fetchedAt: NOW })
        .returning({ id: serpQueries.id });
      await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url: `https://${source!.domain}/`, urlNormalized: `https://${source!.domain}/`, domain: source!.domain, title: "t", snippet: "s" });
      const v = await insertTestVersion(tx, ["Ein Text ohne bekannte Namen."], { sourceId });
      const cfg = getConfig();
      const space = await candidateTiles(tx, v.versionId, cfg.mentions, { nameAffixes: cfg.nameAffixes, subdivisionKeys: [] });
      expect(space.tiles).not.toContain(other);
      expect((await freezeTextRunParams(tx, { tileId: other }, cfg)).documentVersionIds).not.toContain(v.versionId);
    }));

  it("discovery.place plans the places in their order, a shared query once, cut to the cap in that order; its handler runs the job", () =>
    withRollback(async (tx) => {
      await areaTile(tx);
      const shared = `Gleich${newId().slice(0, 8)}`;
      const second = await place(tx, shared, { languages: ["de", "en"] });
      const first = await place(tx, shared, { languages: ["de", "en"] });
      const third = await place(tx, `Dritt${newId().slice(0, 8)}`, { languages: ["de", "en"] });
      // the run's order (fewest documents first), not the id order: the later id keeps the shared queries
      const plan = await planPlaceDiscovery(tx, { geoObjectIds: [first.objectId, second.objectId, third.objectId] }, withSerpCap(3));
      expect(plan.map((p) => [p.geoObjectId, p.queries.map((q) => q.languageCode)])).toEqual([
        [first.objectId, ["de", "en"]],
        [third.objectId, ["de"]],
      ]);
    }));
});
