import { and, eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { profiles, reviewTasks, runs } from "@/lib/db/schema";
import { STAGES } from "@/lib/jobs/stages";
import { GEOMETRY_RUN_STAGES } from "@/lib/pipeline/geometry-run";
import { consolidateGeoJob } from "@/lib/pipeline/consolidation/geo";
import { openHighlightPairTasks } from "@/lib/pipeline/consolidation/highlights";
import { CONSOLIDATION_GEO_STAGE, CONSOLIDATION_HIGHLIGHTS_STAGE, CONSOLIDATION_STAGES, CONSOLIDATION_SUMMARY_STAGE } from "@/lib/pipeline/consolidation/stages";
import { summaryTargets } from "@/lib/pipeline/consolidation/summary";
import { consolidateAfter } from "@/lib/pipeline/follow-ups";
import { TEXT_RUN_STAGES } from "@/lib/pipeline/text/run";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertNamedObject } from "@/test/text";

/*
 * Stage `consolidation.highlights` (spec 16): after `consolidation.geo` it consolidates the POIs the run's places
 * selected, and opens pair tasks among selected highlights with similar names. Objects on a synthetic spot far from
 * the pilot box and the other tests' objects; the stage functions are called directly (no worker).
 */

const LON = -143.1;
const LAT = -47.4;
const LAT_PER_KM = 1 / 111.1;

const culture = (tx: Db, name: string, km: number) =>
  insertNamedObject(tx, { type: "poi", category: "culture", names: [{ name }], lon: LON, lat: LAT + km * LAT_PER_KM });

/** A consolidation run row over `geoObjectIds` with every consolidation stage. */
async function runOver(tx: Db, geoObjectIds: string[], extra: Record<string, unknown> = {}): Promise<{ id: string; params: Record<string, unknown> }> {
  const params = { geoObjectIds: [...geoObjectIds].sort(), ...extra };
  const [row] = await tx
    .insert(runs)
    .values({ kind: "stage", scopeType: "system", scopeId: "consolidation", stages: [...CONSOLIDATION_STAGES], params, triggeredBy: "test" })
    .returning({ id: runs.id });
  return { id: row!.id, params };
}

/** Plans `stage` for the run and runs every planned job (`consolidateGeoJob`); returns the planned object ids. */
async function runStage(tx: Db, run: { id: string; params: Record<string, unknown> }, stage: string): Promise<string[]> {
  const jobs = await STAGES[stage]!.plan(tx, run);
  for (const job of jobs) await consolidateGeoJob(tx, { ...job, runId: run.id, stage });
  return jobs.map((j) => j.geoObjectId as string);
}

const profileIds = async (tx: Db, ids: string[]) =>
  (await tx.select({ id: profiles.geoObjectId }).from(profiles).where(inArray(profiles.geoObjectId, ids))).map((r) => r.id);

const pairTasks = (tx: Db, a: string, b: string) =>
  tx
    .select({ id: reviewTasks.id, context: reviewTasks.context })
    .from(reviewTasks)
    .where(and(eq(reviewTasks.kind, "place_candidate"), eq(reviewTasks.subjectId, [a, b].sort().join(":"))));

function recordingBoss() {
  const boss = { insert: async (_queue: string, jobs: Array<{ id: string }>) => jobs.map((j) => j.id) } as unknown as PgBoss;
  return async () => boss;
}

describe("stage consolidation.highlights (spec 16)", () => {
  it("the stage consolidates exactly the POIs selected by the run's places", () =>
    withRollback(async (tx) => {
      const bay = await insertPlace(tx, { lon: LON, lat: LAT, name: "Highlightbucht" });
      const castle = await culture(tx, "Kastro", 0.3);
      const monastery = await culture(tx, "Moni", 0.6);
      const run = await runOver(tx, [bay.objectId]);

      expect(await runStage(tx, run, CONSOLIDATION_GEO_STAGE)).toEqual([bay.objectId]);
      expect(await runStage(tx, run, CONSOLIDATION_HIGHLIGHTS_STAGE)).toEqual([castle, monastery].sort());
      const written = await tx.select({ id: profiles.geoObjectId, runId: profiles.runId }).from(profiles).where(inArray(profiles.geoObjectId, [castle, monastery]));
      expect(written.map((p) => p.id).sort()).toEqual([castle, monastery].sort());
      expect(written.every((p) => p.runId === run.id)).toBe(true);
      // the summary stage after it summarizes the selected highlights too
      expect((await summaryTargets(tx, run)).map((t) => t.geoObjectId).sort()).toEqual([bay.objectId, castle, monastery].sort());
    }));

  it("an unselected POI gets no profile", () =>
    withRollback(async (tx) => {
      const bay = await insertPlace(tx, { lon: LON, lat: LAT, name: "Highlightbucht" });
      const castle = await culture(tx, "Kastro", 0.3);
      const far = await culture(tx, "Weit weg", 30);
      const run = await runOver(tx, [bay.objectId]);
      await runStage(tx, run, CONSOLIDATION_GEO_STAGE);
      expect(await runStage(tx, run, CONSOLIDATION_HIGHLIGHTS_STAGE)).toEqual([castle]);
      expect(await profileIds(tx, [far])).toEqual([]);

      // a POI an explicit run consolidated in the geo stage is not consolidated again; unselected, it gets no summary
      const direct = await runOver(tx, [bay.objectId, castle, far]);
      expect((await runStage(tx, direct, CONSOLIDATION_GEO_STAGE)).sort()).toEqual([bay.objectId, castle, far].sort());
      expect(await runStage(tx, direct, CONSOLIDATION_HIGHLIGHTS_STAGE)).toEqual([]);
      const summarized = (await summaryTargets(tx, direct)).map((t) => t.geoObjectId);
      expect(summarized).not.toContain(far);
      // and a summary run started for it („Zusammenfassung neu erzeugen“) has nothing to do
      const regenerate = await runOver(tx, [far], { stagesOnly: [CONSOLIDATION_SUMMARY_STAGE], regenerateSummary: true });
      expect(await summaryTargets(tx, regenerate)).toEqual([]);
    }));

  it("two selected highlights 'Kastro Poros' and 'Kastro Porou' 800 m apart get a pair task, two unselected do not", () =>
    withRollback(async (tx) => {
      const bay = await insertPlace(tx, { lon: LON, lat: LAT, name: "Paarbucht" });
      const a = await culture(tx, "Kastro Poros", 0.4);
      const b = await culture(tx, "Kastro Porou", -0.4);
      // the same pair far from every place: never selected
      const c = await culture(tx, "Kastro Poros", 40);
      const d = await culture(tx, "Kastro Porou", 40.8);

      // an evaluation run opens no pair task
      const evaluation = await runOver(tx, [bay.objectId]);
      await consolidateGeoJob(tx, { key: bay.objectId, geoObjectId: bay.objectId, runId: evaluation.id, stage: CONSOLIDATION_GEO_STAGE, mode: "regular" });
      await STAGES[CONSOLIDATION_HIGHLIGHTS_STAGE]!.plan(tx, { id: evaluation.id, params: { ...evaluation.params, evaluation: true } });
      expect(await pairTasks(tx, a, b)).toEqual([]);

      const run = await runOver(tx, [bay.objectId]);
      await runStage(tx, run, CONSOLIDATION_GEO_STAGE);
      expect(await runStage(tx, run, CONSOLIDATION_HIGHLIGHTS_STAGE)).toEqual([a, b].sort());
      const [task] = await pairTasks(tx, a, b);
      expect(task).toBeDefined();
      const context = task!.context as { similarity: number; distanceM: number; geoObjectIds: string[] };
      expect(context.geoObjectIds).toEqual([a, b].sort());
      expect(context.distanceM).toBeGreaterThan(700);
      expect(context.distanceM).toBeLessThan(900);
      expect(context.similarity).toBeGreaterThanOrEqual(0.5);

      expect(await openHighlightPairTasks(tx, [c, d])).toBe(0);
      expect(await pairTasks(tx, c, d)).toEqual([]);
    }));

  it("text, geometry and consolidateAfter runs list consolidation.highlights after consolidation.geo", () =>
    withRollback(async (tx) => {
      const after = (stages: readonly string[]) => stages[stages.indexOf(CONSOLIDATION_GEO_STAGE) + 1];
      expect(after(TEXT_RUN_STAGES)).toBe(CONSOLIDATION_HIGHLIGHTS_STAGE);
      expect(after(GEOMETRY_RUN_STAGES)).toBe(CONSOLIDATION_HIGHLIGHTS_STAGE);

      const bay = await insertPlace(tx, { lon: LON, lat: LAT, name: "Folgebucht" });
      const started = await consolidateAfter(tx, recordingBoss(), { geoObjectIds: [bay.objectId], triggeredBy: "test" });
      expect(started.status).toBe("started");
      const [row] = await tx.select({ stages: runs.stages }).from(runs).where(eq(runs.id, (started as { runId: string }).runId));
      expect(after(row!.stages as string[])).toBe(CONSOLIDATION_HIGHLIGHTS_STAGE);

      // a summary-only run stays without it
      const summary = await consolidateAfter(tx, recordingBoss(), { geoObjectIds: [bay.objectId], stagesOnly: [CONSOLIDATION_SUMMARY_STAGE], triggeredBy: "test" });
      const [only] = await tx.select({ stages: runs.stages }).from(runs).where(eq(runs.id, (summary as { runId: string }).runId));
      expect(only!.stages).toEqual([CONSOLIDATION_SUMMARY_STAGE]);
    }));
});
