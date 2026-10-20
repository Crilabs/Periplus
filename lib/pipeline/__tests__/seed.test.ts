import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places, runs, runStages, subdivisions, tileGeoObjects, tiles } from "@/lib/db/schema";
import { newId, newPublicId } from "@/lib/domain/ids";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { HANDLERS } from "@/lib/jobs/registry";
import { STAGES } from "@/lib/jobs/stages";
import { createLogger } from "@/lib/logger";
import { SEED_STAGE, startSeedRun } from "@/lib/pipeline/seed";
import { withRollback } from "@/test/db";

// Synthetic subdivision "XS-SEED" outside the pilot box 23.0-23.75 E x 37.0-38.0 N (open sea, 27-27.75 E x 34 N).
const SUB_KEY = "XS-SEED";
const COAST_1 = tileIdFor(27.1, 34.1);
const COAST_2 = tileIdFor(27.6, 34.1);
const OPEN_SEA = tileIdFor(27.35, 34.1);
const OUTSIDE = tileIdFor(27.85, 34.1);

async function insertTile(db: Db, id: string, hasCoast: boolean): Promise<void> {
  const [w, s, e, n] = tileBbox(id);
  await db.insert(tiles).values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, hasCoast });
}

async function insertSubdivision(db: Db, key: string): Promise<void> {
  const envelope = sql`ST_Multi(ST_MakeEnvelope(27, 34, 27.75, 34.25, 4326))`;
  const [obj] = await db
    .insert(geoObjects)
    .values({ type: "admin_region", origin: "manual", configKey: key, geom: envelope })
    .returning({ id: geoObjects.id });
  await db
    .insert(subdivisions)
    .values({ publicId: newPublicId("sd"), key, country: "GR", geoObjectId: obj!.id, geom: envelope, landGeom: envelope });
}

function recordingBoss() {
  const inserted: Array<{ queue: string; data: unknown }> = [];
  const boss = {
    insert: async (queue: string, jobs: Array<{ id: string; data: unknown }>) => {
      inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
      return jobs.map((j) => j.id);
    },
  } as unknown as PgBoss;
  return { boss, inserted };
}

describe("stage seed.tile", () => {
  it("runs on queue seed.tile", () => {
    expect(SEED_STAGE).toBe("seed.tile");
    expect(STAGES[SEED_STAGE]?.queue).toBe("seed.tile");
  });

  it("plans one job per coast tile of the subdivision", () =>
    withRollback(async (db) => {
      await insertSubdivision(db, SUB_KEY);
      await insertTile(db, COAST_1, true);
      await insertTile(db, COAST_2, true);
      await insertTile(db, OPEN_SEA, false);
      await insertTile(db, OUTSIDE, true);

      const jobs = await STAGES[SEED_STAGE]!.plan(db, { id: newId(), params: { subdivisionKey: SUB_KEY } });
      expect(jobs).toEqual([COAST_1, COAST_2].sort().map((tileId) => ({ key: tileId, tileId })));
    }));

  it("plans exactly the given tiles", async () => {
    const db = {} as Db; // planning by tile ids needs no database
    const jobs = await STAGES[SEED_STAGE]!.plan(db, { id: newId(), params: { tileIds: [OPEN_SEA, COAST_1] } });
    expect(jobs).toEqual([
      { key: OPEN_SEA, tileId: OPEN_SEA },
      { key: COAST_1, tileId: COAST_1 },
    ]);
  });

  it("rejects params without tileIds or subdivisionKey", async () => {
    await expect(STAGES[SEED_STAGE]!.plan({} as Db, { id: newId(), params: {} })).rejects.toThrow(/tileIds or subdivisionKey/);
    await expect(
      STAGES[SEED_STAGE]!.plan({} as Db, { id: newId(), params: { tileIds: ["nope"] } }),
    ).rejects.toThrow(/invalid tile id/);
  });

  it("the handler seeds the job's tile", () =>
    withRollback(async (db) => {
      await insertTile(db, COAST_1, true);
      const [bay] = await db
        .insert(geoObjects)
        .values({ type: "bay", origin: "osm", geom: sql`${geomFromGeoJson({ type: "Point", coordinates: [27.1, 34.1] })}` })
        .returning({ id: geoObjects.id });
      await db.insert(tileGeoObjects).values({ tileId: COAST_1, geoObjectId: bay!.id });

      const runId = newId();
      await HANDLERS["seed.tile"](
        { key: COAST_1, tileId: COAST_1, runId, stage: SEED_STAGE },
        { db, boss: {} as PgBoss, log: createLogger("test"), jobId: newId(), runId },
      );
      const rows = await db.select({ status: places.status }).from(places).where(eq(places.geoObjectId, bay!.id));
      expect(rows).toEqual([{ status: "candidate" }]);
    }));
});

describe("startSeedRun", () => {
  it("creates a tile run and enqueues its seed job", () =>
    withRollback(async (db) => {
      await insertTile(db, COAST_1, true);
      const { boss, inserted } = recordingBoss();
      const { id } = await startSeedRun(db, boss, { tileId: COAST_1 }, "test");

      const [run] = await db.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({
        kind: "stage",
        scopeType: "tile",
        scopeId: COAST_1,
        stages: ["seed.tile"],
        params: { tileIds: [COAST_1] },
        triggeredBy: "test",
      });
      const stages = await db.select().from(runStages).where(eq(runStages.runId, id));
      expect(stages.map((s) => [s.stage, s.status, s.total])).toEqual([["seed.tile", "running", 1]]);
      expect(inserted).toEqual([
        { queue: "seed.tile", data: { key: COAST_1, tileId: COAST_1, runId: id, stage: "seed.tile" } },
      ]);
    }));

  it("creates a subdivision run over the subdivision's coast tiles", () =>
    withRollback(async (db) => {
      await insertSubdivision(db, SUB_KEY);
      await insertTile(db, COAST_1, true);
      const { boss, inserted } = recordingBoss();
      const { id } = await startSeedRun(db, boss, { subdivisionKey: SUB_KEY }, "test");

      const [run] = await db.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ scopeType: "subdivision", scopeId: SUB_KEY, params: { subdivisionKey: SUB_KEY } });
      expect(inserted).toEqual([
        { queue: "seed.tile", data: { key: COAST_1, tileId: COAST_1, runId: id, stage: "seed.tile" } },
      ]);
    }));

  it("rejects an unknown tile before creating a run", () =>
    withRollback(async (db) => {
      const { boss, inserted } = recordingBoss();
      await expect(startSeedRun(db, boss, { tileId: COAST_1 }, "test")).rejects.toThrow(`Unknown tile ${COAST_1}`);
      expect(await db.select().from(runs).where(eq(runs.scopeId, COAST_1))).toEqual([]);
      expect(inserted).toEqual([]);
    }));

  it("rejects an unknown subdivision before creating a run", () =>
    withRollback(async (db) => {
      const { boss, inserted } = recordingBoss();
      await expect(startSeedRun(db, boss, { subdivisionKey: "XS-NOPE" }, "test")).rejects.toThrow("Unbekannter Landesteil XS-NOPE");
      expect(await db.select().from(runs).where(eq(runs.scopeId, "XS-NOPE"))).toEqual([]);
      expect(inserted).toEqual([]);
    }));

  it("startSeedRun with an area key fails with the replacement hint", () =>
    withRollback(async (db) => {
      const { boss, inserted } = recordingBoss();
      const areaKey = getConfig().areas[0]!.key;
      await expect(startSeedRun(db, boss, { subdivisionKey: areaKey }, "test")).rejects.toThrow(
        `Revier-Schlüssel ${areaKey} ist kein Laufumfang mehr; Landesteil angeben (z. B. GR-I)`,
      );
      expect(await db.select().from(runs).where(eq(runs.scopeId, areaKey))).toEqual([]);
      expect(inserted).toEqual([]);
    }));

  it("rejects a subdivision without coast tiles before creating a run", () =>
    withRollback(async (db) => {
      await insertSubdivision(db, SUB_KEY);
      const { boss, inserted } = recordingBoss();
      await expect(startSeedRun(db, boss, { subdivisionKey: SUB_KEY }, "test")).rejects.toThrow(
        `Subdivision ${SUB_KEY} has no coast tiles yet`,
      );
      expect(await db.select().from(runs).where(eq(runs.scopeId, SUB_KEY))).toEqual([]);
      expect(inserted).toEqual([]);
    }));
});
