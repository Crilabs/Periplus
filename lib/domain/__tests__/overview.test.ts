import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { newId } from "@/lib/domain/ids";
import { workerHeartbeats } from "@/lib/db/schema";
import { overview } from "@/lib/domain/overview";
import { QUEUES } from "@/lib/jobs/queues";
import { REVIEW_KINDS } from "@/lib/domain/overview";

const db = testDb();

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

  it("returns a count for every review kind and queue, and the budgets", async () => {
    const result = await overview(db);
    expect(Object.keys(result.openReviewTasks).sort()).toEqual([...REVIEW_KINDS].sort());
    for (const queue of QUEUES) {
      expect(result.jobs[queue]).toEqual({
        queued: expect.any(Number),
        active: expect.any(Number),
        failed: expect.any(Number),
        paused: expect.any(Boolean),
      });
    }
    expect(result.budgets).toHaveLength(5);
    expect(result.recentRuns.length).toBeLessThanOrEqual(5);
  });
});
