import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import {
  BudgetExceeded,
  assertWithinBudget,
  budgetStatus,
  dailySpendEur,
  recordExternalCall,
  spendBreakdown,
  spendByService,
} from "@/lib/domain/costs";
import { newId } from "@/lib/domain/ids";
import type { AppConfig } from "@/lib/config";

const db = testDb();

// Each test uses its own far-away UTC day so shared external_calls rows do not collide.
let dayCounter = 0;
function uniqueDay(): Date {
  const d = new Date(Date.UTC(2200, 0, 1));
  d.setUTCDate(d.getUTCDate() + Math.floor(Math.random() * 100000) + dayCounter++);
  return d;
}
const at = (day: Date, hours: number) => new Date(day.getTime() + hours * 3_600_000);

const budgets = (anthropic: number): AppConfig["budgets"] => ({
  anthropic: { dailyEur: anthropic },
  voyage: { dailyEur: 1 },
  dataforseo: { dailyEur: 1 },
  firecrawl: { dailyEur: 1 },
  jina: { dailyEur: 1 },
});

async function spend(service: string, costEur: number, when: Date) {
  // recordExternalCall stamps `at` with now; backdate via the optional field used by the worker tests.
  await recordExternalCall(db, { service, operation: "test", units: 1, unit: "call", costEur, at: when });
}

describe("costs", () => {
  it("assertWithinBudget throws BudgetExceeded at 100% and not at 99%", async () => {
    const day = uniqueDay();
    await spend("anthropic", 0.99, at(day, 1));
    await expect(assertWithinBudget(db, "anthropic", budgets(1), at(day, 2))).resolves.toBeUndefined();
    await spend("anthropic", 0.01, at(day, 3));
    const err = await assertWithinBudget(db, "anthropic", budgets(1), at(day, 4)).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceeded);
    expect(err.service).toBe("anthropic");
    expect(err.spentEur).toBeCloseTo(1, 6);
    expect(err.budgetEur).toBe(1);
  });

  it("spend from yesterday does not count today", async () => {
    const day = uniqueDay();
    await spend("anthropic", 5, at(day, -1));
    expect(await dailySpendEur(db, "anthropic", at(day, 5))).toBe(0);
    await expect(assertWithinBudget(db, "anthropic", budgets(1), at(day, 5))).resolves.toBeUndefined();
    expect(await dailySpendEur(db, "anthropic", at(day, -2))).toBeCloseTo(5, 6);
  });

  it("budgetStatus reports spend, budget and ratio per service", async () => {
    const day = uniqueDay();
    await spend("anthropic", 0.5, at(day, 1));
    const status = await budgetStatus(db, budgets(2), at(day, 2));
    const a = status.find((s) => s.service === "anthropic");
    expect(a).toEqual({ service: "anthropic", spentEur: 0.5, budgetEur: 2, ratio: 0.25 });
    expect(status).toHaveLength(5);
  });
});

describe("spendByService", () => {
  it("sums the last 30 days per service and ignores older calls", async () => {
    const service = `svc-${Math.random().toString(36).slice(2)}`;
    const now = new Date();
    await spend(service, 1.5, new Date(now.getTime() - 2 * 24 * 3_600_000));
    await spend(service, 0.5, new Date(now.getTime() - 10 * 24 * 3_600_000));
    await spend(service, 100, new Date(now.getTime() - 40 * 24 * 3_600_000));
    const row = (await spendByService(db, 30, now)).find((r) => r.service === service);
    expect(row?.costEur).toBeCloseTo(2, 6);
  });
});

describe("spendBreakdown", () => {
  it("spendBreakdown groups by stage, run and month", async () => {
    // A random month far beyond the other cost tests' days, so no other rows fall into the window.
    const base = new Date(Date.UTC(2700, Math.floor(Math.random() * 12_000), 1));
    const prevMonth = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - 1, 20));
    const now = new Date(base.getTime() + 5 * 24 * 3_600_000);
    const runA = newId();
    const runB = newId();
    const stage = `stage-${newId()}`;
    const call = (costEur: number, when: Date, runId?: string, stageName?: string) =>
      recordExternalCall(db, { service: "anthropic", operation: "test", units: 1, unit: "call", costEur, at: when, runId, stage: stageName });
    await call(1, at(base, 1), runA, stage);
    await call(2, at(base, 2), runA, "other");
    await call(0.5, at(base, 3), runB, stage);
    await call(4, prevMonth, runB, stage);
    await call(9, new Date(now.getTime() - 400 * 24 * 3_600_000), runA, stage);

    const byStage = await spendBreakdown(db, "stage", { days: 30, now });
    expect(byStage).toEqual([
      { key: stage, costEur: 5.5, calls: 3 },
      { key: "other", costEur: 2, calls: 1 },
    ]);

    const byRun = await spendBreakdown(db, "run", { days: 30, now });
    expect(byRun).toEqual([
      { key: runB, costEur: 4.5, calls: 2 },
      { key: runA, costEur: 3, calls: 2 },
    ]);

    const byMonth = await spendBreakdown(db, "month", { days: 30, now });
    const month = (d: Date) => d.toISOString().slice(0, 7);
    expect(byMonth).toEqual([
      { key: month(base), costEur: 3.5, calls: 3 },
      { key: month(prevMonth), costEur: 4, calls: 1 },
    ]);
  });
});
