
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { comparisonSet, runs, subdivisions, tileGeoObjects } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { createRun, getRun } from "@/lib/domain/runs";
import { consolidationTargets } from "@/lib/domain/consolidation/targets";
import { tileIdFor } from "@/lib/domain/tiles";
import { startConsolidationRun } from "@/lib/pipeline/consolidation/run";
import { endRunByAdmin } from "@/lib/pipeline/runs";
import { CHECK_STAGE } from "@/lib/pipeline/text/check";
import { CONSOLIDATION_GEO_STAGE, CONSOLIDATION_STAGES } from "@/lib/pipeline/consolidation/stages";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { insertMention, insertPlace, insertSource } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestSubdivision, insertTestTile } from "@/test/text";

/*
 * Consolidation runs (plan Task 16): the stage functions called directly in withRollback (no worker), objects on the
 * synthetic grid at 20.6° E / 34.6° N outside the pilot box, assertions only on the test's own rows.
 */

const LON = 20.62;
const LAT = 34.62;
const TILE = tileIdFor(LON, LAT);
/** A subdivision around TILE and its eastern neighbour (both tiles inside the polygon). */
const insertSubdivision = (tx: Db) => insertTestSubdivision(tx, `XT-${newId()}`, [20.3, 34.4, 21.2, 34.9]);

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

/** The UTC date of the transaction (the run date of a run created now). */
async function utcToday(tx: Db): Promise<string> {
  const { rows } = await tx.execute<{ d: string }>(sql`select (now() at time zone 'UTC')::date::text as d`);
  return rows[0]!.d;
}

/** A run row with `params` (a text run when they carry `documentVersionIds`). */
async function runRow(tx: Db, params: Record<string, unknown>, stages: string[] = [...CONSOLIDATION_STAGES]): Promise<string> {
  const [row] = await tx
    .insert(runs)
    .values({ kind: "stage", scopeType: "system", scopeId: "texts", stages, params, triggeredBy: "test" })
    .returning({ id: runs.id });
  return row!.id;
}

describe("consolidation run", () => {

  it("the starter refuses an unknown tile, an object without facts and an empty comparison set before the run exists", () =>
    withRollback(async (tx) => {
      const rec = recordingBoss();
      const settlement = await insertNamedObject(tx, { type: "settlement", names: [{ name: "Dorf" }], lon: LON, lat: LAT });
      const refused = async (scope: Parameters<typeof startConsolidationRun>[2]["scope"]) => {
        const e = await tx.transaction((t) => startConsolidationRun(t, rec.boss, { scope, triggeredBy: "refused" })).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(RunScopeNotReady);
        return (e as RunScopeNotReady).reason;
      };
      expect(await refused({ tileId: tileIdFor(LON + 2, LAT) })).toBe("unknown_tile");
      expect(await refused({ geoObjectIds: [settlement] })).toBe("geo_object_not_consolidatable");
      // an unknown subdivision and a leftover area key name what to use instead (requireSubdivision)
      const notStarted = (scope: Parameters<typeof startConsolidationRun>[2]["scope"]) =>
        tx.transaction((t) => startConsolidationRun(t, rec.boss, { scope, triggeredBy: "refused" }));
      await expect(notStarted({ subdivisionKey: "nowhere" })).rejects.toThrow("Unbekannter Landesteil nowhere");
      await expect(notStarted({ subdivisionKey: "saronic" })).rejects.toThrow("Revier-Schlüssel saronic ist kein Laufumfang mehr; Landesteil angeben (z. B. GR-I)");
      await expect(notStarted({ comparisonSetSubdivision: "saronic" })).rejects.toThrow("Revier-Schlüssel saronic ist kein Laufumfang mehr");
      const sub = await insertSubdivision(tx);
      const key = (await tx.select({ key: subdivisions.key }).from(subdivisions).where(eq(subdivisions.id, sub.id)))[0]!.key;
      expect(await refused({ subdivisionKey: key })).toBe("subdivision_without_coast_tiles");
      expect(await refused({ comparisonSetSubdivision: key })).toBe("comparison_set_empty");
      expect(await tx.select().from(runs).where(eq(runs.triggeredBy, "refused"))).toEqual([]);
    }));

  it("an evaluation run refuses stagesOnly instead of dropping it", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { lon: LON, lat: LAT, name: "Bewertungsbucht" });
      const rec = recordingBoss();
      const input = { scope: { geoObjectIds: [objectId] }, evaluation: true as const, stagesOnly: [CONSOLIDATION_GEO_STAGE], triggeredBy: "refused-eval" };
      await expect(tx.transaction((t) => startConsolidationRun(t, rec.boss, input))).rejects.toThrow("an evaluation run takes no stagesOnly");
      expect(await tx.select().from(runs).where(eq(runs.triggeredBy, "refused-eval"))).toEqual([]);
    }));

  it("tile, subdivision and comparison-set targets skip objects that take no facts, ended and merged ones", () =>
    withRollback(async (tx) => {
      const sub = await insertSubdivision(tx);
      const subdivisionKey = (await tx.select({ key: subdivisions.key }).from(subdivisions).where(eq(subdivisions.id, sub.id)))[0]!.key;
      await insertTestTile(tx, TILE);
      await tx.execute(sql`update tiles set has_coast = true where id = ${TILE}`);
      const inland = tileIdFor(LON + 0.25, LAT);
      await insertTestTile(tx, inland);
      await tx.execute(sql`update tiles set has_coast = false where id = ${inland}`);
      const bay = await insertPlace(tx, { lon: LON, lat: LAT, name: "Zielbucht" });
      await tx.insert(tileGeoObjects).values({ tileId: TILE, geoObjectId: bay.objectId });
      const island = await insertNamedObject(tx, { type: "island", names: [{ name: "Zielinsel" }], lon: LON, lat: LAT, tiles: [TILE] });
      const village = await insertNamedObject(tx, { type: "settlement", names: [{ name: "Zieldorf" }], lon: LON, lat: LAT, tiles: [TILE] });
      const merged = await insertNamedObject(tx, { type: "island", names: [{ name: "Altziel" }], lon: LON, lat: LAT, tiles: [TILE] });
      await tx.execute(sql`update geo_objects set merged_into_id = ${island} where id = ${merged}`);
      const inlandIsland = await insertNamedObject(tx, { type: "island", names: [{ name: "Binnenziel" }], lon: LON + 0.3, lat: LAT, tiles: [inland] });

      const today = await utcToday(tx);
      const targets = (params: Record<string, unknown>) => consolidationTargets(tx, { id: newId(), params }, today);
      expect(await targets({ tileId: TILE })).toEqual([bay.objectId, island].sort());
      // the subdivision: the objects of the valid coast tiles of its run scope only (not the inland tile's island, nor the settlement)
      expect(await targets({ subdivisionKey })).toEqual([bay.objectId, island].sort());
      await tx.execute(sql`update tiles set has_coast = true where id = ${inland}`);
      expect(await targets({ subdivisionKey })).toEqual([bay.objectId, island, inlandIsland].sort());
      await tx.execute(sql`update tiles set valid_from = '2020-01-01', valid_to = '2021-01-01' where id = ${inland}`);
      expect(await targets({ subdivisionKey })).toEqual([bay.objectId, island].sort());
      expect(await targets({ subdivisionKey })).not.toContain(village);

      // the comparison set: an ended place and a merged object drop out
      const ended = await insertPlace(tx, { lon: LON, lat: LAT, name: "Endbucht" });
      const gone = await insertPlace(tx, { lon: LON, lat: LAT, name: "Weg" });
      for (const placeId of [bay.placeId, ended.placeId, gone.placeId]) await tx.insert(comparisonSet).values({ placeId, subdivisionId: sub.id, addedBy: "test" });
      await tx.execute(sql`update places set valid_from = '2020-01-01', valid_to = '2021-01-01' where id = ${ended.placeId}`);
      await tx.execute(sql`update geo_objects set merged_into_id = ${bay.objectId} where id = ${gone.objectId}`);
      expect(await targets({ comparisonSetSubdivision: subdivisionKey })).toEqual([bay.objectId]);
    }));

  it("targets judge validity on the run date, not the database date (final review M-7)", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE);
      const bay = await insertPlace(tx, { lon: LON, lat: LAT, name: "Altlaufbucht" });
      await tx.insert(tileGeoObjects).values({ tileId: TILE, geoObjectId: bay.objectId });
      // tile and object were valid in 2020 only; the run was created then (e.g. revived much later)
      await tx.execute(sql`update tiles set valid_from = '2020-01-01', valid_to = '2021-01-01' where id = ${TILE}`);
      await tx.execute(sql`update geo_objects set valid_from = '2020-01-01', valid_to = '2021-01-01' where id = ${bay.objectId}`);
      const [run] = await tx
        .insert(runs)
        .values({ kind: "stage", scopeType: "tile", scopeId: TILE, stages: [...CONSOLIDATION_STAGES], params: { tileId: TILE }, triggeredBy: "test", createdAt: new Date("2020-06-01T12:00:00Z") })
        .returning({ id: runs.id });
      expect(await consolidationTargets(tx, { id: run!.id, params: { tileId: TILE } })).toEqual([bay.objectId]);
      expect(await consolidationTargets(tx, { id: run!.id, params: { tileId: TILE } }, await utcToday(tx))).toEqual([]);
    }));

  it("a text run finds its mentions through its frozen versions; facts of its extraction runs are indexed", () =>
    withRollback(async (tx) => {
      const textRun = await runRow(tx, { documentVersionIds: [] });
      const outside = await insertPlace(tx, { lon: LON, lat: LAT, name: "Außenbucht" });
      // a mention with the run's id in a version the run did not freeze is no target (and never read by run id alone)
      await insertMention(tx, outside.objectId, { sourceId: await insertSource(tx), runId: textRun });
      expect(await consolidationTargets(tx, { id: textRun, params: { documentVersionIds: [] } })).toEqual([]);
      const { rows } = await tx.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where indexname = 'facts_extraction_run_id_idx'`);
      expect(rows[0]?.indexdef).toContain("(extraction_run_id)");
    }));

  it("a run ended by hand before its consolidation is marked skipped; one that consolidated already is not", () =>
    withRollback(async (tx) => {
      const boss = { findJobs: async () => [], cancel: async () => undefined } as unknown as PgBoss;
      const stages = [CHECK_STAGE, ...CONSOLIDATION_STAGES];
      const { id: early } = await createRun(tx, { kind: "stage", scope: { type: "system", id: "texts" }, stages, params: { documentVersionIds: [] }, triggeredBy: "test" });
      await endRunByAdmin(tx, boss, early, "admin@example.invalid");
      expect((await getRun(tx, early))!.consolidationSkip?.reason).toBe("run_ended");
      const { id: late } = await createRun(tx, { kind: "stage", scope: { type: "system", id: "texts" }, stages, params: { documentVersionIds: [] }, triggeredBy: "test" });
      await tx.execute(sql`update run_stages set status = 'finished' where run_id = ${late} and stage = ${CONSOLIDATION_GEO_STAGE}`);
      await endRunByAdmin(tx, boss, late, "admin@example.invalid");
      expect((await getRun(tx, late))!.consolidationSkip).toBeNull();
    }));
});
