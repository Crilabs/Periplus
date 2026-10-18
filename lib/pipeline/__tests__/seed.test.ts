import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, places, runs, runStages, tileGeoObjects, tiles } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { HANDLERS } from "@/lib/jobs/registry";
import { STAGES } from "@/lib/jobs/stages";
import { createLogger } from "@/lib/logger";
import { SEED_STAGE, startSeedRun } from "@/lib/pipeline/seed";
import { withRollback } from "@/test/db";

// Synthetic area "seed-test" outside the pilot box 23.0-23.75 E x 37.0-38.0 N (open sea, 27-28 E x 34 N).
const AREA_KEY = "seed-test";
const COAST_1 = tileIdFor(27.1, 34.1);
const COAST_2 = tileIdFor(27.6, 34.1);
const OPEN_SEA = tileIdFor(27.35, 34.1);
const OTHER_AREA = tileIdFor(27.85, 34.1);

async function insertTile(db: Db, id: string, areaId: string | null, hasCoast: boolean): Promise<void> {
  const [w, s, e, n] = tileBbox(id);
  await db.insert(tiles).values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, areaId, hasCoast });
}

async function insertArea(db: Db, configKey: string): Promise<string> {
  const [row] = await db
    .insert(geoObjects)
    .values({
      type: "area",
      origin: "manual",
      configKey,
      geom: sql`${geomFromGeoJson({ type: "Point", coordinates: [27.5, 34.1] })}`,
    })
    .returning({ id: geoObjects.id });
  return row!.id;
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

  it("plans one job per coast tile of the area", () =>
    withRollback(async (db) => {
      const areaId = await insertArea(db, AREA_KEY);
      const otherId = await insertArea(db, `${AREA_KEY}-other`);
      await insertTile(db, COAST_1, areaId, true);
      await insertTile(db, COAST_2, areaId, true);
      await insertTile(db, OPEN_SEA, areaId, false);
      await insertTile(db, OTHER_AREA, otherId, true);

      const jobs = await STAGES[SEED_STAGE]!.plan(db, { id: newId(), params: { areaKey: AREA_KEY } });
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

  it("rejects params without tileIds or areaKey", async () => {
    await expect(STAGES[SEED_STAGE]!.plan({} as Db, { id: newId(), params: {} })).rejects.toThrow(/tileIds or areaKey/);
    await expect(
      STAGES[SEED_STAGE]!.plan({} as Db, { id: newId(), params: { tileIds: ["nope"] } }),
    ).rejects.toThrow(/invalid tile id/);
  });

  it("the handler seeds the job's tile", () =>
    withRollback(async (db) => {
      await insertTile(db, COAST_1, null, true);
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

  it("creates an area run over the area's coast tiles", () =>
    withRollback(async (db) => {
      const areaId = await insertArea(db, AREA_KEY);
      await insertTile(db, COAST_1, areaId, true);
      const { boss, inserted } = recordingBoss();
      const { id } = await startSeedRun(db, boss, { areaKey: AREA_KEY }, "test");

      const [run] = await db.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ scopeType: "area", scopeId: AREA_KEY, params: { areaKey: AREA_KEY } });
      expect(inserted).toEqual([
        { queue: "seed.tile", data: { key: COAST_1, tileId: COAST_1, runId: id, stage: "seed.tile" } },
      ]);
    }));
});
