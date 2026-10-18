import { and, gte, lt, eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { externalCalls } from "@/lib/db/schema";
import { getConfig, type AppConfig, type BudgetService } from "@/lib/config";
import { BUDGET_SERVICES } from "@/lib/config/schemas";

export type ExternalCall = {
  service: string;
  operation: string;
  units: number;
  unit: string;
  costEur: number;
  runId?: string;
  tileId?: string;
  stage?: string;
  meta?: Record<string, unknown>;
  /** Defaults to now; settable so tests and backfills can place a call on a specific day. */
  at?: Date;
};

export async function recordExternalCall(db: Db, call: ExternalCall): Promise<void> {
  await db.insert(externalCalls).values({
    service: call.service,
    operation: call.operation,
    units: String(call.units),
    unit: call.unit,
    costEur: call.costEur.toFixed(6),
    runId: call.runId ?? null,
    tileId: call.tileId ?? null,
    stage: call.stage ?? null,
    meta: call.meta ?? {},
    ...(call.at ? { at: call.at } : {}),
  });
}

function utcDayStart(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
}

/** Spend of one service on the UTC day containing `day` (default: today). */
export async function dailySpendEur(db: Db, service: string, day: Date = new Date()): Promise<number> {
  const start = utcDayStart(day);
  const end = new Date(start.getTime() + 24 * 3_600_000);
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${externalCalls.costEur}), 0)` })
    .from(externalCalls)
    .where(and(eq(externalCalls.service, service), gte(externalCalls.at, start), lt(externalCalls.at, end)));
  return Number(row?.total ?? 0);
}

export class BudgetExceeded extends Error {
  constructor(
    readonly service: BudgetService,
    readonly spentEur: number,
    readonly budgetEur: number,
  ) {
    super(`Daily budget for ${service} exceeded: ${spentEur} of ${budgetEur} EUR`);
    this.name = "BudgetExceeded";
  }
}

export async function assertWithinBudget(
  db: Db,
  service: BudgetService,
  budgets: AppConfig["budgets"] = getConfig().budgets,
  now: Date = new Date(),
): Promise<void> {
  const budgetEur = budgets[service].dailyEur;
  const spentEur = await dailySpendEur(db, service, now);
  if (spentEur >= budgetEur) throw new BudgetExceeded(service, spentEur, budgetEur);
}

export type BudgetStatus = { service: BudgetService; spentEur: number; budgetEur: number; ratio: number };

export async function budgetStatus(
  db: Db,
  budgets: AppConfig["budgets"] = getConfig().budgets,
  now: Date = new Date(),
): Promise<BudgetStatus[]> {
  return Promise.all(
    BUDGET_SERVICES.map(async (service) => {
      const budgetEur = budgets[service].dailyEur;
      const spentEur = await dailySpendEur(db, service, now);
      return { service, spentEur, budgetEur, ratio: budgetEur > 0 ? spentEur / budgetEur : 1 };
    }),
  );
}

/** Spend per service over the last `days` days up to `now`, highest first. */
export async function spendByService(
  db: Db,
  days = 30,
  now: Date = new Date(),
): Promise<Array<{ service: string; costEur: number }>> {
  const since = new Date(now.getTime() - days * 24 * 3_600_000);
  const rows = await db
    .select({ service: externalCalls.service, total: sql<string>`sum(${externalCalls.costEur})` })
    .from(externalCalls)
    .where(and(gte(externalCalls.at, since), lt(externalCalls.at, new Date(now.getTime() + 1))))
    .groupBy(externalCalls.service);
  return rows.map((r) => ({ service: r.service, costEur: Number(r.total) })).sort((a, b) => b.costEur - a.costEur);
}
