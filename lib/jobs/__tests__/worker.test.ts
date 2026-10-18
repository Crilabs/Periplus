import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { reviewTasks } from "@/lib/db/schema";
import { BudgetExceeded } from "@/lib/domain/costs";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun, getRun } from "@/lib/domain/runs";
import { createBoss } from "@/lib/jobs/boss";
import { isQueuePaused, resumeQueue } from "@/lib/jobs/controls";
import { pingHandler, pingStage } from "@/lib/jobs/handlers/system-ping";
import { STAGES } from "@/lib/jobs/registry";
import { DEAD_LETTER_QUEUE, ensureQueues, QUEUES } from "@/lib/jobs/queues";
import { startWorkers, type JobData, type JobHandler } from "@/lib/jobs/worker";
import { enqueueStageJobs, startRun } from "@/lib/pipeline/runs";

const db = testDb();

// Fast retries so a job exhausts its 3 attempts within the test timeout.
const queueConfig = {
  "system.ping": { concurrency: 2, retryLimit: 2, retryDelaySeconds: 0, retryBackoff: false },
};

/** Jobs with `budgetOnce` throw BudgetExceeded on their first attempt only. */
const budgetThrown = new Set<string>();

const testPing: JobHandler<JobData> = async (data, ctx) => {
  const marker = `${ctx.runId}:${data.key}`;
  if (data.budgetOnce === true && !budgetThrown.has(marker)) {
    budgetThrown.add(marker);
    throw new BudgetExceeded("anthropic", 11, 10);
  }
  await pingHandler(data, ctx);
};

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
  boss = createBoss(process.env.TEST_DATABASE_URL!);
  await boss.start();
  await ensureQueues(boss, queueConfig);
  for (const q of [...QUEUES, DEAD_LETTER_QUEUE]) await boss.deleteAllJobs(q);
  for (const q of QUEUES) await resumeQueue(db, q, "test");
  workers = await startWorkers(boss, db, { "system.ping": testPing }, queueConfig, {
    pollingIntervalSeconds: 0.5,
    controlPollMs: 200,
  });
}, 30_000);

afterAll(async () => {
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
});
