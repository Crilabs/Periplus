import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { externalCalls } from "@/lib/db/schema";
import { beginStage, createRun, getRun, listRuns, recordJobOutcome } from "@/lib/domain/runs";

const db = testDb();

async function newRun(stages: string[]) {
  return createRun(db, {
    kind: "full",
    scope: { type: "tile", id: `tile-${Math.random()}` },
    stages,
    params: { a: 1 },
    triggeredBy: "test",
  });
}

describe("runs", () => {
  it("creates pending stages with ordinals and a queued run", async () => {
    const { id } = await newRun(["a", "b"]);
    const run = await getRun(db, id);
    expect(run).toMatchObject({ id, kind: "full", status: "queued", triggeredBy: "test", startedAt: null, costEur: 0 });
    expect(run!.scope.type).toBe("tile");
    expect(run!.stages).toMatchObject([
      { stage: "a", ordinal: 0, total: 0, done: 0, failed: 0, status: "pending" },
      { stage: "b", ordinal: 1, status: "pending" },
    ]);
  });

  it("returns null for an unknown run", async () => {
    expect(await getRun(db, "00000000-0000-7000-8000-000000000000")).toBeNull();
  });

  it("finishes a two-stage run only after both stages complete", async () => {
    const { id } = await newRun(["a", "b"]);
    await beginStage(db, id, "a", 2);
    expect((await getRun(db, id))!.status).toBe("running");
    expect((await getRun(db, id))!.startedAt).toBeInstanceOf(Date);

    expect(await recordJobOutcome(db, id, "a", "done")).toEqual({ stageFinished: false, nextStage: null, runFinished: false });
    expect(await recordJobOutcome(db, id, "a", "failed")).toEqual({ stageFinished: true, nextStage: "b", runFinished: false });
    expect((await getRun(db, id))!.status).toBe("running");

    await beginStage(db, id, "b", 1);
    expect(await recordJobOutcome(db, id, "b", "done")).toEqual({ stageFinished: true, nextStage: null, runFinished: true });
    const run = (await getRun(db, id))!;
    expect(run.status).toBe("finished");
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.stages.map((s) => s.status)).toEqual(["finished", "finished"]);
  });

  it("marks the run failed when every job of the last stage failed", async () => {
    const { id } = await newRun(["a"]);
    await beginStage(db, id, "a", 2);
    await recordJobOutcome(db, id, "a", "failed");
    expect(await recordJobOutcome(db, id, "a", "failed")).toMatchObject({ runFinished: true });
    expect((await getRun(db, id))!.status).toBe("failed");
  });

  it("counts concurrent outcomes exactly and reports completion once", async () => {
    const { id } = await newRun(["ping"]);
    await beginStage(db, id, "ping", 20);
    const results = await Promise.all(Array.from({ length: 20 }, () => recordJobOutcome(db, id, "ping", "done")));
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ done: 20, failed: 0, status: "finished" });
    expect(results.filter((r) => r.stageFinished)).toHaveLength(1);
    expect(results.filter((r) => r.runFinished)).toHaveLength(1);
  });

  it("a stage with total 0 is finished at once and reports the next stage", async () => {
    const { id } = await newRun(["a", "b"]);
    expect(await beginStage(db, id, "a", 0)).toEqual({ stageFinished: true, nextStage: "b", runFinished: false });
    const run = (await getRun(db, id))!;
    expect(run.status).toBe("running");
    expect(run.stages.map((s) => s.status)).toEqual(["finished", "pending"]);
    expect(await beginStage(db, id, "b", 0)).toEqual({ stageFinished: true, nextStage: null, runFinished: true });
    expect((await getRun(db, id))!.status).toBe("finished");
  });

  it("rejects an outcome for a stage that is not running", async () => {
    const { id } = await newRun(["a"]);
    await expect(recordJobOutcome(db, id, "a", "done")).rejects.toThrow(/not running/);
  });

  it("sums external call costs into costEur", async () => {
    const { id } = await newRun(["a"]);
    await db.insert(externalCalls).values([
      { service: "t", operation: "x", units: "1", unit: "call", costEur: "0.10", runId: id },
      { service: "t", operation: "x", units: "1", unit: "call", costEur: "0.25", runId: id },
    ]);
    expect((await getRun(db, id))!.costEur).toBeCloseTo(0.35, 6);
  });

  it("lists runs newest first with cursor paging", async () => {
    const a = await newRun(["a"]);
    const b = await newRun(["a"]);
    const page = (await listRuns(db, { limit: 500 })).map((r) => r.id);
    expect(page.indexOf(b.id)).toBeLessThan(page.indexOf(a.id));
    const next = await listRuns(db, { limit: 1, before: b.id });
    expect(next).toHaveLength(1);
    expect(next[0].id < b.id).toBe(true);
  });
});
