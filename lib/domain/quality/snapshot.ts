import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { QualityConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { qualitySnapshots, runs, type MetricKey } from "@/lib/db/schema";
import { measurementParams, QUALITY_MEASURE_STAGE } from "@/lib/pipeline/quality-stages";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
import {
  costPerPlaceMetric,
  coverageMetric,
  factPrecisionMetric,
  highlightShareMetric,
  multiDocumentMetric,
  marinaServicesMetric,
  multiSourceMetric,
  placeConfirmationMetric,
  placesPerTileMetric,
  placeWebsitesMetric,
  quoteFidelityMetric,
  recentObservationShareMetric,
  reviewEffortMetrics,
  routeReconstructionMetric,
  shelterConfidenceMetric,
  type MeasureWindow,
  type MetricResult,
  type QualityScope,
} from "./metrics";

/*
 * A measurement (spec 10 „Snapshots … gespeichert in quality_snapshots (run_id, scope, metric, value, details)“): one
 * run of the stage `quality.measure` per subdivision, with a label and a window in its params; its snapshot rows are one
 * per metric of the subdivision and one per tile metric of each tile labelled with the subdivision. `coverage_navily` comes from `compare:navily
 * --coverage` (Navily data only at runtime), never from here. Details hold counts and own ids only (Grundprinzip 9).
 */

/**
 * The metrics computed per tile (the others need the whole subdivision: the comparison of a tile's few places says little).
 * `multi_document` is the acceptance metric (ruling M7-P12), so tiles have it too (ruling M7-D-R1).
 */
export const TILE_METRICS = [
  "coverage",
  "multi_source",
  "multi_document",
  "fact_precision",
  "shelter_confidence",
  "cost_per_place",
  "highlight_share",
  "recent_observation_share",
] as const satisfies readonly MetricKey[];

export type MeasurementView = {
  runId: string;
  label: string;
  from: Date;
  to: Date;
  createdAt: Date;
  metrics: Partial<Record<MetricKey, { value: number | null; details: Record<string, unknown> }>>;
};

/** Metrics of one scope, in the order of TILE_METRICS. */
async function tileMetrics(db: Db, scope: QualityScope, window: MeasureWindow, today: string, cfg: QualityConfig): Promise<MetricResult[]> {
  return [
    await coverageMetric(db, scope, { today }),
    await multiSourceMetric(db, scope, { today }),
    await multiDocumentMetric(db, scope, { today }),
    await factPrecisionMetric(db, scope),
    await shelterConfidenceMetric(db, scope, cfg, { today }),
    await costPerPlaceMetric(db, scope, window, { today }),
    await highlightShareMetric(db, scope, { today }),
    await recentObservationShareMetric(db, scope, { today, months: cfg.recentObservationMonths }),
  ];
}

/**
 * Computes and stores the snapshot of measurement run `runId` for the subdivision: subdivision rows for every metric
 * except `coverage_navily`, tile rows for `TILE_METRICS` of each coast tile labelled with the subdivision and valid on
 * `today`. All
 * validity (places, tiles, sources) is judged on `today`, the job's UTC date (ruling M7-D-R2). All in one REPEATABLE
 * READ transaction, so every metric reads the same snapshot while consolidations or reviews commit (final review A
 * M-2), under a lock on the run: when rows of the run exist already (a retried job), nothing is written (`skipped`).
 */
export async function computeQualitySnapshot(
  db: Db,
  input: { runId: string; subdivisionKey: string; window: MeasureWindow; today: string; cfg?: QualityConfig },
): Promise<{ rows: number; skipped: boolean }> {
  const cfg = input.cfg ?? getConfig().quality;
  const { window, today, subdivisionKey } = input;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`snapshot:${input.runId}`}))`);
    const [existing] = await tx.select({ id: qualitySnapshots.id }).from(qualitySnapshots).where(eq(qualitySnapshots.runId, input.runId)).limit(1);
    if (existing) return { rows: 0, skipped: true };

    const scope = { subdivisionKey };
    const [coverage, multiSource, multiDocument, factPrecision, shelter, cost, highlight, recent] = await tileMetrics(tx, scope, window, today, cfg);
    const [reviewMinutes, reviewPer100] = await reviewEffortMetrics(tx, window, cfg, { today });
    const subdivision: MetricResult[] = [
      coverage!,
      multiSource!,
      multiDocument!,
      factPrecision!,
      await quoteFidelityMetric(tx, window),
      shelter!,
      await routeReconstructionMetric(tx, scope, { today }),
      cost!,
      reviewMinutes,
      reviewPer100,
      highlight!,
      recent!,
      await placesPerTileMetric(tx, subdivisionKey, cfg, { today }),
      await placeConfirmationMetric(tx, scope, { today }),
      await placeWebsitesMetric(tx, scope, { today }),
      await marinaServicesMetric(tx, scope, { today }),
    ];
    const rows: Array<typeof qualitySnapshots.$inferInsert> = subdivision.map((m) => ({
      runId: input.runId,
      scopeType: "subdivision",
      scopeId: subdivisionKey,
      metric: m.metric,
      value: m.value,
      details: m.details,
    }));

    const sub = await subdivisionByKey(tx, subdivisionKey);
    if (sub) {
      const { rows: tiles } = await tx.execute<{ id: string }>(sql`
        select id from tiles where subdivision_id = ${sub.id} and has_coast and (valid_to is null or valid_to > ${today}::date) order by id`);
      for (const { id: tileId } of tiles) {
        for (const m of await tileMetrics(tx, { subdivisionKey, tileId }, window, today, cfg)) {
          rows.push({ runId: input.runId, scopeType: "tile", scopeId: tileId, metric: m.metric, value: m.value, details: m.details });
        }
      }
    }
    // under REPEATABLE READ the lock's statement fixes the snapshot before it waits, so a concurrent retry that
    // committed meanwhile is not seen by the check above: its rows conflict. ON CONFLICT DO NOTHING against a row
    // committed after our snapshot raises 40001 (serialization failure) instead of skipping; that is the same
    // "already measured": this attempt writes nothing
    try {
      const inserted = await tx.insert(qualitySnapshots).values(rows).onConflictDoNothing().returning({ id: qualitySnapshots.id });
      return inserted.length === 0 && rows.length > 0 ? { rows: 0, skipped: true } : { rows: inserted.length, skipped: false };
    } catch (e) {
      if (isSerializationFailure(e)) return { rows: 0, skipped: true };
      throw e;
    }
  }, { isolationLevel: "repeatable read" });
}

/** SQLSTATE 40001, on the error itself or on its `cause` (drizzle wraps driver errors). */
export function isSerializationFailure(e: unknown): boolean {
  for (let err = e, i = 0; err instanceof Error && i < 3; err = err.cause, i++) {
    if ((err as { code?: unknown }).code === "40001") return true;
  }
  return false;
}

type MeasurementRun = { id: string; params: unknown; createdAt: Date };

/** The measurement runs of the subdivision, newest first (`label`: only that one). */
function measurementRuns(db: Db, subdivisionKey: string, o: { label?: string; limit?: number } = {}): Promise<MeasurementRun[]> {
  const q = db
    .select({ id: runs.id, params: runs.params, createdAt: runs.createdAt })
    .from(runs)
    .where(
      and(
        eq(runs.scopeType, "subdivision"),
        eq(runs.scopeId, subdivisionKey),
        sql`${QUALITY_MEASURE_STAGE} = any(${runs.stages})`,
        o.label === undefined ? undefined : sql`${runs.params} ->> 'label' = ${o.label}`,
        sql`exists (select 1 from quality_snapshots q where q.run_id = ${runs.id})`,
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id));
  return o.limit === undefined ? q : q.limit(o.limit);
}

/** Measurement views (subdivision rows) of the runs, in the given order. */
async function views(db: Db, subdivisionKey: string, list: MeasurementRun[]): Promise<MeasurementView[]> {
  if (list.length === 0) return [];
  const rows = await db
    .select({ runId: qualitySnapshots.runId, metric: qualitySnapshots.metric, value: qualitySnapshots.value, details: qualitySnapshots.details })
    .from(qualitySnapshots)
    .where(and(inArray(qualitySnapshots.runId, list.map((r) => r.id)), eq(qualitySnapshots.scopeType, "subdivision"), eq(qualitySnapshots.scopeId, subdivisionKey)))
    .orderBy(asc(qualitySnapshots.metric));
  return list.map((run) => {
    const { label, from, to } = measurementParams(run.params as Record<string, unknown>);
    const metrics = Object.fromEntries(rows.filter((r) => r.runId === run.id).map((r) => [r.metric, { value: r.value, details: r.details }]));
    return { runId: run.id, label, from, to, createdAt: run.createdAt, metrics };
  });
}

/** The newest measurement of the subdivision that has stored its snapshot; null without one. */
export async function latestMeasurement(db: Db, subdivisionKey: string): Promise<MeasurementView | null> {
  return (await views(db, subdivisionKey, await measurementRuns(db, subdivisionKey, { limit: 1 })))[0] ?? null;
}

/** The newest `limit` measurements of the subdivision with a stored snapshot, newest first. */
export async function listMeasurements(db: Db, subdivisionKey: string, limit: number): Promise<MeasurementView[]> {
  return views(db, subdivisionKey, await measurementRuns(db, subdivisionKey, { limit }));
}

/** The measurement of the subdivision with this label (with a stored snapshot); null without one. */
export async function measurementByLabel(db: Db, subdivisionKey: string, label: string): Promise<MeasurementView | null> {
  return (await views(db, subdivisionKey, await measurementRuns(db, subdivisionKey, { label, limit: 1 })))[0] ?? null;
}

/** The tile rows of a measurement, by tile id. */
export async function tileSnapshots(db: Db, runId: string): Promise<Array<{ tileId: string; metrics: Partial<Record<MetricKey, number | null>> }>> {
  const rows = await db
    .select({ tileId: qualitySnapshots.scopeId, metric: qualitySnapshots.metric, value: qualitySnapshots.value })
    .from(qualitySnapshots)
    .where(and(eq(qualitySnapshots.runId, runId), eq(qualitySnapshots.scopeType, "tile")))
    .orderBy(asc(qualitySnapshots.scopeId), asc(qualitySnapshots.metric));
  const byTile = new Map<string, Partial<Record<MetricKey, number | null>>>();
  for (const r of rows) byTile.set(r.tileId, { ...(byTile.get(r.tileId) ?? {}), [r.metric]: r.value });
  return [...byTile].map(([tileId, metrics]) => ({ tileId, metrics }));
}

export type MetricStatus = "met" | "missed" | "no_target" | "no_value";

/**
 * The status of a metric value against its target of `level` (`config/quality.json` `targets`): no target (metric
 * without one, or none at that level) → `no_target`; no value → `no_value`; `direction min`: met when `value ≥
 * target`; `max`: met when `value < target` (spec „unter 2 €“).
 */
export function metricStatus(metric: MetricKey, value: number | null, cfg: QualityConfig, level: "pilot" | "full"): MetricStatus {
  const targets = cfg.targets as Partial<Record<MetricKey, { pilot: number | null; full: number | null; direction: "min" | "max" }>>;
  const t = Object.hasOwn(targets, metric) ? targets[metric] : undefined;
  const target = t?.[level] ?? null;
  if (!t || target === null) return "no_target";
  if (value === null) return "no_value";
  return (t.direction === "min" ? value >= target : value < target) ? "met" : "missed";
}

/**
 * The snapshot of measurement run `runId`, from its params (subdivision, window); `today` (validity, recency) is the UTC date
 * of `now`. Throws for an unknown run or invalid params.
 */
export async function computeMeasurement(db: Db, runId: string, now: Date = new Date()): Promise<{ rows: number; skipped: boolean; subdivisionKey: string }> {
  const [run] = await db.select({ params: runs.params }).from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  const { subdivisionKey, from, to } = measurementParams(run.params as Record<string, unknown>);
  const result = await computeQualitySnapshot(db, { runId, subdivisionKey, window: { from, to }, today: now.toISOString().slice(0, 10) });
  return { ...result, subdivisionKey };
}
