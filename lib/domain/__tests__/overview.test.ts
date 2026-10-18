import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { newId } from "@/lib/domain/ids";
import { workerHeartbeats } from "@/lib/db/schema";
import { overview, REVIEW_KINDS } from "@/lib/domain/overview";
import { jobsFromDb, queuesView, VIEW_QUEUES } from "@/lib/domain/queues-view";
import { getConfig } from "@/lib/config";
import { createBoss } from "@/lib/jobs/boss";
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
        pausable: true,
      });
    }
    // The dead-letter queue is listed too, so failures in it are visible; it cannot be paused.
    expect(result.jobs[DEAD_LETTER_QUEUE]).toEqual({
      queued: expect.any(Number),
      active: expect.any(Number),
      failed: expect.any(Number),
      paused: false,
      pausable: false,
    });
    expect(result.budgets).toHaveLength(5);
    expect(result.recentRuns.length).toBeLessThanOrEqual(5);
  });

  it("counts a real queued job identically in overview and queuesView", async () => {
    // Other test files enqueue system.ping jobs on the shared database, so a single before/after
    // window can be disturbed; the delta must be exactly +1 in at least one undisturbed attempt.
    const deltas: number[] = [];
    let viewMatched = false;
    for (let attempt = 0; attempt < 10 && !(deltas.includes(1) && viewMatched); attempt++) {
      const before = await overview(db);
      // Far-future start keeps concurrently running test workers from picking the job up.
      const id = await boss.send("system.ping", { key: "overview-test" }, { startAfter: 3600 });
      expect(id).toBeTruthy();
      try {
        const after = await overview(db);
        const view = await queuesView(db);
        const delta = after.jobs["system.ping"].queued - before.jobs["system.ping"].queued;
        deltas.push(delta);
        if (delta === 1) {
          expect(after.jobs["system.ping"].active).toBe(before.jobs["system.ping"].active);
          viewMatched = view["system.ping"].queued === after.jobs["system.ping"].queued;
        }
      } finally {
        await db.execute(sql`delete from pgboss.job where id = ${id}`);
      }
    }
    expect(deltas).toContain(1);
    expect(viewMatched).toBe(true);
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
