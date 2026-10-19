import { eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { areaByKey } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { changeEvents, comparisonSet, evaluationProfiles, extractionRuns, extractionUnits, profiles, runs, tileGeoObjects } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { consolidationBlocked, consolidationTargets } from "@/lib/domain/consolidation/targets";
import { syncAreas } from "@/lib/domain/gazetteer/areas";
import { tileIdFor } from "@/lib/domain/tiles";
import { STAGES } from "@/lib/jobs/stages";
import { consolidateGeoJob } from "@/lib/pipeline/consolidation/geo";
import { startConsolidationRun } from "@/lib/pipeline/consolidation/run";
import {
  CONSOLIDATION_FOLLOWUP_STAGE,
  CONSOLIDATION_GEO_STAGE,
  CONSOLIDATION_STAGES,
  CONSOLIDATION_SUMMARY_STAGE,
} from "@/lib/pipeline/consolidation/stages";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { insertExtraction, insertMention, insertMentionFact, insertPlace, insertSource } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestTile } from "@/test/text";

/*
 * Consolidation runs (plan Task 16): the stage functions called directly in withRollback (no worker), objects on the
 * synthetic grid at 20.6° E / 34.6° N outside the pilot box, assertions only on the test's own rows.
 */

const LON = 20.62;
const LAT = 34.62;
const TILE = tileIdFor(LON, LAT);

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

/** A run row with `params` (a text run when they carry `documentVersionIds`). */
async function runRow(tx: Db, params: Record<string, unknown>, stages: string[] = [...CONSOLIDATION_STAGES]): Promise<string> {
  const [row] = await tx
    .insert(runs)
    .values({ kind: "stage", scopeType: "system", scopeId: "texts", stages, params, triggeredBy: "test" })
    .returning({ id: runs.id });
  return row!.id;
}

/** The fact extraction run of `runId` (one per run, task and model). */
const extractionRunOf = new Map<string, string>();

/** A place with one text fact (holding good) of the fact extraction run of `runId`. */
async function placeWithFact(tx: Db, name: string, runId: string): Promise<{ objectId: string; versionId: string }> {
  const { objectId } = await insertPlace(tx, { lon: LON, lat: LAT, name });
  const m = await insertMention(tx, objectId, { sourceId: await insertSource(tx) });
  let extractionRunId = extractionRunOf.get(runId);
  if (extractionRunId) {
    await tx.insert(extractionUnits).values({ extractionRunId, documentVersionId: m.versionId, geoObjectId: objectId, part: 0, level: "place", mentionIds: [m.mentionId], chunkIds: [m.chunkId], status: "done" });
  } else {
    extractionRunId = await insertExtraction(tx, objectId, m, { runId });
    extractionRunOf.set(runId, extractionRunId);
  }
  await insertMentionFact(tx, objectId, m, extractionRunId);
  return { objectId, versionId: m.versionId };
}

/** Plans `consolidation.geo` for the run and runs every planned job; returns the planned object ids. */
async function consolidateRun(tx: Db, runId: string): Promise<string[]> {
  const [run] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, runId));
  const jobs = await STAGES[CONSOLIDATION_GEO_STAGE]!.plan(tx, { id: runId, params: run!.params as Record<string, unknown> });
  for (const job of jobs) await consolidateGeoJob(tx, { ...job, runId, stage: CONSOLIDATION_GEO_STAGE });
  return jobs.map((j) => j.geoObjectId as string);
}

const profileRuns = (tx: Db, ids: string[]) =>
  tx.select({ geoObjectId: profiles.geoObjectId, runId: profiles.runId }).from(profiles).where(inArray(profiles.geoObjectId, ids));

describe("consolidation run", () => {
  it("a text run consolidates exactly the objects it extracted facts for", () =>
    withRollback(async (tx) => {
      const textRun = await runRow(tx, { documentVersionIds: [] });
      const otherRun = await runRow(tx, { documentVersionIds: [] });
      const own = await placeWithFact(tx, "Eigenbucht", textRun);
      const foreign = await placeWithFact(tx, "Fremdbucht", otherRun);
      // an object the run only mentioned (its mention stage wrote the mention) is consolidated too
      const mentioned = await insertPlace(tx, { lon: LON, lat: LAT, name: "Erwähntbucht" });
      await insertMention(tx, mentioned.objectId, { sourceId: await insertSource(tx), runId: textRun });
      // the run's own tile in its params only selected its versions
      await tx.update(runs).set({ params: { documentVersionIds: [own.versionId], tileId: TILE } }).where(eq(runs.id, textRun));

      expect(await consolidateRun(tx, textRun)).toEqual([own.objectId, mentioned.objectId].sort());
      const written = await profileRuns(tx, [own.objectId, foreign.objectId, mentioned.objectId]);
      expect(written.map((p) => p.geoObjectId).sort()).toEqual([own.objectId, mentioned.objectId].sort());
      expect(written.every((p) => p.runId === textRun)).toBe(true);
    }));

  it("a text run with blocked quote fidelity consolidates nothing", () =>
    withRollback(async (tx) => {
      const textRun = await runRow(tx, { documentVersionIds: [] });
      const good = await placeWithFact(tx, "Gutbucht", textRun);
      await placeWithFact(tx, "Schlechtbucht", textRun);
      // the check found one of the two quotes not in its chunk (the run is blocked)
      const failure = { factId: newId(), kind: "fact", reason: "not_found" };
      await tx
        .update(extractionRuns)
        .set({ status: "blocked", blockedReason: "quote_fidelity", quoteCheck: { facts: 2, verified: 1, ratio: 0.5, failures: [failure] } })
        .where(eq(extractionRuns.runId, textRun));
      expect(await consolidationBlocked(tx, textRun)).toBe(true);
      expect(await consolidateRun(tx, textRun)).toEqual([]);
      expect(await profileRuns(tx, [good.objectId])).toEqual([]);
      expect(await STAGES[CONSOLIDATION_FOLLOWUP_STAGE]!.plan(tx, { id: textRun, params: { documentVersionIds: [] } })).toEqual([]);
      // a run without extraction runs is never blocked
      expect(await consolidationBlocked(tx, await runRow(tx, { geoObjectIds: [good.objectId] }))).toBe(false);
    }));

  it("tile scope plans every valid object of the tile once", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, TILE);
      const a = await insertPlace(tx, { lon: LON, lat: LAT, name: "Kachelbucht" });
      const island = await insertNamedObject(tx, { type: "island", names: [{ name: "Kachelinsel" }], lon: LON, lat: LAT, tiles: [TILE] });
      const ended = await insertNamedObject(tx, { type: "island", names: [{ name: "Altinsel" }], lon: LON, lat: LAT, tiles: [TILE] });
      await tx.execute(sql`update geo_objects set valid_from = '2020-01-01', valid_to = '2021-01-01' where id = ${ended}`);
      await tx.insert(tileGeoObjects).values({ tileId: TILE, geoObjectId: a.objectId });
      const elsewhere = await insertNamedObject(tx, { type: "island", names: [{ name: "Fernsel" }], lon: LON + 1, lat: LAT, tiles: [] });

      const rec = recordingBoss();
      const { id } = await startConsolidationRun(tx, rec.boss, { scope: { tileId: TILE }, triggeredBy: "test" });
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ kind: "stage", scopeType: "tile", scopeId: TILE, stages: [...CONSOLIDATION_STAGES], params: { tileId: TILE } });
      const planned = rec.inserted.filter((j) => j.queue === "consolidation.geo").map((j) => j.data.geoObjectId);
      expect(planned).toEqual([a.objectId, island].sort());
      expect(planned).not.toContain(ended);
      expect(planned).not.toContain(elsewhere);
      expect(rec.inserted.every((j) => j.data.mode === "regular")).toBe(true);
    }));

  it("an evaluation run over the comparison set writes evaluation profiles only", () =>
    withRollback(async (tx) => {
      const areaId = (await syncAreas(tx, [areaByKey("saronic")])).get("saronic")!;
      const textRun = await runRow(tx, { documentVersionIds: [] });
      const inSet = await placeWithFact(tx, "Vergleichsbucht", textRun);
      const [p] = await tx.execute<{ id: string }>(sql`select id from places where geo_object_id = ${inSet.objectId}`).then((r) => r.rows);
      await tx.insert(comparisonSet).values({ placeId: p!.id, areaId, addedBy: "test" });

      const rec = recordingBoss();
      const { id } = await startConsolidationRun(tx, rec.boss, { scope: { comparisonSetArea: "saronic" }, evaluation: true, triggeredBy: "test" });
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ kind: "reprocess", scopeType: "system", stages: [CONSOLIDATION_GEO_STAGE], params: { comparisonSetArea: "saronic", evaluation: true, rulesVersion: "v1" } });
      expect(await consolidationTargets(tx, { id, params: run!.params as Record<string, unknown> })).toEqual([inSet.objectId]);
      expect(rec.inserted.map((j) => [j.queue, j.data.geoObjectId, j.data.mode, j.data.rulesVersion])).toEqual([["consolidation.geo", inSet.objectId, "evaluation", "v1"]]);

      for (const job of rec.inserted) await consolidateGeoJob(tx, job.data as never);
      const evaluated = await tx.select().from(evaluationProfiles).where(eq(evaluationProfiles.runId, id));
      expect(evaluated.map((e) => [e.geoObjectId, e.rulesVersion])).toEqual([[inSet.objectId, "v1"]]);
      expect(evaluated[0]!.attributes).toMatchObject({ holding: "good" });
      expect(await profileRuns(tx, [inSet.objectId])).toEqual([]);
      expect(await tx.select().from(changeEvents).where(eq(changeEvents.geoObjectId, inSet.objectId))).toEqual([]);
    }));

  it("the place action starts a place-scoped run", () =>
    withRollback(async (tx) => {
      const { objectId, placeId } = await insertPlace(tx, { lon: LON, lat: LAT, name: "Ortsbucht" });
      const island = await insertNamedObject(tx, { type: "island", names: [{ name: "Ortsinsel" }], lon: LON, lat: LAT });
      const rec = recordingBoss();
      const one = await startConsolidationRun(tx, rec.boss, { scope: { geoObjectIds: [objectId] }, triggeredBy: "test" });
      const [run] = await tx.select().from(runs).where(eq(runs.id, one.id));
      expect(run).toMatchObject({ scopeType: "place", scopeId: placeId, params: { geoObjectIds: [objectId] }, stages: [...CONSOLIDATION_STAGES] });
      // several objects, or one without a place, are scope system
      const two = await startConsolidationRun(tx, rec.boss, { scope: { geoObjectIds: [island, objectId] }, triggeredBy: "test" });
      const [many] = await tx.select().from(runs).where(eq(runs.id, two.id));
      expect(many).toMatchObject({ scopeType: "system", scopeId: "consolidation", params: { geoObjectIds: [island, objectId].sort() } });
      // a summary-only run plans only its summary stage
      const summary = await startConsolidationRun(tx, rec.boss, { scope: { geoObjectIds: [objectId] }, stagesOnly: [CONSOLIDATION_SUMMARY_STAGE], triggeredBy: "test" });
      const [s] = await tx.select().from(runs).where(eq(runs.id, summary.id));
      expect(s).toMatchObject({ stages: [CONSOLIDATION_SUMMARY_STAGE], params: { geoObjectIds: [objectId], stagesOnly: [CONSOLIDATION_SUMMARY_STAGE] } });
    }));

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
      expect(await refused({ areaKey: "nowhere" })).toBe("unknown_area");
      await syncAreas(tx, [areaByKey("saronic")]);
      expect(await refused({ comparisonSetArea: "saronic" })).toBe("comparison_set_empty");
      expect(await tx.select().from(runs).where(eq(runs.triggeredBy, "refused"))).toEqual([]);
    }));
});
