import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { externalCalls } from "@/lib/db/schema";
import {
  beginStage,
  createRun,
  endRun,
  extendStage,
  failRun,
  getRun,
  listRuns,
  recordJobOutcome,
  resumeRun,
  stageAcceptsJobs,
} from "@/lib/domain/runs";

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
    expect(run).toMatchObject({
      id,
      kind: "full",
      status: "queued",
      triggeredBy: "test",
      startedAt: null,
      costEur: 0,
      failureReason: null,
    });
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

    expect(await recordJobOutcome(db, id, "a", "k1", "done")).toEqual({
      recorded: true,
      stageFinished: false,
      nextStage: null,
      runFinished: false,
    });
    expect(await recordJobOutcome(db, id, "a", "k2", "failed")).toEqual({
      recorded: true,
      stageFinished: true,
      nextStage: "b",
      runFinished: false,
    });
    expect((await getRun(db, id))!.status).toBe("running");

    await beginStage(db, id, "b", 1);
    expect(await recordJobOutcome(db, id, "b", "k1", "done")).toEqual({
      recorded: true,
      stageFinished: true,
      nextStage: null,
      runFinished: true,
    });
    const run = (await getRun(db, id))!;
    expect(run.status).toBe("finished");
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.stages.map((s) => s.status)).toEqual(["finished", "finished"]);
  });

  it("marks the run failed when every job of the last stage failed", async () => {
    const { id } = await newRun(["a"]);
    await beginStage(db, id, "a", 2);
    await recordJobOutcome(db, id, "a", "k1", "failed");
    expect(await recordJobOutcome(db, id, "a", "k2", "failed")).toMatchObject({ runFinished: true });
    expect((await getRun(db, id))!).toMatchObject({ status: "failed", failureReason: "stage a failed completely" });
  });

  it("a stage whose jobs all failed fails the run and reports no next stage", async () => {
    const { id } = await newRun(["a", "b"]);
    await beginStage(db, id, "a", 2);
    await recordJobOutcome(db, id, "a", "k1", "failed");
    expect(await recordJobOutcome(db, id, "a", "k2", "failed")).toEqual({
      recorded: true,
      stageFinished: true,
      nextStage: null,
      runFinished: true,
    });
    const run = (await getRun(db, id))!;
    expect(run).toMatchObject({ status: "failed", failureReason: "stage a failed completely" });
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.stages.map((s) => s.status)).toEqual(["finished", "pending"]);
  });

  it("a success in a stage that failed completely resumes the run and reports the next stage once", async () => {
    const { id } = await newRun(["a", "b"]);
    await beginStage(db, id, "a", 2);
    await recordJobOutcome(db, id, "a", "k1", "failed");
    await recordJobOutcome(db, id, "a", "k2", "failed");

    expect(await recordJobOutcome(db, id, "a", "k1", "done")).toEqual({
      recorded: true,
      stageFinished: false,
      nextStage: "b",
      runFinished: false,
    });
    expect((await getRun(db, id))!).toMatchObject({ status: "running", failureReason: null, finishedAt: null });
    // A second success in the same stage finds the run already running: no second transition.
    expect(await recordJobOutcome(db, id, "a", "k2", "done")).toEqual({
      recorded: true,
      stageFinished: false,
      nextStage: null,
      runFinished: false,
    });

    await beginStage(db, id, "b", 1);
    expect(await recordJobOutcome(db, id, "b", "k1", "done")).toMatchObject({ runFinished: true });
    expect((await getRun(db, id))!).toMatchObject({ status: "finished", failureReason: null });
  });

  it("counts concurrent outcomes exactly and reports completion once", async () => {
    const { id } = await newRun(["ping"]);
    await beginStage(db, id, "ping", 20);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => recordJobOutcome(db, id, "ping", String(i), "done")));
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

  it("a stage with total 1 extended by 2 finishes only after 3 outcomes", async () => {
    const { id } = await newRun(["crawl"]);
    await beginStage(db, id, "crawl", 1);
    await extendStage(db, id, "crawl", 2);
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ total: 3, status: "running" });
    expect(await recordJobOutcome(db, id, "crawl", "a", "done")).toMatchObject({ stageFinished: false });
    expect(await recordJobOutcome(db, id, "crawl", "b", "failed")).toMatchObject({ stageFinished: false });
    expect(await recordJobOutcome(db, id, "crawl", "c", "done")).toMatchObject({ stageFinished: true, runFinished: true });
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ total: 3, done: 2, failed: 1, status: "finished" });
  });

  it("extendStage refuses a stage that is not running; stageAcceptsJobs only for a running stage of an active run", async () => {
    const { id } = await newRun(["crawl"]);
    expect(await extendStage(db, id, "crawl", 1)).toBe(false);
    expect(await stageAcceptsJobs(db, id, "crawl")).toBe(false);
    await beginStage(db, id, "crawl", 1);
    expect(await stageAcceptsJobs(db, id, "crawl")).toBe(true);
    expect(await endRun(db, id, "admin@example.invalid")).toBe(true);
    expect(await stageAcceptsJobs(db, id, "crawl")).toBe(false);
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ total: 1, status: "running" });
  });

  it("rejects an outcome for a stage that is not running", async () => {
    const { id } = await newRun(["a"]);
    await expect(recordJobOutcome(db, id, "a", "k1", "done")).rejects.toThrow(/not running/);
  });

  it("recordJobOutcome counts each (stage, key) once", async () => {
    const { id } = await newRun(["ping"]);
    await beginStage(db, id, "ping", 2);
    expect((await recordJobOutcome(db, id, "ping", "a", "done")).recorded).toBe(true);
    expect(await recordJobOutcome(db, id, "ping", "a", "done")).toEqual({
      recorded: false,
      stageFinished: false,
      nextStage: null,
      runFinished: false,
    });
    expect((await recordJobOutcome(db, id, "ping", "a", "failed")).recorded).toBe(false);
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ done: 1, failed: 0, status: "running" });
  });

  it("counts concurrent outcomes for the same key once", async () => {
    const { id } = await newRun(["ping"]);
    await beginStage(db, id, "ping", 2);
    const results = await Promise.all(Array.from({ length: 5 }, () => recordJobOutcome(db, id, "ping", "a", "done")));
    expect(results.filter((r) => r.recorded)).toHaveLength(1);
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ done: 1, failed: 0, status: "running" });
  });

  it("a failed outcome flips to done on a later success without finishing anything twice", async () => {
    const { id } = await newRun(["ping"]);
    await beginStage(db, id, "ping", 1);
    expect(await recordJobOutcome(db, id, "ping", "a", "failed")).toEqual({
      recorded: true,
      stageFinished: true,
      nextStage: null,
      runFinished: true,
    });
    const failedRun = (await getRun(db, id))!;
    expect(failedRun.status).toBe("failed");

    expect(await recordJobOutcome(db, id, "ping", "a", "done")).toEqual({
      recorded: true,
      stageFinished: false,
      nextStage: null,
      runFinished: false,
    });
    const run = (await getRun(db, id))!;
    expect(run.stages[0]).toMatchObject({ done: 1, failed: 0, status: "finished" });
    // The last stage is no longer all-failed, so the run counts as finished; its end time stays.
    expect(run.status).toBe("finished");
    expect(run.finishedAt).toEqual(failedRun.finishedAt);

    expect((await recordJobOutcome(db, id, "ping", "a", "done")).recorded).toBe(false);
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ done: 1, failed: 0 });
  });

  it("a flip in an earlier stage keeps a run failed by its last stage", async () => {
    const { id } = await newRun(["a", "b"]);
    await beginStage(db, id, "a", 2);
    await recordJobOutcome(db, id, "a", "x", "failed");
    expect((await recordJobOutcome(db, id, "a", "w", "done")).nextStage).toBe("b");
    await beginStage(db, id, "b", 1);
    expect(await recordJobOutcome(db, id, "b", "y", "failed")).toMatchObject({ runFinished: true });
    expect((await getRun(db, id))!).toMatchObject({ status: "failed", failureReason: "stage b failed completely" });

    expect(await recordJobOutcome(db, id, "a", "x", "done")).toMatchObject({ recorded: true, nextStage: null });
    expect((await getRun(db, id))!.status).toBe("failed");

    expect(await recordJobOutcome(db, id, "b", "y", "done")).toMatchObject({ recorded: true, nextStage: null });
    expect((await getRun(db, id))!).toMatchObject({ status: "finished", failureReason: null });
  });

  it("a flip never revives a run failed for another reason", async () => {
    const { id } = await newRun(["a", "b"]);
    await beginStage(db, id, "a", 2);
    await recordJobOutcome(db, id, "a", "x", "failed");
    await failRun(db, id, "stage transition failed: boom");
    // The stage now fails completely, but the first reason stays and nothing moves on.
    expect(await recordJobOutcome(db, id, "a", "y", "failed")).toMatchObject({ stageFinished: true, nextStage: null });

    expect(await recordJobOutcome(db, id, "a", "x", "done")).toMatchObject({ recorded: true, nextStage: null });
    const run = (await getRun(db, id))!;
    expect(run).toMatchObject({ status: "failed", failureReason: "stage transition failed: boom" });
    expect(run.stages[0]).toMatchObject({ done: 1, failed: 1 });
  });

  it("failRun marks the run failed with a reason", async () => {
    const { id } = await newRun(["a", "b"]);
    await beginStage(db, id, "a", 1);
    await failRun(db, id, "stage transition failed: boom");
    const run = (await getRun(db, id))!;
    expect(run).toMatchObject({ status: "failed", failureReason: "stage transition failed: boom" });
    expect(run.finishedAt).toBeInstanceOf(Date);
  });

  it("resumeRun turns a failed run running again without reason or end time", async () => {
    const { id } = await newRun(["a", "b"]);
    await beginStage(db, id, "a", 1);
    await failRun(db, id, "stage transition failed: boom");

    expect(await resumeRun(db, id)).toBe(true);
    const run = (await getRun(db, id))!;
    expect(run).toMatchObject({ status: "running", failureReason: null, finishedAt: null });
    expect(run.startedAt).toBeInstanceOf(Date);
  });

  it("resumeRun leaves a run that has not failed alone", async () => {
    const { id } = await newRun(["a"]);
    await beginStage(db, id, "a", 1);
    await recordJobOutcome(db, id, "a", "x", "done");
    const before = (await getRun(db, id))!;
    expect(before.status).toBe("finished");

    expect(await resumeRun(db, id)).toBe(false);
    expect(await getRun(db, id)).toEqual(before);
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
