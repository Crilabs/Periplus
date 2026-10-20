import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { areaByKey, getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, runs, serpQueries, subdivisions, tileGeoObjects, tiles } from "@/lib/db/schema";
import { syncAreas } from "@/lib/domain/gazetteer/areas";
import { newId, newPublicId } from "@/lib/domain/ids";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { STAGES } from "@/lib/jobs/stages";
import {
  discoverArea,
  DISCOVERY_AREA_STAGE,
  DISCOVERY_PROPOSE_STAGE,
  DISCOVERY_TILE_STAGE,
} from "@/lib/pipeline/discovery";
import { startDiscoveryRun, startProposalRun } from "@/lib/pipeline/discovery-run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";

// The synthetic area "discovery-test" (German and English only) joins the configured areas, and a run may make
// at most 5 SERP queries; everything else is the real config.
vi.mock("@/lib/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/config")>();
  const base = original.getConfig();
  const testArea = {
    ...base.areas[0]!,
    key: "discovery-test",
    names: { de: "Testrevier", en: "Test Gulf", el: "Δοκιμή" },
    sourceLanguages: ["de", "en"],
    polygon: { type: "Polygon" as const, coordinates: [[[28, 33.5], [29, 33.5], [29, 33.75], [28, 33.75], [28, 33.5]]] },
    tileBbox: [28, 33.5, 29, 33.75] as [number, number, number, number],
    coastSections: [],
  };
  const config = {
    ...base,
    areas: [...base.areas, testArea],
    discovery: { ...base.discovery, serp: { ...base.discovery.serp, maxQueriesPerRun: 5 } },
  };
  return {
    ...original,
    getConfig: () => config,
    areaByKey: (key: string) => {
      const found = config.areas.find((a) => a.key === key);
      if (!found) throw new Error(`Unknown area ${key}`);
      return found;
    },
  };
});

// Synthetic tiles in open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N, at spots no other test uses.
const AREA_KEY = "discovery-test";
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

// TODO(plan 14a task 8): the area queries still look the subdivision up as a configured area of the same key (mock above).
const SUB_KEY = AREA_KEY;

/** A subdivision over the two synthetic tiles (28-29 E x 33.5-33.75 N). */
async function insertSubdivision(tx: Db): Promise<string> {
  const polygon = sql`ST_Multi(ST_MakeEnvelope(28, 33.5, 29, 33.75, 4326))`;
  const [region] = await tx
    .insert(geoObjects)
    .values({ type: "admin_region", origin: "manual", configKey: `${SUB_KEY}/region`, geom: polygon })
    .returning({ id: geoObjects.id });
  const [row] = await tx
    .insert(subdivisions)
    .values({ publicId: newPublicId("sd"), key: SUB_KEY, country: "GR", geoObjectId: region!.id, geom: polygon, landGeom: polygon })
    .returning({ id: subdivisions.id });
  return row!.id;
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

/** Area object, subdivision, tiles A (island Alpha) and B (islands Beta and another Alpha). */
async function seedArea(tx: Db): Promise<void> {
  const areaId = (await syncAreas(tx, [areaByKey(AREA_KEY)])).get(AREA_KEY)!;
  const subId = await insertSubdivision(tx);
  await insertTile(tx, TILE_A, areaId, subId);
  await insertTile(tx, TILE_B, areaId, subId);
  await insertIsland(tx, TILE_A, "Alpha");
  await insertIsland(tx, TILE_B, "Beta");
  await insertIsland(tx, TILE_B, "Alpha");
}

const keywords = (job: Record<string, unknown>) => (job.queries as Array<{ keyword: string }>).map((q) => q.keyword);

describe("discovery stages", () => {
  it("run on their own queues", () => {
    expect(STAGES[DISCOVERY_AREA_STAGE]?.queue).toBe("discovery.area");
    expect(STAGES[DISCOVERY_TILE_STAGE]?.queue).toBe("discovery.tile");
    expect(STAGES[DISCOVERY_PROPOSE_STAGE]?.queue).toBe("discovery.propose");
  });

  it("the area stage plans one job for the subdivision", () =>
    withRollback(async (tx) => {
      await insertSubdivision(tx);
      const jobs = await STAGES[DISCOVERY_AREA_STAGE]!.plan(tx, { id: newId(), params: { subdivisionKey: SUB_KEY } });
      expect(jobs).toEqual([{ key: SUB_KEY, subdivisionKey: SUB_KEY }]);
      await expect(STAGES[DISCOVERY_AREA_STAGE]!.plan(tx, { id: newId(), params: { subdivisionKey: "XD-NOPE" } })).rejects.toThrow(
        "Unbekannter Landesteil XD-NOPE",
      );
    }));

  it("the tile stage gets only the queries left under the per-run cap", () =>
    withRollback(async (tx) => {
      await seedArea(tx);
      // 3 area queries (Törnbericht/Revierführer Testrevier, Test Gulf anchorages) leave 2 of 5 for the tiles;
      // the tiles' 4 distinct queries ("Alpha" on both tiles counts once) are cut to the first 2.
      const jobs = await STAGES[DISCOVERY_TILE_STAGE]!.plan(tx, { id: newId(), params: { subdivisionKey: AREA_KEY } });
      expect(jobs.map((j) => ({ key: j.key, tileId: j.tileId, keywords: keywords(j) }))).toEqual([
        { key: TILE_A, tileId: TILE_A, keywords: ["Ankerplatz Alpha"] },
        { key: TILE_B, tileId: TILE_B, keywords: ["Ankerplatz Beta"] },
      ]);
      expect((jobs[0]!.queries as unknown[])[0]).toEqual({
        keyword: "Ankerplatz Alpha",
        languageCode: "de",
        locationCode: 2276,
        level: "tile",
        scopeId: TILE_A,
        priority: 1,
      });
    }));

  it("a tile run has the whole cap for its tile", () =>
    withRollback(async (tx) => {
      await seedArea(tx);
      const jobs = await STAGES[DISCOVERY_TILE_STAGE]!.plan(tx, { id: newId(), params: { tileIds: [TILE_B] } });
      expect(jobs.map(keywords)).toEqual([["Ankerplatz Alpha", "Ankerplatz Beta", "anchorage Alpha", "anchorage Beta"]]);
    }));

  it("the propose stage plans one job", async () => {
    expect(await STAGES[DISCOVERY_PROPOSE_STAGE]!.plan({} as Db, { id: newId(), params: {} })).toEqual([{ key: "propose" }]);
  });

  it("the area job makes the area queries up to the cap, one after another", () =>
    withRollback(async (tx) => {
      await seedArea(tx);
      const body = readFileSync("test/fixtures/http/dataforseo/hand/organic-20-paa.json");
      const requests: HttpRequest[] = [];
      const transport: Transport = async (req) => {
        requests.push(req);
        return makeResponse(200, new Uint8Array(body));
      };
      const result = await discoverArea(tx, AREA_KEY, { transport, archive: memoryArchive() }, { db: tx });
      expect(result).toEqual({ queries: 3, searched: 3, reused: 0 });
      const rows = await tx.select({ keyword: serpQueries.keyword }).from(serpQueries).where(eq(serpQueries.scopeId, AREA_KEY));
      expect(rows.map((r) => r.keyword).sort()).toEqual(["Revierführer Testrevier", "Test Gulf anchorages", "Törnbericht Testrevier"]);
      expect(requests).toHaveLength(3);
    }));
});

describe("startDiscoveryRun", () => {
  it("a subdivision run searches the subdivision, its tiles, then proposes", () =>
    withRollback(async (tx) => {
      await seedArea(tx);
      const { boss, inserted } = recordingBoss();
      const { id } = await startDiscoveryRun(tx, boss, { subdivisionKey: SUB_KEY }, "test");
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({
        kind: "stage",
        scopeType: "subdivision",
        scopeId: SUB_KEY,
        stages: ["discovery.area", "discovery.tile", "discovery.propose"],
        params: { subdivisionKey: SUB_KEY },
      });
      expect(inserted).toEqual([{ queue: "discovery.area", data: expect.objectContaining({ key: SUB_KEY, runId: id }) }]);
    }));

  it("a tile run searches the tile, then proposes", () =>
    withRollback(async (tx) => {
      await seedArea(tx);
      const { boss, inserted } = recordingBoss();
      const { id } = await startDiscoveryRun(tx, boss, { tileId: TILE_A }, "test");
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({
        scopeType: "tile",
        scopeId: TILE_A,
        stages: ["discovery.tile", "discovery.propose"],
        params: { tileIds: [TILE_A] },
      });
      expect(inserted.map((j) => [j.queue, j.data.key])).toEqual([["discovery.tile", TILE_A]]);
    }));

  it("refuses an unknown subdivision, an area key, a subdivision without coast tiles and a tile without a subdivision before the run exists", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      const before = await tx.select({ id: runs.id }).from(runs).where(eq(runs.triggeredBy, "discovery-scope-test"));
      await expect(startDiscoveryRun(tx, boss, { subdivisionKey: "nowhere" }, "discovery-scope-test")).rejects.toThrow(
        "Unbekannter Landesteil nowhere",
      );
      const areaKey = getConfig().areas[0]!.key;
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

describe("startProposalRun", () => {
  it("runs only the propose stage", () =>
    withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      const { id } = await startProposalRun(tx, boss, "test");
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ scopeType: "system", scopeId: "discovery", stages: ["discovery.propose"] });
      expect(inserted.map((j) => [j.queue, j.data.key])).toEqual([["discovery.propose", "propose"]]);
    }));
});
