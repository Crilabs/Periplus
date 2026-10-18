import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { newId } from "@/lib/domain/ids";
import { BudgetExceeded } from "@/lib/domain/costs";
import { isQueuePaused, pauseForBudget, pauseQueue, resumeQueue } from "@/lib/jobs/controls";

const db = testDb();

describe("queue controls", () => {
  it("pauseForBudget pauses until next UTC midnight and resumeQueue clears it", async () => {
    const q = `q-${newId()}`;
    const now = new Date("2030-03-05T22:30:00Z");
    await pauseForBudget(db, new BudgetExceeded("voyage", 2, 1), [q], now);
    expect(await isQueuePaused(db, q, now)).toBe(true);
    expect(await isQueuePaused(db, q, new Date("2030-03-05T23:59:59Z"))).toBe(true);
    expect(await isQueuePaused(db, q, new Date("2030-03-06T00:00:00Z"))).toBe(false);
    await resumeQueue(db, q, "test");
    expect(await isQueuePaused(db, q, now)).toBe(false);
  });

  it("pauseQueue with null until pauses until resumed; unknown queues are not paused", async () => {
    const q = `q-${newId()}`;
    expect(await isQueuePaused(db, q)).toBe(false);
    await pauseQueue(db, q, null, "manual", "test");
    expect(await isQueuePaused(db, q, new Date("2100-01-01T00:00:00Z"))).toBe(true);
    await resumeQueue(db, q, "test");
    expect(await isQueuePaused(db, q)).toBe(false);
  });
});
