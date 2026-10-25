import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, runs, serpQueries, tileGeoObjects, tiles } from "@/lib/db/schema";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { insertTestSubdivision } from "@/test/text";
import { discoverArea } from "@/lib/pipeline/discovery";
import { startDiscoveryRun } from "@/lib/pipeline/discovery-run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

// A run may make at most 5 SERP queries; everything else is the real config.
vi.mock("@/lib/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/config")>();
  const base = original.getConfig();
  const config = { ...base, discovery: { ...base.discovery, serp: { ...base.discovery.serp, maxQueriesPerRun: 5 } } };
  return { ...original, getConfig: () => config };
});

// Synthetic tiles in open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N, at spots no other test uses.
const AREA_KEY = "discovery-test";
const SUB_KEY = "XT-D1";
const TILE_A = tileIdFor(28.1, 33.6);
const TILE_B = tileIdFor(28.6, 33.6);

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

async function insertTile(tx: Db, id: string, areaId: string | null, subdivisionId: string | null = null): Promise<void> {
  const [w, s, e, n] = tileBbox(id);
  await tx.insert(tiles).values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, areaId, subdivisionId, hasCoast: true });
}

/** A Greek subdivision (languages el, de, en) over the box [west, south, east, north]. */
async function insertSubdivision(tx: Db, key = SUB_KEY, box: [number, number, number, number] = [28, 33.5, 29, 33.75]): Promise<string> {
  return (await insertTestSubdivision(tx, key, box)).id;
}

/** An `area` object `discovery-test` named in German and English, linked to the given tiles. */
async function insertArea(tx: Db, tileIds: string[]): Promise<string> {
  const [area] = await tx
    .insert(geoObjects)
    .values({ type: "area", origin: "manual", configKey: AREA_KEY, geom: geomFromGeoJson({ type: "Point", coordinates: [28.6, 33.6] }) })
    .returning({ id: geoObjects.id });
  for (const [language, name] of [["de", "Testrevier"], ["en", "Test Gulf"]] as const) {
    await tx.insert(geoNames).values({
      geoObjectId: area!.id,
      name,
      nameNormalized: name.toLowerCase(),
      language,
      script: "latin",
      origin: "manual",
      isPreferred: true,
    });
  }
  for (const tileId of tileIds) await tx.insert(tileGeoObjects).values({ tileId, geoObjectId: area!.id });
  return area!.id;
}

async function insertIsland(tx: Db, tileId: string, name: string): Promise<void> {
  const [o] = await tx
    .insert(geoObjects)
    .values({ type: "island", origin: "osm", geom: geomFromGeoJson({ type: "Point", coordinates: [28.3, 33.6] }) })
    .returning({ id: geoObjects.id });
  for (const language of ["de", "en"]) {
    await tx.insert(geoNames).values({
      geoObjectId: o!.id,
      name,
      nameNormalized: name.toLowerCase(),
      language,
      script: "latin",
      origin: "osm",
      isPreferred: true,
    });
  }
  await tx.insert(tileGeoObjects).values({ tileId, geoObjectId: o!.id });
}

/** Subdivision, area object over both tiles, tiles A (island Alpha) and B (islands Beta and another Alpha). */
async function seedArea(tx: Db): Promise<string> {
  const subId = await insertSubdivision(tx);
  await insertTile(tx, TILE_A, null, subId);
  await insertTile(tx, TILE_B, null, subId);
  const areaId = await insertArea(tx, [TILE_A, TILE_B]);
  await insertIsland(tx, TILE_A, "Alpha");
  await insertIsland(tx, TILE_B, "Beta");
  await insertIsland(tx, TILE_B, "Alpha");
  return areaId;
}

describe("discovery stages", () => {

  it("the area job makes the area queries up to the cap, one after another", () =>
    withRollback(async (tx) => {
      const areaId = await seedArea(tx);
      const body = readFileSync("test/fixtures/http/dataforseo/hand/organic-20-paa.json");
      const requests: HttpRequest[] = [];
      const transport: Transport = async (req) => {
        requests.push(req);
        return makeResponse(200, new Uint8Array(body));
      };
      const result = await discoverArea(tx, SUB_KEY, { transport, archive: memoryArchive() }, { db: tx });
      expect(result).toMatchObject({ queries: 3, searched: 3, reused: 0, failed: 0, queryIds: expect.toSatisfy((ids: string[]) => ids.length === 3) });
      const rows = await tx.select({ keyword: serpQueries.keyword }).from(serpQueries).where(eq(serpQueries.scopeId, areaId));
      expect(rows.map((r) => r.keyword).sort()).toEqual(["Revierführer Testrevier", "Test Gulf anchorages", "Törnbericht Testrevier"]);
      expect(requests).toHaveLength(3);
    }));
});

describe("area queries across subdivisions", () => {
  it("an area touching two subdivisions is searched once per reuse window", () =>
    withRollback(async (tx) => {
      const subA = await insertSubdivision(tx);
      await insertSubdivision(tx, "XT-D2", [28.5, 33.5, 29.5, 33.75]);
      await insertTile(tx, TILE_A, null, subA);
      await insertTile(tx, TILE_B, null, subA);
      // the area lies on tile B only, which both subdivisions' scopes contain
      await insertArea(tx, [TILE_B]);
      const body = readFileSync("test/fixtures/http/dataforseo/hand/organic-20-paa.json");
      let requests = 0;
      const transport: Transport = async () => {
        requests++;
        return makeResponse(200, new Uint8Array(body));
      };
      const deps = { transport, archive: memoryArchive() };
      expect(await discoverArea(tx, SUB_KEY, deps, { db: tx })).toMatchObject({ queries: 3, searched: 3, reused: 0, failed: 0 });
      expect(await discoverArea(tx, "XT-D2", deps, { db: tx })).toMatchObject({ queries: 3, searched: 0, reused: 3, failed: 0 });
      expect(requests).toBe(3);
    }));

  it("the area stage of a subdivision without the area's tiles plans no area queries", () =>
    withRollback(async (tx) => {
      await insertSubdivision(tx);
      const result = await discoverArea(tx, SUB_KEY, { transport: async () => makeResponse(500, new Uint8Array()), archive: memoryArchive() }, { db: tx });
      expect(result).toMatchObject({ queries: 0, searched: 0, reused: 0, failed: 0 });
    }));
});

describe("startDiscoveryRun", () => {

  it("refuses an unknown subdivision, an area key, a subdivision without coast tiles and a tile without a subdivision before the run exists", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      const before = await tx.select({ id: runs.id }).from(runs).where(eq(runs.triggeredBy, "discovery-scope-test"));
      await expect(startDiscoveryRun(tx, boss, { subdivisionKey: "nowhere" }, "discovery-scope-test")).rejects.toThrow(
        "Unbekannter Landesteil nowhere",
      );
      const areaKey = Object.keys(getConfig().subdivisions.retiredAreaKeys)[0]!;
      await expect(startDiscoveryRun(tx, boss, { subdivisionKey: areaKey }, "discovery-scope-test")).rejects.toThrow(
        `Revier-Schlüssel ${areaKey} ist kein Laufumfang mehr`,
      );
      await insertSubdivision(tx);
      await expect(startDiscoveryRun(tx, boss, { subdivisionKey: SUB_KEY }, "discovery-scope-test")).rejects.toBeInstanceOf(
        RunScopeNotReady,
      );
      await insertTile(tx, TILE_A, null);
      await expect(startDiscoveryRun(tx, boss, { tileId: TILE_A }, "discovery-scope-test")).rejects.toMatchObject({
        reason: "tile_without_subdivision",
      });
      await expect(startDiscoveryRun(tx, boss, { tileId: TILE_B }, "discovery-scope-test")).rejects.toThrow(/Unknown tile/);
      const after = await tx.select({ id: runs.id }).from(runs).where(eq(runs.triggeredBy, "discovery-scope-test"));
      expect(after).toHaveLength(before.length);
    }));
});

describe("excluded subdivisions", () => {
  it("startDiscoveryRun refuses an excluded subdivision before the run exists", () =>
    withRollback(async (tx) => {
      await insertTestSubdivision(tx, "XT-D3", [28, 33.5, 29, 33.75], { status: "excluded" });
      const { boss, inserted } = recordingBoss();
      await expect(startDiscoveryRun(tx, boss, { subdivisionKey: "XT-D3" }, "test")).rejects.toThrow("Landesteil XT-D3 ist ausgeschlossen");
      expect(inserted).toEqual([]);
    }));
});
