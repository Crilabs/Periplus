import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { aiBatches, externalCalls } from "@/lib/db/schema";
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
  /** Source the call was made for: `external_calls.source_id` (costs per source). */
  sourceId?: string;
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
    sourceId: call.sourceId ?? null,
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

/**
 * Throws `BudgetExceeded` when today's spend of the service, plus `reservedEur` already promised to calls whose cost is
 * not booked yet (open message batches, ruling M4-C-R5), has reached its daily budget.
 */
export async function assertWithinBudget(
  db: Db,
  service: BudgetService,
  budgets: AppConfig["budgets"] = getConfig().budgets,
  now: Date = new Date(),
  reservedEur = 0,
): Promise<void> {
  const budgetEur = budgets[service].dailyEur;
  const committedEur = (await dailySpendEur(db, service, now)) + reservedEur;
  if (committedEur >= budgetEur) throw new BudgetExceeded(service, committedEur, budgetEur);
}

/** Which batches a reservation sum covers: all (production) or only some runs (tests, ruling M4-P23). */
export type ReservationScope = { runIds: string[] };

/**
 * The anthropic budget still promised to message batches whose cost is not booked yet (rulings M4-P6, M4-C-R5): the
 * `estimated_cost_eur` of every batch that is not sent, being sent or running (`submitting`, `sending`, `submitted`),
 * plus failed batches the provider may still bill (sent, never collected). Batches older than `hours` no longer count:
 * the provider has ended them long ago, and a booking that never came must not block the budget for good.
 */
export async function reservedBatchEur(
  db: Db,
  opts: { now: Date; hours: number; scope?: ReservationScope },
): Promise<number> {
  const since = new Date(opts.now.getTime() - opts.hours * 3_600_000);
  const [row] = await db
    .select({ reserved: sql<string>`coalesce(sum(${aiBatches.estimatedCostEur}), 0)` })
    .from(aiBatches)
    .where(
      and(
        gt(aiBatches.createdAt, since),
        or(
          inArray(aiBatches.status, ["submitting", "sending", "submitted"]),
          and(eq(aiBatches.status, "failed"), isNotNull(aiBatches.providerBatchId), isNull(aiBatches.endedAt)),
        ),
        opts.scope ? inArray(aiBatches.runId, opts.scope.runIds.length > 0 ? opts.scope.runIds : [NO_RUN]) : undefined,
      ),
    );
  return Number(row?.reserved ?? 0);
}

const NO_RUN = "00000000-0000-0000-0000-000000000000";

export type BudgetStatus = { service: BudgetService; spentEur: number; budgetEur: number; ratio: number };

export async function budgetStatus(
  db: Db,
  budgets: AppConfig["budgets"] = getConfig().budgets,
  now: Date = new Date(),
): Promise<BudgetStatus[]> {
  // One query after another: `db` may be a transaction, whose single connection must not run queries concurrently.
  const status: BudgetStatus[] = [];
  for (const service of BUDGET_SERVICES) {
    const budgetEur = budgets[service].dailyEur;
    const spentEur = await dailySpendEur(db, service, now);
    status.push({ service, spentEur, budgetEur, ratio: budgetEur > 0 ? spentEur / budgetEur : 1 });
  }
  return status;
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

export type SpendBreakdownBy = "stage" | "run" | "month";
export type SpendBreakdownRow = { key: string; costEur: number; calls: number };

/**
 * Spend and call count over the last `days` days (default 30) up to `now`, grouped by stage, run or
 * UTC month (`YYYY-MM`). Calls without a stage or run are left out of those groupings. Stages and runs
 * come highest cost first, months newest first.
 */
export async function spendBreakdown(
  db: Db,
  by: SpendBreakdownBy,
  opts: { days?: number; now?: Date } = {},
): Promise<SpendBreakdownRow[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? 30) * 24 * 3_600_000);
  const key =
    by === "stage"
      ? sql<string>`${externalCalls.stage}`
      : by === "run"
        ? sql<string>`${externalCalls.runId}::text`
        : sql<string>`to_char(${externalCalls.at} at time zone 'UTC', 'YYYY-MM')`;
  const rows = await db
    .select({ key, total: sql<string>`sum(${externalCalls.costEur})`, calls: sql<number>`count(*)::int` })
    .from(externalCalls)
    .where(
      and(
        gte(externalCalls.at, since),
        lt(externalCalls.at, new Date(now.getTime() + 1)),
        by === "stage" ? isNotNull(externalCalls.stage) : by === "run" ? isNotNull(externalCalls.runId) : undefined,
      ),
    )
    .groupBy(key);
  const result = rows.map((r) => ({ key: r.key, costEur: Number(r.total), calls: r.calls }));
  return by === "month"
    ? result.sort((a, b) => b.key.localeCompare(a.key))
    : result.sort((a, b) => b.costEur - a.costEur || a.key.localeCompare(b.key));
}
