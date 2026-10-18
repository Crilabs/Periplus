import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { BudgetExceeded, assertWithinBudget, budgetStatus, dailySpendEur, recordExternalCall, spendByService } from "@/lib/domain/costs";
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
