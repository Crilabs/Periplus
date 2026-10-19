import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { makeResponse, type Transport } from "@/lib/adapters/http";
import { areaByKey, getConfig, getConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { externalCalls, geoNames, placeDiscoveryRequests, runs, serpQueries, serpResults, sources } from "@/lib/db/schema";
import { placeQueries, thinPlaces } from "@/lib/domain/consolidation/followup";
import { syncAreas } from "@/lib/domain/gazetteer/areas";
import { newId } from "@/lib/domain/ids";
import { candidateTiles } from "@/lib/domain/mentions/scope";
import { tileIdFor } from "@/lib/domain/tiles";
import { STAGES } from "@/lib/jobs/stages";
import { requestPlaceDiscovery } from "@/lib/pipeline/consolidation/followup";
import { CONSOLIDATION_FOLLOWUP_STAGE } from "@/lib/pipeline/consolidation/stages";
import { DISCOVERY_PLACE_STAGE, runQueries } from "@/lib/pipeline/discovery";
import { freezeTextRunParams } from "@/lib/pipeline/text/versions";
import { insertMention, insertPlace, insertSource } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertTestRun, insertTestTile, insertTestVersion } from "@/test/text";

/*
 * Follow-up of a consolidation (plan Task 15): thin places, their queries and the place discovery run, in withRollback
 * at a spot outside the pilot box no other test uses (20.13° E / 34.13° N); assertions only on the test's own rows.
 */

const LON = 20.13;
const LAT = 34.13;
const TILE = tileIdFor(LON, LAT);
const NOW = new Date("2026-10-19T12:00:00Z");
const DAY_MS = 86_400_000;
const followup = () => getConsolidationConfig().followup;

function recordingBoss() {
  const inserted: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const boss = {
    insert: async (queue: string, jobs: Array<{ id: string; data: Record<string, unknown> }>) => {
      inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
      return jobs.map((j) => j.id);
    },
  } as unknown as PgBoss;
  return { boss, inserted };
}

/** The `saronic` area (de, en, el) and the test tile labelled with it. */
async function areaTile(tx: Db): Promise<string> {
  const areaId = (await syncAreas(tx, [areaByKey("saronic")])).get("saronic")!;
  return insertTestTile(tx, TILE, areaId);
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
      expect(await thinPlaces(tx, [objectId], followup(), NOW)).toEqual([objectId]);

      const queries = await placeQueries(tx, objectId, getConfig().discovery);
      const names = await tx.select({ name: geoNames.name, language: geoNames.language }).from(geoNames).where(and(eq(geoNames.geoObjectId, objectId), eq(geoNames.isPreferred, true)));
      const nameOf = (lang: string) => names.find((n) => n.language === lang)!.name;
      expect(queries).toEqual([
        { keyword: `Ankerplatz ${nameOf("de")}`, languageCode: "de", locationCode: 2276, level: "place", scopeId: objectId, priority: 1, tileId: TILE },
        { keyword: `anchorage ${nameOf("en")}`, languageCode: "en", locationCode: 2826, level: "place", scopeId: objectId, priority: 1, tileId: TILE },
        { keyword: `αγκυροβόλιο ${nameOf("el")}`, languageCode: "el", locationCode: 2300, level: "place", scopeId: objectId, priority: 1, tileId: TILE },
      ]);
    }));

  it("a place outside a configured area gets no queries", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE, null);
      const { objectId } = await place(tx, "Ohnerevier", { languages: ["de", "en"] });
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
      const space = await candidateTiles(tx, v.versionId, cfg.mentions, { nameAffixes: cfg.nameAffixes, areaKeys: cfg.areas.map((a) => a.key) });
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
      expect((await thinPlaces(tx, ids, followup(), NOW)).sort()).toEqual([longAgo.objectId, candidate.objectId].sort());
    }));

  it("at most maxPlacesPerRun places, fewest documents first", () =>
    withRollback(async (tx) => {
      await areaTile(tx);
      const one = await place(tx, "Eins");
      await documents(tx, one.objectId, 1);
      const none = await place(tx, "Keins");
      const cfg = { ...followup(), maxPlacesPerRun: 1 };
      expect(await thinPlaces(tx, [one.objectId, none.objectId], cfg, NOW)).toEqual([none.objectId]);
      expect(await thinPlaces(tx, [one.objectId, none.objectId], { ...cfg, maxPlacesPerRun: 5 }, NOW)).toEqual([none.objectId, one.objectId]);
    }));
});

describe("stage consolidation.followup", () => {
  it("the followup stage starts one discovery run and records the requests", () =>
    withRollback(async (tx) => {
      await areaTile(tx);
      const thin = await place(tx, `Duenn${newId().slice(0, 8)}`, { languages: ["de", "en"] });
      const rich = await place(tx, "Reich", { languages: ["de"] });
      await documents(tx, rich.objectId, 2);
      const [run] = await tx
        .insert(runs)
        .values({ kind: "stage", scopeType: "system", scopeId: "consolidation", stages: [CONSOLIDATION_FOLLOWUP_STAGE], params: { geoObjectIds: [thin.objectId, rich.objectId] }, triggeredBy: "test" })
        .returning({ id: runs.id });
      expect(await STAGES[CONSOLIDATION_FOLLOWUP_STAGE]!.plan(tx, { id: run!.id, params: { geoObjectIds: [thin.objectId] } })).toEqual([{ key: "followup" }]);

      const rec = recordingBoss();
      const result = await requestPlaceDiscovery(tx, rec.boss, run!.id, NOW);
      expect(result).toMatchObject({ places: [thin.objectId], skipped: false });
      const [discovery] = await tx.select().from(runs).where(eq(runs.id, result.discoveryRunId!));
      expect(discovery).toMatchObject({
        kind: "event",
        scopeType: "system",
        scopeId: "places",
        stages: ["discovery.place", "discovery.propose"],
        params: { geoObjectIds: [thin.objectId] },
        triggeredBy: `consolidation:${run!.id}`,
      });
      const requests = await tx.select().from(placeDiscoveryRequests).where(eq(placeDiscoveryRequests.runId, discovery!.id));
      expect(requests.map((r) => r.geoObjectId)).toEqual([thin.objectId]);
      // one discovery.place job for the thin place, carrying its queries
      expect(rec.inserted.map((j) => [j.queue, j.data.key])).toEqual([["discovery.place", thin.objectId]]);
      const queries = rec.inserted[0]!.data.queries as Array<{ keyword: string; level: string; tileId: string }>;
      expect(queries.map((q) => q.keyword)).toEqual([`Ankerplatz ${(await nameOf(tx, thin.objectId, "de"))}`, `anchorage ${(await nameOf(tx, thin.objectId, "en"))}`]);
      expect(queries.every((q) => q.level === "place" && q.tileId === TILE)).toBe(true);

      // a retried job starts nothing again; the request now cools the place down
      expect(await requestPlaceDiscovery(tx, rec.boss, run!.id, NOW)).toMatchObject({ skipped: true, discoveryRunId: discovery!.id });
      expect(await tx.select().from(runs).where(eq(runs.triggeredBy, `consolidation:${run!.id}`))).toHaveLength(1);
      expect(await thinPlaces(tx, [thin.objectId], followup(), NOW)).toEqual([]);
    }));

  it("an evaluation run plans no followup", () =>
    withRollback(async (tx) => {
      await areaTile(tx);
      const thin = await place(tx, "Bewertet");
      const runId = await insertTestRun(tx);
      const params = { geoObjectIds: [thin.objectId], evaluation: true };
      expect(await STAGES[CONSOLIDATION_FOLLOWUP_STAGE]!.plan(tx, { id: runId, params })).toEqual([]);
    }));
});

async function nameOf(tx: Db, objectId: string, language: string): Promise<string> {
  const [row] = await tx
    .select({ name: geoNames.name })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, objectId), eq(geoNames.language, language), eq(geoNames.isPreferred, true)));
  return row!.name;
}
