import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/test/db";
import { aiBatches, aiBatchItems, reviewTasks } from "@/lib/db/schema";
import { BudgetExceeded } from "@/lib/domain/costs";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun, failRun, getRun, recordJobOutcome, RUN_ENDED_REASON, resumeRun } from "@/lib/domain/runs";
import { createBoss } from "@/lib/jobs/boss";
import { isQueuePaused, resumeQueue } from "@/lib/jobs/controls";
import { createLogger } from "@/lib/logger";
import { advanceHandler } from "@/lib/jobs/handlers/run-advance";
import { pingHandler, pingStage } from "@/lib/jobs/handlers/system-ping";
import { HANDLERS } from "@/lib/jobs/registry";
import { STAGES } from "@/lib/jobs/stages";
import { DEAD_LETTER_QUEUE, deadLetterQueueOptions, ensureQueues, QUEUES } from "@/lib/jobs/queues";
import { startWorkers, type JobData, type JobHandler } from "@/lib/jobs/worker";
import { endRunByAdmin, enqueueStageJobs, startRun } from "@/lib/pipeline/runs";
import { jobsFromDb } from "@/lib/domain/queues-view";
import { failedJobsOfRun, retryFailedJob } from "@/lib/domain/jobs-view";
import { loadConfig, type AppConfig } from "@/lib/config";
import { MockModel } from "@/lib/ai/mock";
import { echoTask } from "@/lib/ai/tasks/system-echo";
import type { ModelTask } from "@/lib/ai/types";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { setModelClientFactory } from "@/lib/jobs/handlers/ai-batch";
import { submitStageBatch } from "@/lib/pipeline/batches";

/**
 * Shared with the module mocks below: keys whose review task creation throws, captured worker error logs, and whether
 * the worker misses every queue pause (a pause set and lifted between two of its control checks).
 */
const probe = vi.hoisted(() => ({
  failReviewFor: new Set<string>(),
  workerErrors: [] as Array<{ obj: Record<string, unknown>; msg?: string }>,
  missPauses: false,
}));

vi.mock("@/lib/jobs/controls", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/jobs/controls")>();
  return {
    ...original,
    isQueuePaused: async (...args: Parameters<typeof original.isQueuePaused>) =>
      probe.missPauses ? false : original.isQueuePaused(...args),
  };
});

vi.mock("@/lib/domain/review", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/domain/review")>();
  return {
    ...original,
    createReviewTask: async (...args: Parameters<typeof original.createReviewTask>) => {
      if (probe.failReviewFor.has(String(args[1].context.key))) throw new Error("review task insert failed");
      return original.createReviewTask(...args);
    },
  };
});

vi.mock("@/lib/logger", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/logger")>();
  return {
    ...original,
    createLogger: (...args: Parameters<typeof original.createLogger>) => {
      const log = original.createLogger(...args);
      if (args[0] === "worker") {
        const error = log.error.bind(log);
        log.error = ((obj: Record<string, unknown>, msg?: string) => {
          probe.workerErrors.push({ obj, msg });
          return error(obj, msg);
        }) as typeof log.error;
      }
      return log;
    },
  };
});

const db = testDb();

// Fast retries so a job exhausts its 3 attempts within the test timeout.
const queueConfig = {
  "system.ping": { concurrency: 2, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "run.advance": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "tiles.ensure": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "gazetteer.build": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "gazetteer.coarse": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "subdivisions.build": { concurrency: 1, retryLimit: 1, retryDelaySeconds: 0, retryBackoff: false },
  "mentions.reread": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "seed.tile": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "places.website": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "places.website.freeze": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "datasets.import": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "areas.import": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "geometry.compute": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "geometry.detect_bays": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "discovery.area": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "discovery.tile": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "discovery.propose": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "discovery.place": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "fetch.source": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "fetch.url": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "research.search": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "research.fetch": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "research.assess": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "research.extract": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "research.routes": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "research.discover": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "research.confirm": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "embed.chunks": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "sources.wikivoyage": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "compare.converters": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "ai.batch.poll": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "classify.document_version": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "mentions.batch": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "mentions.disambiguate": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "mentions.geocode": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "extraction.mention": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "extraction.route": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "extraction.check": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "consolidation.geo": { concurrency: 4, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "consolidation.highlights": { concurrency: 4, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "consolidation.summary": { concurrency: 2, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "consolidation.followup": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "images.place": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "delivery.build": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "quality.measure": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  "revisit.freeze": { concurrency: 1, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
  [DEAD_LETTER_QUEUE]: { concurrency: 1, retryLimit: 1, retryDelaySeconds: 0, retryBackoff: false },
};

/**
 * Jobs with `budgetOnce` throw BudgetExceeded on their first attempt only; jobs with `failThenBudget`
 * fail their first attempt and throw BudgetExceeded on their second.
 */
const budgetThrown = new Set<string>();
const failedOnce = new Set<string>();
/** Jobs with `failUntilFixed` fail until their `runId:key` marker is added here. */
const fixed = new Set<string>();

const testPing: JobHandler<JobData> = async (data, ctx) => {
  const marker = `${ctx.runId}:${data.key}`;
  if (data.failThenBudget === true && !failedOnce.has(marker)) {
    failedOnce.add(marker);
    throw new Error("first attempt fails");
  }
  if (data.failThenBudget === true && !budgetThrown.has(marker)) {
    budgetThrown.add(marker);
    throw new BudgetExceeded("anthropic", 11, 10);
  }
  if (data.failUntilFixed === true && !fixed.has(marker)) throw new Error(`not fixed yet: ${data.key}`);
  if (data.batchSubmit === true) return submitTestBatch(data, ctx);
  if (data.budgetOnce === true && !budgetThrown.has(marker)) {
    budgetThrown.add(marker);
    throw new BudgetExceeded("anthropic", 11, 10);
  }
  await pingHandler(data, ctx);
};

/** Model of the batch-submitting test jobs: its provider call fails until the job's marker is in `fixed`. */
const batchModel = new MockModel(
  { "system.echo": (input) => ({ echo: (input as { text: string }).text, language: "en" }) },
  { batchIdPrefix: `mock-${newId()}-` },
);
const baseConfig = loadConfig("config");
// The first poll after a send comes after 1 s, so the real poll job runs within the test.
const batchConfig: AppConfig = { ...baseConfig, models: { ...baseConfig.models, batch: { ...baseConfig.models.batch, pollSeconds: 1 } } };
const batchesDistributed: string[] = [];

/** Stage jobs with `batchSubmit` hand one echo request to a message batch, like the text stages do. */
async function submitTestBatch(data: JobData, ctx: Parameters<JobHandler<JobData>>[1]): Promise<void> {
  const marker = `${ctx.runId}:${data.key}`;
  const original = MockModel.prototype.submitBatch;
  const model = Object.create(batchModel) as MockModel;
  model.submitBatch = async (...args) => {
    if (!fixed.has(marker)) throw new Error("provider rejects the batch");
    return original.apply(batchModel, args);
  };
  await submitStageBatch(ctx.db, { model, boss: ctx.boss, config: batchConfig }, {
    task: echoTask as ModelTask<unknown, unknown>,
    runId: ctx.runId!,
    stage: String(data.stage),
    key: data.key,
    items: [{ subjectType: "test", subjectId: marker, input: { text: marker } }],
  });
}

let boss: PgBoss;
let workers: { stop(): Promise<void> };

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

function scope() {
  return { type: "system" as const, id: `ping-${newId()}` };
}

beforeAll(async () => {
  // Test-only second stage to exercise stage chaining.
  STAGES.ping2 = { ...pingStage, name: "ping2" };
  // Test-only stage whose planning always fails, to exercise a failing stage transition.
  STAGES.explode = {
    name: "explode",
    queue: "system.ping",
    async plan() {
      throw new Error("explode plan failed");
    },
  };
  // Test-only stage whose planning fails until its `runId:flaky` marker is in `fixed`, then plans one ping.
  STAGES.flaky = {
    name: "flaky",
    queue: "system.ping",
    async plan(_db, run) {
      if (!fixed.has(`${run.id}:flaky`)) throw new Error("flaky plan failed");
      return [{ key: "0" }];
    },
  };
  // Test-only stage with one job that submits a message batch.
  STAGES.batchsubmit = {
    name: "batchsubmit",
    queue: "system.ping",
    async plan() {
      return [{ key: "b0", batchSubmit: true }];
    },
  };
  // Test-only stage that plans no jobs, to exercise chaining across a zero-job stage.
  STAGES.empty = {
    name: "empty",
    queue: "system.ping",
    async plan() {
      return [];
    },
  };
  boss = createBoss(process.env.TEST_DATABASE_URL!);
  await boss.start();
  await ensureQueues(boss, queueConfig);
  for (const q of [...QUEUES, DEAD_LETTER_QUEUE]) await boss.deleteAllJobs(q);
  for (const q of QUEUES) await resumeQueue(db, q, "test");
  workers = await startWorkers(boss, db, { ...HANDLERS, "system.ping": testPing, "run.advance": advanceHandler }, queueConfig, {
    pollingIntervalSeconds: 0.5,
    controlPollMs: 200,
    // as the composition root (worker/index.ts) passes it
    batchHandlers: BATCH_HANDLERS,
  });
}, 30_000);

afterAll(async () => {
  delete STAGES.ping2;
  delete STAGES.explode;
  delete STAGES.empty;
  delete STAGES.flaky;
  delete STAGES.batchsubmit;
  await workers?.stop();
  for (const q of QUEUES) await resumeQueue(db, q, "test");
  await boss?.stop({ graceful: false });
}, 30_000);

describe("worker", () => {
  it("a ping run with 3 jobs finishes", async () => {
    const { id } = await startRun(db, boss, {
      kind: "system",
      scope: scope(),
      stages: ["ping"],
      params: { count: 3 },
      triggeredBy: "test",
    });
    await waitFor(async () => (await getRun(db, id))!.status === "finished", 20_000);
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ total: 3, done: 3, failed: 0 });
  }, 30_000);

  it("chains stages: the second stage is planned after the first finishes", async () => {
    const { id } = await startRun(db, boss, {
      kind: "system",
      scope: scope(),
      stages: ["ping", "ping2"],
      params: { count: 2 },
      triggeredBy: "test",
    });
    await waitFor(async () => (await getRun(db, id))!.status === "finished", 20_000);
    expect((await getRun(db, id))!.stages).toMatchObject([
      { stage: "ping", total: 2, done: 2 },
      { stage: "ping2", total: 2, done: 2 },
    ]);
  }, 30_000);

  it("a job failing all 3 attempts creates exactly one failed_job task and siblings finish", async () => {
    const { id } = await startRun(db, boss, {
      kind: "system",
      scope: scope(),
      stages: ["ping"],
      params: { count: 3, failKeys: ["1"] },
      triggeredBy: "test",
    });
    await waitFor(async () => (await getRun(db, id))!.status === "finished", 25_000);
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ total: 3, done: 2, failed: 1 });

    const failedJobs = await boss.findJobs<JobData>("system.ping", { data: { runId: id, key: "1" } });
    expect(failedJobs).toHaveLength(1);
    expect(failedJobs[0].state).toBe("failed");
    expect(failedJobs[0].retryCount).toBe(2);

    const tasks = await db
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.kind, "failed_job"), eq(reviewTasks.subjectId, failedJobs[0].id)));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ subjectType: "job", status: "open" });
    expect(tasks[0].context).toMatchObject({ queue: "system.ping", key: "1", runId: id });
    expect((tasks[0].context as { error?: string }).error).toContain("ping failed");
  }, 40_000);

  it("budget exhaustion pauses the queue instead of failing jobs, resume continues", async () => {
    const { id } = await createRun(db, {
      kind: "system",
      scope: scope(),
      stages: ["ping"],
      params: { count: 3 },
      triggeredBy: "test",
    });
    await beginStage(db, id, "ping", 3);
    await enqueueStageJobs(boss, "system.ping", id, "ping", [{ key: "0", budgetOnce: true }, { key: "1" }, { key: "2" }]);

    await waitFor(async () => isQueuePaused(db, "system.ping"), 15_000);
    // Siblings may finish, but the budget-hit job neither fails nor completes while paused.
    await new Promise((r) => setTimeout(r, 1500));
    let run = (await getRun(db, id))!;
    expect(run.status).toBe("running");
    expect(run.stages[0].failed).toBe(0);
    expect(run.stages[0].done).toBeLessThan(3);

    const deferred = await boss.findJobs<JobData>("system.ping", { data: { runId: id, key: "0" }, queued: true });
    expect(deferred).toHaveLength(1);
    expect(deferred[0].singletonKey).toBeNull();
    expect(deferred[0].startAfter.getTime()).toBeGreaterThan(Date.now());

    await resumeQueue(db, "system.ping", "test");
    await waitFor(async () => (await getRun(db, id))!.status === "finished", 20_000);
    run = (await getRun(db, id))!;
    expect(run.stages[0]).toMatchObject({ total: 3, done: 3, failed: 0 });
  }, 40_000);

  it("a failing next-stage plan does not fail the last job of the previous stage", async () => {
    const { id } = await startRun(db, boss, {
      kind: "system",
      scope: scope(),
      stages: ["ping", "explode"],
      params: { count: 2 },
      triggeredBy: "test",
    });
    await waitFor(async () => (await getRun(db, id))!.status === "failed", 25_000);

    const pingJobs = await boss.findJobs<JobData>("system.ping", { data: { runId: id } });
    expect(pingJobs).toHaveLength(2);
    expect(pingJobs.map((j) => j.state)).toEqual(["completed", "completed"]);

    const advanceJobs = await boss.findJobs<JobData>("run.advance", { data: { runId: id } });
    expect(advanceJobs).toHaveLength(1);
    expect(advanceJobs[0]).toMatchObject({ state: "failed", retryCount: 2, singletonKey: `${id}:explode` });
    expect(advanceJobs[0].data).toEqual({ runId: id, nextStage: "explode", key: `${id}:explode` });

    const tasks = await db
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.kind, "failed_job"), eq(reviewTasks.subjectId, advanceJobs[0].id)));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].context).toMatchObject({ queue: "run.advance", runId: id });

    const run = (await getRun(db, id))!;
    expect(run.status).toBe("failed");
    expect(run.failureReason).toContain("stage transition failed");
    expect(run.failureReason).toContain("explode plan failed");
    expect(run.stages).toMatchObject([
      { stage: "ping", total: 2, done: 2, failed: 0, status: "finished" },
      { stage: "explode", status: "pending" },
    ]);
  }, 40_000);

  it("a failing plan after a zero-job stage fails the run with one failed_job task", async () => {
    const { id } = await startRun(db, boss, {
      kind: "system",
      scope: scope(),
      stages: ["ping", "empty", "explode"],
      params: { count: 1 },
      triggeredBy: "test",
    });
    await waitFor(async () => (await getRun(db, id))!.status === "failed", 25_000);

    const advanceJobs = await boss.findJobs<JobData>("run.advance", { data: { runId: id } });
    expect(advanceJobs.map((j) => [j.data.nextStage, j.state]).sort()).toEqual([
      ["empty", "completed"],
      ["explode", "failed"],
    ]);

    const tasks = await db
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.kind, "failed_job"), sql`${reviewTasks.context}->>'runId' = ${id}`));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].context).toMatchObject({ queue: "run.advance", runId: id });

    const run = (await getRun(db, id))!;
    expect(run.failureReason).toContain("explode plan failed");
    expect(run.stages).toMatchObject([
      { stage: "ping", total: 1, done: 1, status: "finished" },
      { stage: "empty", total: 0, status: "finished" },
      { stage: "explode", status: "pending" },
    ]);
  }, 40_000);

  it("a job re-sent after a budget pause keeps its used attempts", async () => {
    const { id } = await createRun(db, {
      kind: "system",
      scope: scope(),
      stages: ["ping"],
      params: {},
      triggeredBy: "test",
    });
    await beginStage(db, id, "ping", 1);
    await enqueueStageJobs(boss, "system.ping", id, "ping", [{ key: "0", failThenBudget: true }]);

    await waitFor(async () => isQueuePaused(db, "system.ping"), 15_000);
    const deferred = await boss.findJobs<JobData>("system.ping", { data: { runId: id, key: "0" }, queued: true });
    expect(deferred).toHaveLength(1);
    expect(deferred[0].data.priorAttempts).toBe(1);
    expect(deferred[0].retryLimit).toBe(1);

    await resumeQueue(db, "system.ping", "test");
    await waitFor(async () => (await getRun(db, id))!.status === "finished", 20_000);
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ total: 1, done: 1, failed: 0 });
  }, 40_000);

  it("a budget pause lifted before the worker saw it still releases the deferred job", async () => {
    const { id } = await createRun(db, {
      kind: "system",
      scope: scope(),
      stages: ["ping"],
      params: {},
      triggeredBy: "test",
    });
    await beginStage(db, id, "ping", 1);
    probe.missPauses = true;
    try {
      await enqueueStageJobs(boss, "system.ping", id, "ping", [{ key: "0", budgetOnce: true }]);
      // The worker keeps the queue running: it never sees the pause, only the job deferred to the pause's end.
      await waitFor(
        async () => (await boss.findJobs<JobData>("system.ping", { data: { runId: id, budgetDeferred: true }, queued: true })).length === 1,
        15_000,
      );
      await resumeQueue(db, "system.ping", "test");
      await waitFor(async () => (await getRun(db, id))!.status === "finished", 10_000);
    } finally {
      probe.missPauses = false;
    }
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ total: 1, done: 1, failed: 0 });
  }, 40_000);

  it("retry moves the job back and the later success flips the outcome", async () => {
    const { id } = await createRun(db, {
      kind: "system",
      scope: scope(),
      stages: ["ping"],
      params: {},
      triggeredBy: "test",
    });
    await beginStage(db, id, "ping", 2);
    await enqueueStageJobs(boss, "system.ping", id, "ping", [{ key: "0" }, { key: "1", failUntilFixed: true }]);

    // Every job of the last stage counted, one failed: the run finishes; the failed job is listed.
    await waitFor(async () => (await getRun(db, id))!.stages[0].failed === 1, 25_000);
    await waitFor(async () => (await getRun(db, id))!.status === "finished", 10_000);
    const failed = await failedJobsOfRun(db, id);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ queue: "system.ping", key: "1", stage: "ping" });
    expect(failed[0].error).toContain("not fixed yet: 1");

    fixed.add(`${id}:1`);
    await retryFailedJob(db, boss, "system.ping", failed[0].id);
    expect((await boss.getJobById("system.ping", failed[0].id))?.state).not.toBe("failed");

    await waitFor(async () => (await boss.getJobById("system.ping", failed[0].id))?.state === "completed", 20_000);
    await waitFor(async () => (await getRun(db, id))!.stages[0].done === 2, 10_000);
    const run = (await getRun(db, id))!;
    expect(run.status).toBe("finished");
    expect(run.stages[0]).toMatchObject({ total: 2, done: 2, failed: 0, status: "finished" });
    expect(await failedJobsOfRun(db, id)).toEqual([]);
  }, 50_000);

  it("a run failed because its last stage all failed turns finished after a successful retry", async () => {
    const { id } = await createRun(db, {
      kind: "system",
      scope: scope(),
      stages: ["ping"],
      params: {},
      triggeredBy: "test",
    });
    await beginStage(db, id, "ping", 1);
    await enqueueStageJobs(boss, "system.ping", id, "ping", [{ key: "0", failUntilFixed: true }]);

    await waitFor(async () => (await getRun(db, id))!.status === "failed", 25_000);
    const [job] = await failedJobsOfRun(db, id);
    expect(job).toBeDefined();

    fixed.add(`${id}:0`);
    await retryFailedJob(db, boss, "system.ping", job.id);
    await waitFor(async () => (await getRun(db, id))!.status === "finished", 20_000);
    const run = (await getRun(db, id))!;
    expect(run.failureReason).toBeNull();
    expect(run.stages[0]).toMatchObject({ total: 1, done: 1, failed: 0 });
  }, 50_000);

  it("a stage whose jobs all failed stops the run; a successful retry continues it to finished", async () => {
    const { id } = await createRun(db, {
      kind: "system",
      scope: scope(),
      stages: ["ping", "ping2"],
      params: { count: 1 },
      triggeredBy: "test",
    });
    await beginStage(db, id, "ping", 1);
    await enqueueStageJobs(boss, "system.ping", id, "ping", [{ key: "0", failUntilFixed: true }]);

    await waitFor(async () => (await getRun(db, id))!.status === "failed", 25_000);
    const failedRun = (await getRun(db, id))!;
    expect(failedRun.failureReason).toBe("stage ping failed completely");
    expect(failedRun.stages.map((s) => s.status)).toEqual(["finished", "pending"]);
    expect(await boss.findJobs("run.advance", { data: { runId: id } })).toEqual([]);
    const [job] = await failedJobsOfRun(db, id);
    expect(job).toMatchObject({ queue: "system.ping", stage: "ping" });

    fixed.add(`${id}:0`);
    await retryFailedJob(db, boss, "system.ping", job.id);
    await waitFor(async () => (await getRun(db, id))!.status === "finished", 25_000);
    const run = (await getRun(db, id))!;
    expect(run.failureReason).toBeNull();
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.stages).toMatchObject([
      { stage: "ping", total: 1, done: 1, failed: 0, status: "finished" },
      { stage: "ping2", total: 1, done: 1, failed: 0, status: "finished" },
    ]);
  }, 60_000);

  it("retrying a failed stage transition resumes the run, which fails again or finishes", async () => {
    const { id } = await startRun(db, boss, {
      kind: "system",
      scope: scope(),
      stages: ["ping", "flaky", "ping2"],
      params: { count: 1 },
      triggeredBy: "test",
    });
    await waitFor(async () => (await getRun(db, id))!.status === "failed", 25_000);
    const [advance] = await failedJobsOfRun(db, id);
    expect(advance).toMatchObject({ queue: "run.advance", stage: null });

    // A retry that fails again fails the run again with a fresh reason.
    await retryFailedJob(db, boss, "run.advance", advance.id);
    expect((await getRun(db, id))!).toMatchObject({ status: "running", failureReason: null, finishedAt: null });
    await waitFor(async () => (await getRun(db, id))!.status === "failed", 20_000);
    expect((await getRun(db, id))!.failureReason).toContain("flaky plan failed");

    fixed.add(`${id}:flaky`);
    await retryFailedJob(db, boss, "run.advance", advance.id);
    await waitFor(async () => (await getRun(db, id))!.status === "finished", 25_000);
    const run = (await getRun(db, id))!;
    expect(run.failureReason).toBeNull();
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.stages).toMatchObject([
      { stage: "ping", total: 1, done: 1, status: "finished" },
      { stage: "flaky", total: 1, done: 1, status: "finished" },
      { stage: "ping2", total: 1, done: 1, status: "finished" },
    ]);
    expect(await failedJobsOfRun(db, id)).toEqual([]);
  }, 80_000);

  it("a stray run.advance for a failed run enqueues nothing", async () => {
    const { id } = await createRun(db, {
      kind: "system",
      scope: scope(),
      stages: ["ping"],
      params: { count: 2 },
      triggeredBy: "test",
    });
    await failRun(db, id, "stage transition failed: boom");

    await advanceHandler(
      { runId: id, nextStage: "ping", key: `${id}:ping` },
      { db, boss, log: createLogger("test"), jobId: newId(), runId: id },
    );
    const run = (await getRun(db, id))!;
    expect(run).toMatchObject({ status: "failed", failureReason: "stage transition failed: boom" });
    expect(run.stages[0]).toMatchObject({ status: "pending", total: 0 });
    expect(await boss.findJobs("system.ping", { data: { runId: id } })).toEqual([]);
  });

  it("a late dead-letter delivery for a run.advance job that is no longer failed leaves the run alone", async () => {
    const { id } = await createRun(db, {
      kind: "system",
      scope: scope(),
      stages: ["ping"],
      params: {},
      triggeredBy: "test",
    });
    await beginStage(db, id, "ping", 1);
    // The transition job was retried and has completed since; its dead-letter copy arrives only now.
    const data = { runId: id, nextStage: "ping", key: `${id}:ping` };
    const sourceId = newId();
    await db.execute(sql`
      insert into pgboss.job (id, name, data, state, completed_on)
      values (${sourceId}, 'run.advance', ${JSON.stringify(data)}::jsonb, 'completed', now())`);
    const { rows } = await db.execute<{ id: string }>(sql`
      insert into pgboss.job (name, data, source_name, source_id, source_output)
      values (${DEAD_LETTER_QUEUE}, ${JSON.stringify(data)}::jsonb, 'run.advance', ${sourceId}, '{"message":"late"}'::jsonb)
      returning id`);
    const deadId = rows[0]!.id;

    await waitFor(async () => (await boss.getJobById(DEAD_LETTER_QUEUE, deadId))?.state === "completed", 20_000);
    expect((await getRun(db, id))!).toMatchObject({ status: "running", failureReason: null });
    // The failure is still on record for review.
    const tasks = await db
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.kind, "failed_job"), eq(reviewTasks.subjectId, sourceId)));
    expect(tasks).toHaveLength(1);
  }, 30_000);

  it("ending a run cancels its waiting jobs; a job of it that still starts does nothing; no retry resumes it", async () => {
    const { id } = await createRun(db, { kind: "system", scope: scope(), stages: ["ping"], params: {}, triggeredBy: "test" });
    await beginStage(db, id, "ping", 2);
    const later = new Date(Date.now() + 3_600_000);
    const waiting = await boss.send("system.ping", { runId: id, stage: "ping", key: "waiting" }, { startAfter: later });

    expect(await endRunByAdmin(db, boss, id, "admin@example.invalid")).toEqual({ ended: true, cleanedUp: true, cancelledJobs: 1 });
    expect((await boss.getJobById("system.ping", waiting!))?.state).toBe("cancelled");
    const run = (await getRun(db, id))!;
    expect(run).toMatchObject({ status: "failed", failureReason: RUN_ENDED_REASON, endedBy: "admin@example.invalid" });
    expect(run.endedAt).toBeInstanceOf(Date);
    expect(run.finishedAt).toBeInstanceOf(Date);
    // Ending again changes nothing.
    expect(await endRunByAdmin(db, boss, id, "other@example.invalid")).toEqual({ ended: false, cleanedUp: false, cancelledJobs: 0 });

    // A job a still-active job enqueued after the end: its handler would fail every attempt, but it never runs.
    const late = await boss.send("system.ping", { runId: id, stage: "ping", key: "late", failUntilFixed: true });
    await waitFor(async () => (await boss.getJobById("system.ping", late!))?.state === "completed", 20_000);
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ total: 2, done: 0, failed: 0, status: "running" });
    expect(await failedJobsOfRun(db, id)).toEqual([]);

    expect(await resumeRun(db, id)).toBe(false);
    expect((await getRun(db, id))!).toMatchObject({ status: "failed", endedBy: "admin@example.invalid" });
  }, 30_000);

  it("enqueueing the same run stage twice does not duplicate jobs", async () => {
    const { id } = await createRun(db, {
      kind: "system",
      scope: scope(),
      stages: ["ping"],
      params: {},
      triggeredBy: "test",
    });
    await beginStage(db, id, "ping", 2);
    const jobs = [{ key: "a" }, { key: "b" }];
    expect(await enqueueStageJobs(boss, "system.ping", id, "ping", jobs)).toBe(2);
    expect(await enqueueStageJobs(boss, "system.ping", id, "ping", jobs)).toBe(0);

    await waitFor(async () => (await getRun(db, id))!.status === "finished", 20_000);
    expect(await boss.findJobs("system.ping", { data: { runId: id } })).toHaveLength(2);
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ total: 2, done: 2, failed: 0 });
  }, 30_000);

  it("enqueueing in a transaction counts only the jobs pg-boss newly inserted", async () => {
    const { id } = await createRun(db, { kind: "system", scope: scope(), stages: ["ping"], params: {}, triggeredBy: "test" });
    await beginStage(db, id, "ping", 3);
    expect(await enqueueStageJobs(boss, "system.ping", id, "ping", [{ key: "a" }, { key: "b" }])).toBe(2);
    // One known job and one new one, in the caller's transaction (as fetch.url extends its stage by the count).
    const added = await db.transaction((tx) => enqueueStageJobs(boss, "system.ping", id, "ping", [{ key: "b" }, { key: "c" }], tx));
    expect(added).toBe(1);

    await waitFor(async () => (await getRun(db, id))!.status === "finished", 20_000);
    expect(await boss.findJobs("system.ping", { data: { runId: id } })).toHaveLength(3);
    expect((await getRun(db, id))!.stages[0]).toMatchObject({ total: 3, done: 3, failed: 0 });
  }, 30_000);

  it("a dead-letter job whose review task creation throws is logged and ends failed in the jobs view", async () => {
    const key = `dl-boom-${newId()}`;
    probe.failReviewFor.add(key);
    const before = (await jobsFromDb(db))[DEAD_LETTER_QUEUE].failed;
    const id = await boss.send(DEAD_LETTER_QUEUE, { key });
    expect(id).toBeTruthy();

    await waitFor(async () => (await boss.getJobById(DEAD_LETTER_QUEUE, id!))?.state === "failed", 20_000);
    const job = await boss.getJobById(DEAD_LETTER_QUEUE, id!);
    expect(job?.retryCount).toBe(1);
    expect((await jobsFromDb(db))[DEAD_LETTER_QUEUE].failed).toBeGreaterThanOrEqual(before + 1);

    const logged = probe.workerErrors.filter((e) => e.msg === "dead-letter handling failed" && e.obj.jobId === id);
    expect(logged).toHaveLength(2);
    expect(String(logged[0].obj.err)).toContain("review task insert failed");
    expect(probe.workerErrors.some((e) => e.msg === "job failed permanently" && e.obj.jobId === id)).toBe(false);
  }, 30_000);

  it("a dead-lettered batch poll fails its batch, records the unit as failed and reports its items", async () => {
    const reported: string[] = [];
    BATCH_HANDLERS["system.echo"] = {
      task: echoTask as ModelTask<unknown, unknown>,
      handle: async () => {},
      fail: async (_db, item) => {
        reported.push(item.subjectId);
      },
    };
    try {
      const { id: runId } = await createRun(db, { kind: "system", scope: scope(), stages: ["batchpoll"], triggeredBy: "test" });
      // One submit job (done) plus the batch unit it added.
      await beginStage(db, runId, "batchpoll", 2);
      await recordJobOutcome(db, runId, "batchpoll", "k", "done");
      const [batch] = await db
        .insert(aiBatches)
        .values({
          providerBatchId: `mock-${newId()}`,
          task: "system.echo",
          model: "claude-haiku-5-5",
          promptVersion: 1,
          status: "submitted",
          runId,
          stage: "batchpoll",
          outcomeKey: "batch:k",
          requestCount: 1,
        })
        .returning();
      await db.insert(aiBatchItems).values({ batchId: batch!.id, subjectType: "test", subjectId: `${runId}:s0`, input: {} });
      // No model client is configured in this process, so every attempt of the poll fails.
      await boss.send("ai.batch.poll", { key: `poll:${batch!.id}:0`, batchId: batch!.id });

      await waitFor(async () => (await getRun(db, runId))!.status === "finished", 20_000);
      expect((await getRun(db, runId))!.stages[0]).toMatchObject({ total: 2, done: 1, failed: 1 });
      const [after] = await db.select().from(aiBatches).where(eq(aiBatches.id, batch!.id));
      expect(after!.status).toBe("failed");
      // the item never distributed went to the task's fail handler
      expect(reported).toEqual([`${runId}:s0`]);
    } finally {
      delete BATCH_HANDLERS["system.echo"];
    }
  }, 30_000);

  it("a dead-lettered batch submit job fails its unit; a manual retry sends it and the real poll job finishes the run", async () => {
    BATCH_HANDLERS["system.echo"] = {
      task: echoTask as ModelTask<unknown, unknown>,
      handle: async (_db, item) => {
        batchesDistributed.push(item.subjectId);
      },
    };
    setModelClientFactory(() => batchModel);
    try {
      const { id: runId } = await startRun(db, boss, { kind: "system", scope: scope(), stages: ["batchsubmit"], triggeredBy: "test" });
      // Three failed provider calls: the job and the batch unit it added both count as failed.
      await waitFor(async () => (await getRun(db, runId))!.status === "failed", 20_000);
      expect((await getRun(db, runId))!.stages[0]).toMatchObject({ total: 2, done: 0, failed: 2 });
      const [unsent] = await db.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      expect(unsent).toMatchObject({ status: "failed", providerBatchId: null });

      fixed.add(`${runId}:b0`);
      const [failedJob] = await failedJobsOfRun(db, runId);
      await retryFailedJob(db, boss, "system.ping", failedJob!.id);
      // The job's own success finishes the revived run already; the batch unit follows with the poll job.
      await waitFor(async () => (await getRun(db, runId))!.stages[0]!.done === 2, 20_000);
      expect(await getRun(db, runId)).toMatchObject({ status: "finished" });
      expect((await getRun(db, runId))!.stages[0]).toMatchObject({ total: 2, done: 2, failed: 0 });
      const [sent] = await db.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      expect(sent!.status).toBe("distributed");
      expect(batchesDistributed).toContain(`${runId}:b0`);
    } finally {
      setModelClientFactory(undefined);
      delete BATCH_HANDLERS["system.echo"];
    }
  }, 40_000);

  it("a dead-letter job with a sourceId puts it into the failed_job context", async () => {
    const key = `dl-source-${newId()}`;
    const sourceId = newId();
    const id = await boss.send(DEAD_LETTER_QUEUE, { key, sourceId });
    await waitFor(async () => (await boss.getJobById(DEAD_LETTER_QUEUE, id!))?.state === "completed", 20_000);
    const [task] = await db
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.kind, "failed_job"), eq(reviewTasks.subjectId, id!)));
    expect(task!.context).toMatchObject({ key, sourceId });

    const other = await boss.send(DEAD_LETTER_QUEUE, { key: `dl-nosource-${newId()}`, sourceId: 7 });
    await waitFor(async () => (await boss.getJobById(DEAD_LETTER_QUEUE, other!))?.state === "completed", 20_000);
    const [plain] = await db
      .select()
      .from(reviewTasks)
      .where(and(eq(reviewTasks.kind, "failed_job"), eq(reviewTasks.subjectId, other!)));
    expect(plain!.context).not.toHaveProperty("sourceId");
  }, 30_000);

  it("a queue's expiry from the config is applied", async () => {
    const before = await boss.getQueue("fetch.url");
    await ensureQueues(boss, { ...queueConfig, "fetch.url": { ...queueConfig["fetch.url"], expireInSeconds: 3600 } });
    expect(await boss.getQueue("fetch.url")).toMatchObject({ expireInSeconds: 3600 });
    await ensureQueues(boss, { ...queueConfig, "fetch.url": { ...queueConfig["fetch.url"], expireInSeconds: before!.expireInSeconds } });
  });

  it("the dead-letter queue gets explicit retry settings", async () => {
    expect(deadLetterQueueOptions({})).toEqual({ retryLimit: 5, retryDelay: 60, retryBackoff: true });
    const queue = await boss.getQueue(DEAD_LETTER_QUEUE);
    expect(queue).toMatchObject({ retryLimit: 1, retryDelay: 0, retryBackoff: false });
  });
});
