import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { runs, subdivisions } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { LAND_STAGE } from "@/lib/pipeline/gazetteer/land";
import { GAZETTEER_STAGES, startLandRun } from "@/lib/pipeline/gazetteer/stages";
import { afterBuildRunEnded, queueCountry, startSubdivisionBuild, SUBDIVISION_BUILD_STAGES } from "@/lib/pipeline/subdivision-build";
import { RunScopeNotReady, SEED_STAGE } from "@/lib/pipeline/tile-scope";
import { withRollback } from "@/test/db";
import { insertTestSubdivision } from "@/test/text";

/*
 * Subdivision builds and the country queue (spec 14, Review Focus 4), in withRollback with a recording job queue (no
 * worker): the end of a build is simulated by setting the run's status and calling `afterBuildRunEnded`, as the
 * worker's run-ended hook does.
 */

function recordingBoss() {
  const inserted: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const boss = {
    insert: async (queue: string, jobs: Array<{ id?: string; data: Record<string, unknown> }>) => {
      inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
      return jobs.map((j) => j.id ?? newId());
    },
  } as unknown as PgBoss;
  return { boss, inserted };
}

const box = (i: number): [number, number, number, number] => [40 + i * 0.5, 30.0, 40.5 + i * 0.5, 30.25];

const buildRuns = (tx: Db, key: string) =>
  tx.select().from(runs).where(and(eq(runs.kind, "full"), eq(runs.scopeType, "subdivision"), eq(runs.scopeId, key)));

const subdivision = async (tx: Db, key: string) => (await tx.select().from(subdivisions).where(eq(subdivisions.key, key)))[0]!;

describe("SUBDIVISION_BUILD_STAGES", () => {
  it("starts with the gazetteer stages", () => {
    expect(SUBDIVISION_BUILD_STAGES.slice(0, GAZETTEER_STAGES.length)).toEqual([...GAZETTEER_STAGES]);
  });

  it("has areas.import after geometry, then mentions.reread (Reviere of this build count in its prepass), then discovery.area", () => {
    const stages: readonly string[] = SUBDIVISION_BUILD_STAGES;
    const i = stages.indexOf("areas.import");
    expect(i).toBeGreaterThan(stages.indexOf("geometry.compute"));
    expect(stages.indexOf("mentions.reread")).toBe(i + 1);
    expect(stages.indexOf("discovery.area")).toBe(i + 2);
  });
});

describe("stage gazetteer.land", () => {
  it("runs in the build directly after seed.tile", () => {
    const stages: readonly string[] = SUBDIVISION_BUILD_STAGES;
    expect(LAND_STAGE).toBe("gazetteer.land");
    expect(stages.indexOf(LAND_STAGE)).toBe(stages.indexOf(SEED_STAGE) + 1);
  });

  it("startLandRun refuses a subdivision without candidates before the run exists", () =>
    withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      await insertTestSubdivision(tx, "XQ-L1", box(0), { country: "XQ" });
      const started = startLandRun(tx, boss, { subdivisionKey: "XQ-L1" }, "a@test.invalid");
      await expect(started).rejects.toBeInstanceOf(RunScopeNotReady);
      await expect(started).rejects.toMatchObject({ reason: "subdivision_without_candidates" });
      expect(inserted).toEqual([]);
      expect(await tx.select().from(runs).where(eq(runs.scopeId, "XQ-L1"))).toEqual([]);
    }));
});

describe("startSubdivisionBuild", () => {
  it("starts one full run with the build stages and plans its first stage", () =>
    withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      await insertTestSubdivision(tx, "XQ-1", box(0), { country: "XQ" });
      const started = await startSubdivisionBuild(tx, boss, "XQ-1", "admin@test.invalid");
      expect(started).toEqual({ id: expect.any(String) });
      const [run] = await buildRuns(tx, "XQ-1");
      expect(run).toMatchObject({ kind: "full", stages: [...SUBDIVISION_BUILD_STAGES], params: expect.objectContaining({ subdivisionKey: "XQ-1", subdivisionBuild: true }) });
      expect(SUBDIVISION_BUILD_STAGES.slice(0, 2)).toEqual(["tiles.ensure", "gazetteer.osm"]);
      expect(inserted.map((j) => j.queue)).toEqual(["tiles.ensure"]);
    }));

  it("startSubdivisionBuild twice returns alreadyRunning", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      await insertTestSubdivision(tx, "XQ-2", box(0), { country: "XQ" });
      const first = await startSubdivisionBuild(tx, boss, "XQ-2", "a@test.invalid");
      const second = await startSubdivisionBuild(tx, boss, "XQ-2", "a@test.invalid");
      expect(second).toEqual({ alreadyRunning: (first as { id: string }).id });
      expect(await buildRuns(tx, "XQ-2")).toHaveLength(1);
    }));

  it("excluded subdivision has no start action: the starter refuses it", () =>
    withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      await insertTestSubdivision(tx, "XQ-3", box(0), { country: "XQ", status: "excluded" });
      await expect(startSubdivisionBuild(tx, boss, "XQ-3", "a@test.invalid")).rejects.toThrow("Landesteil XQ-3 ist ausgeschlossen");
      expect(inserted).toEqual([]);
    }));
});

describe("queueCountry", () => {
  it("queueCountry twice queues nothing new and starts one build", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      for (const [i, key] of ["XQ-A", "XQ-B", "XQ-C"].entries()) await insertTestSubdivision(tx, key, box(i), { country: "XQ" });
      await insertTestSubdivision(tx, "XQ-X", box(3), { country: "XQ", status: "excluded" });
      const built = await insertTestSubdivision(tx, "XQ-Z", box(4), { country: "XQ" });
      await tx.update(subdivisions).set({ builtAt: sql`now()` }).where(eq(subdivisions.id, built.id));

      const first = await queueCountry(tx, boss, "XQ", "a@test.invalid");
      expect(first).toEqual({ queued: 3, started: expect.any(String) });
      const second = await queueCountry(tx, boss, "XQ", "a@test.invalid");
      expect(second).toEqual({ queued: 0, started: null });
      const started = (await tx.select().from(runs).where(eq(runs.id, first.started!)))[0]!;
      // the oldest queued one (same queued_at: by key) runs and left the queue; the others wait
      expect(started.scopeId).toBe("XQ-A");
      expect((await subdivision(tx, "XQ-A")).queuedAt).toBeNull();
      expect((await subdivision(tx, "XQ-B")).queuedAt).not.toBeNull();
      expect((await subdivision(tx, "XQ-X")).queuedAt).toBeNull();
      expect((await subdivision(tx, "XQ-Z")).queuedAt).toBeNull();
    }));

  it("failed build starts the next queued one; a finished one is built and starts the next", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      for (const [i, key] of ["XQ-A", "XQ-B", "XQ-C"].entries()) await insertTestSubdivision(tx, key, box(i), { country: "XQ" });
      const { started } = await queueCountry(tx, boss, "XQ", "a@test.invalid");

      await tx.update(runs).set({ status: "failed", failureReason: "stage tiles.ensure failed completely" }).where(eq(runs.id, started!));
      await afterBuildRunEnded(tx, boss, started!);
      expect((await subdivision(tx, "XQ-A")).builtAt).toBeNull();
      const [b] = await buildRuns(tx, "XQ-B");
      expect(b?.status).toBe("running");
      expect((await subdivision(tx, "XQ-B")).queuedAt).toBeNull();

      await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, b!.id));
      await afterBuildRunEnded(tx, boss, b!.id);
      expect((await subdivision(tx, "XQ-B")).builtAt).not.toBeNull();
      expect(await buildRuns(tx, "XQ-C")).toHaveLength(1);
      // another country's queue is not touched, and a run that is no build does nothing
      const { id: other } = (await tx.insert(runs).values({ kind: "stage", scopeType: "subdivision", scopeId: "XQ-C", triggeredBy: "t", status: "finished" }).returning({ id: runs.id }))[0]!;
      await afterBuildRunEnded(tx, boss, other);
      expect(await buildRuns(tx, "XQ-C")).toHaveLength(1);
    }));
});
