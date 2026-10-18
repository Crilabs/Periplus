import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig, type AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { landPolygons, reviewDecisions, reviewTasks, tiles } from "@/lib/db/schema";
import { syncAreas } from "@/lib/domain/gazetteer/areas";
import { ensureTiles } from "@/lib/domain/gazetteer/tiles-ensure";
import { tileIdFor, tilesInBbox } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";

const PILOT_BOX: [number, number, number, number] = [23.0, 37.0, 23.75, 38.0];

// Outside the pilot box 23.0-23.75 E x 37.0-38.0 N. Its bbox covers four tiles; the triangle misses the
// north-east one (25.25-25.5 E x 35.25-35.5 N) entirely.
const testArea: AreaConfig = {
  key: "test-tiles-area",
  names: { de: "Testgolf", en: "Test Gulf", el: "Δοκιμαστικός Κόλπος" },
  polygon: { type: "Polygon", coordinates: [[[25.0, 35.0], [25.45, 35.0], [25.0, 35.45], [25.0, 35.0]]] },
  tileBbox: null,
  sourceLanguages: ["de", "en", "el"],
  season: { fromMonth: 4, toMonth: 10 },
  cycleDays: 14,
  coastSections: [],
};
const OUTSIDE_TILE = tileIdFor(25.3, 35.3);

async function addLand(db: Db, w: number, s: number, e: number, n: number) {
  await db.insert(landPolygons).values({
    geom: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`,
    datasetVersion: "test",
  });
}

async function tile(db: Db, id: string) {
  const [row] = await db.select().from(tiles).where(eq(tiles.id, id));
  return row;
}

async function tasksFor(db: Db, tileId: string) {
  return db
    .select()
    .from(reviewTasks)
    .where(and(eq(reviewTasks.kind, "coast_tile_without_area"), eq(reviewTasks.subjectId, tileId)));
}

async function decide(db: Db, taskId: string, decision: Record<string, unknown>) {
  await db.update(reviewTasks).set({ status: "decided" }).where(eq(reviewTasks.id, taskId));
  await db.insert(reviewDecisions).values({ taskId, decision, decidedBy: "test" });
}

async function setupTestArea(db: Db) {
  await addLand(db, 25.3, 35.3, 25.4, 35.4); // coast in the tile outside the triangle
  const ids = await syncAreas(db, [testArea]);
  return { ids, areaId: ids.get(testArea.key)! };
}

describe("ensureTiles", () => {
  it("creates the 12 pilot tiles labelled saronic", () =>
    withRollback(async (db) => {
      const ids = await syncAreas(db, getConfig().areas);
      const saronic = getConfig().areas.find((a) => a.key === "saronic")!;
      const r = await ensureTiles(db, saronic, ids);
      const pilot = tilesInBbox(PILOT_BOX);
      expect(pilot).toHaveLength(12);
      expect(r.tiles).toBeGreaterThanOrEqual(12);
      for (const id of pilot) {
        const t = await tile(db, id);
        expect(t, id).toBeDefined();
        expect(t!.areaId, id).toBe(ids.get("saronic"));
        expect(t!.cycleDays).toBe(saronic.cycleDays);
        expect(t!.validTo).toBeNull();
      }
      const [{ isBox }] = await db
        .execute<{ isBox: boolean }>(
          sql`SELECT ST_Equals(bbox, ST_MakeEnvelope(23.0, 37.0, 23.25, 37.25, 4326)) AS "isBox"
              FROM tiles WHERE id = ${tileIdFor(23.0, 37.0)}`,
        )
        .then((x) => x.rows);
      expect(isBox).toBe(true);
    }));

  it("has_coast follows land polygons", () =>
    withRollback(async (db) => {
      await addLand(db, 25.05, 35.05, 25.1, 35.1);
      const { ids } = await setupTestArea(db);
      const r = await ensureTiles(db, testArea, ids);
      expect(r.tiles).toBe(4);
      expect(r.coast).toBe(2);
      expect((await tile(db, tileIdFor(25.05, 35.05)))!.hasCoast).toBe(true);
      expect((await tile(db, OUTSIDE_TILE))!.hasCoast).toBe(true);
      expect((await tile(db, tileIdFor(25.3, 35.05)))!.hasCoast).toBe(false);
      expect((await tile(db, tileIdFor(25.05, 35.3)))!.hasCoast).toBe(false);
    }));

  it("a coast tile outside every area polygon opens one review task", () =>
    withRollback(async (db) => {
      const { ids, areaId } = await setupTestArea(db);
      const r = await ensureTiles(db, testArea, ids);
      expect(r.withoutArea).toBe(1);
      expect((await tile(db, OUTSIDE_TILE))!.areaId).toBeNull();
      expect((await tile(db, tileIdFor(25.05, 35.05)))!.areaId).toBe(areaId);
      const tasks = await tasksFor(db, OUTSIDE_TILE);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        status: "open",
        subjectType: "tile",
        context: { areaKey: testArea.key, candidates: [areaId] },
      });
    }));

  it("second run creates no tiles or tasks", () =>
    withRollback(async (db) => {
      const { ids } = await setupTestArea(db);
      await ensureTiles(db, testArea, ids);
      const testTiles = `{${tilesInBbox([25.0, 35.0, 25.45, 35.45]).join(",")}}`;
      const count = async () => {
        const [row] = await db
          .execute<{ t: number; k: number; h: number }>(
            sql`SELECT
                  (SELECT count(*)::int FROM tiles WHERE id = ANY(${testTiles}::text[])) AS t,
                  (SELECT count(*)::int FROM review_tasks WHERE subject_id = ANY(${testTiles}::text[])) AS k,
                  (SELECT count(*)::int FROM tiles_history WHERE row_id = ANY(${testTiles}::text[])) AS h`,
          )
          .then((x) => x.rows);
        return row;
      };
      const before = await count();
      expect(before).toEqual({ t: 4, k: 1, h: 0 });
      await ensureTiles(db, testArea, ids);
      expect(await count()).toEqual(before);
    }));

  it("a tile decided as no_area does not reopen", () =>
    withRollback(async (db) => {
      const { ids } = await setupTestArea(db);
      await ensureTiles(db, testArea, ids);
      const [task] = await tasksFor(db, OUTSIDE_TILE);
      await decide(db, task.id, { action: "no_area" });
      const r = await ensureTiles(db, testArea, ids);
      expect(r.withoutArea).toBe(1);
      const open = (await tasksFor(db, OUTSIDE_TILE)).filter((t) => t.status === "open");
      expect(open).toHaveLength(0);
    }));

  it("area_id set by review survives a rerun", () =>
    withRollback(async (db) => {
      const { ids, areaId } = await setupTestArea(db);
      await ensureTiles(db, testArea, ids);
      const [task] = await tasksFor(db, OUTSIDE_TILE);
      await decide(db, task.id, { action: "assign_area", areaId });
      await db.update(tiles).set({ areaId }).where(eq(tiles.id, OUTSIDE_TILE));
      const r = await ensureTiles(db, testArea, ids);
      expect(r.withoutArea).toBe(0);
      expect((await tile(db, OUTSIDE_TILE))!.areaId).toBe(areaId);
      expect((await tasksFor(db, OUTSIDE_TILE)).filter((t) => t.status === "open")).toHaveLength(0);
    }));
});
