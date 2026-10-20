import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { newId } from "@/lib/domain/ids";
import { BudgetExceeded } from "@/lib/domain/costs";
import { isQueuePaused, pauseForBudget, pauseQueue, queuePause, resumeQueue } from "@/lib/jobs/controls";
import { isBudgetPause, queuePauseText } from "@/app/(admin)/_components/labels";

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

  it("queuePause tells why, until when and by whom a queue is paused; the jobs page words it (UI-8)", async () => {
    const budget = `q-${newId()}`;
    const manual = `q-${newId()}`;
    const now = new Date("2030-03-05T22:30:00Z");
    await pauseForBudget(db, new BudgetExceeded("anthropic", 2, 1), [budget], now);
    await pauseQueue(db, manual, null, "manual", "admin@example.invalid");
    const b = await queuePause(db, budget, now);
    expect(b).toEqual({ reason: "budget:anthropic", until: new Date("2030-03-06T00:00:00Z"), by: "system" });
    expect(isBudgetPause(b)).toBe(true);
    expect(queuePauseText(b!)).toBe("Budget Anthropic erreicht, bis 06.03.30, 00:00 UTC");
    const m = await queuePause(db, manual, now);
    expect(isBudgetPause(m)).toBe(false);
    expect(queuePauseText(m!)).toBe("von Hand (admin@example.invalid), ohne Ende");
    expect(await queuePause(db, budget, new Date("2030-03-06T00:00:00Z"))).toBeNull();
    await resumeQueue(db, budget, "test");
    await resumeQueue(db, manual, "test");
  });
});
