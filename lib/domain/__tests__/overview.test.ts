import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { newId } from "@/lib/domain/ids";
import { workerHeartbeats } from "@/lib/db/schema";
import { overview, REVIEW_KINDS } from "@/lib/domain/overview";
import { jobsFromDb, queuesView, VIEW_QUEUES } from "@/lib/domain/queues-view";
import { getConfig } from "@/lib/config";
import { createBoss } from "@/lib/jobs/boss";
import { fromDrizzle } from "pg-boss";
import { DEAD_LETTER_QUEUE, ensureQueues, QUEUES } from "@/lib/jobs/queues";

const db = testDb();
const boss = createBoss(process.env.TEST_DATABASE_URL!);

beforeAll(async () => {
  await boss.start();
  // Never reconfigure an existing queue: other test files share this database.
  if (!(await boss.getQueue("system.ping"))) await ensureQueues(boss, getConfig().queues);
});

afterAll(async () => {
  await boss.stop({ graceful: false });
});

describe("overview", () => {
  it("reports a worker heartbeat age", async () => {
    const now = new Date();
    const workerId = `w-${newId()}`;
    await db
      .insert(workerHeartbeats)
      .values({ workerId, host: "test", startedAt: new Date(now.getTime() - 3_600_000), beatAt: new Date(now.getTime() - 40_000) });
    const result = await overview(db, now);
    expect(result.workers.find((w) => w.workerId === workerId)?.beatAgeSeconds).toBe(40);
  });

  it("lists only workers that beat within the last hour", async () => {
    const now = new Date();
    const staleId = `w-stale-${newId()}`;
    await db
      .insert(workerHeartbeats)
      .values({ workerId: staleId, host: "test", startedAt: new Date(now.getTime() - 7_200_000), beatAt: new Date(now.getTime() - 3_700_000) });
    const result = await overview(db, now);
    expect(result.workers.find((w) => w.workerId === staleId)).toBeUndefined();
  });

  it("returns a count for every review kind and queue, and the budgets", async () => {
    const result = await overview(db);
    expect(Object.keys(result.openReviewTasks).sort()).toEqual([...REVIEW_KINDS].sort());
    for (const queue of QUEUES) {
      expect(result.jobs[queue]).toEqual({
        queued: expect.any(Number),
        active: expect.any(Number),
        failed: expect.any(Number),
        paused: expect.any(Boolean),
        pause: result.jobs[queue].paused ? expect.any(Object) : null,
        pausable: true,
      });
    }
    // The dead-letter queue is listed too, so failures in it are visible; it cannot be paused.
    expect(result.jobs[DEAD_LETTER_QUEUE]).toEqual({
      queued: expect.any(Number),
      active: expect.any(Number),
      failed: expect.any(Number),
      paused: false,
      pause: null,
      pausable: false,
    });
    expect(result.budgets.map((b) => b.service).sort()).toEqual(["anthropic", "dataforseo", "firecrawl", "jina", "openai"]);
    expect(result.recentRuns.length).toBeLessThanOrEqual(5);
    expect(result.recentDeliveries.length).toBeLessThanOrEqual(5);
  });

  it("counts a real queued job identically in overview and queuesView", async () => {
    // Other test files enqueue, run and delete system.ping jobs on the shared database meanwhile. A
    // repeatable-read transaction sees one snapshot plus its own writes, so the delta is exactly this job.
    const rollback = new Error("rollback");
    await expect(
      db.transaction(
        async (tx) => {
          const before = await overview(tx);
          // Far-future start: no worker could take it even if it were committed.
          const id = await boss.send("system.ping", { key: "overview-test" }, { startAfter: 3600, db: fromDrizzle(tx, sql) });
          expect(id).toBeTruthy();
          const after = await overview(tx);
          const view = await queuesView(tx);
          expect(after.jobs["system.ping"]).toEqual({
            ...before.jobs["system.ping"],
            queued: before.jobs["system.ping"].queued + 1,
          });
          expect(view["system.ping"]).toEqual(after.jobs["system.ping"]);
          throw rollback;
        },
        { isolationLevel: "repeatable read" },
      ),
    ).rejects.toBe(rollback);
  });

  it("jobsFromDb returns zeros without pgboss schema", async () => {
    const rollback = new Error("rollback");
    let jobs: Awaited<ReturnType<typeof jobsFromDb>> | undefined;
    await expect(
      db.transaction(async (tx) => {
        // Simulates a fresh installation where the worker has not created pg-boss' schema yet.
        await tx.execute(sql`alter schema pgboss rename to pgboss_x`);
        jobs = await jobsFromDb(tx);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    for (const queue of VIEW_QUEUES) expect(jobs?.[queue]).toMatchObject({ queued: 0, active: 0, failed: 0 });
  });
});
