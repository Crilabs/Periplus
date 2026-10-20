import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { QualityConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { qualitySnapshots, runs, type MetricKey } from "@/lib/db/schema";
import { measurementParams, QUALITY_MEASURE_STAGE } from "@/lib/pipeline/quality-stages";
import { areaGeoObjectId } from "@/lib/pipeline/tile-scope";
import {
  costPerPlaceMetric,
  coverageMetric,
  factPrecisionMetric,
  highlightShareMetric,
  multiDocumentMetric,
  multiSourceMetric,
  placesPerTileMetric,
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
 * run of the stage `quality.measure` per area, with a label and a window in its params; its snapshot rows are one per
 * metric of the area and one per tile metric of each tile of the area. `coverage_navily` comes from `compare:navily
 * --coverage` (Navily data only at runtime), never from here. Details hold counts and own ids only (Grundprinzip 9).
 */

/** The metrics computed per tile (the others need the whole area: the comparison of a tile's few places says little). */
export const TILE_METRICS = [
  "coverage",
  "multi_source",
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
    await coverageMetric(db, scope),
    await multiSourceMetric(db, scope, { today }),
    await factPrecisionMetric(db, scope),
    await shelterConfidenceMetric(db, scope, cfg, { today }),
    await costPerPlaceMetric(db, scope, window),
    await highlightShareMetric(db, scope),
    await recentObservationShareMetric(db, scope, { today, months: cfg.recentObservationMonths }),
  ];
}

/**
 * Computes and stores the snapshot of measurement run `runId` for the area: area rows for every metric except
 * `coverage_navily`, tile rows for `TILE_METRICS` of each valid tile labelled with the area. All in one transaction,
 * under a lock on the run: when rows of the run exist already (a retried job), nothing is written (`skipped`).
 */
export async function computeQualitySnapshot(
  db: Db,
  input: { runId: string; areaKey: string; window: MeasureWindow; today: string; cfg?: QualityConfig },
): Promise<{ rows: number; skipped: boolean }> {
  const cfg = input.cfg ?? getConfig().quality;
  const { window, today, areaKey } = input;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`snapshot:${input.runId}`}))`);
    const [existing] = await tx.select({ id: qualitySnapshots.id }).from(qualitySnapshots).where(eq(qualitySnapshots.runId, input.runId)).limit(1);
    if (existing) return { rows: 0, skipped: true };

    const scope = { areaKey };
    const [coverage, multiSource, factPrecision, shelter, cost, highlight, recent] = await tileMetrics(tx, scope, window, today, cfg);
    const [reviewMinutes, reviewPer100] = await reviewEffortMetrics(tx, window, cfg);
    const area: MetricResult[] = [
      coverage!,
      multiSource!,
      await multiDocumentMetric(tx, scope, { today }),
      factPrecision!,
      await quoteFidelityMetric(tx, window),
      shelter!,
      await routeReconstructionMetric(tx, scope, { today }),
      cost!,
      reviewMinutes,
      reviewPer100,
      highlight!,
      recent!,
      await placesPerTileMetric(tx, areaKey, cfg),
    ];
    const rows: Array<typeof qualitySnapshots.$inferInsert> = area.map((m) => ({
      runId: input.runId,
      scopeType: "area",
      scopeId: areaKey,
      metric: m.metric,
      value: m.value,
      details: m.details,
    }));

    const areaId = await areaGeoObjectId(tx, areaKey);
    if (areaId) {
      const { rows: tiles } = await tx.execute<{ id: string }>(sql`
        select id from tiles where area_id = ${areaId} and (valid_to is null or valid_to > current_date) order by id`);
      for (const { id: tileId } of tiles) {
        for (const m of await tileMetrics(tx, { areaKey, tileId }, window, today, cfg)) {
          rows.push({ runId: input.runId, scopeType: "tile", scopeId: tileId, metric: m.metric, value: m.value, details: m.details });
        }
      }
    }
    await tx.insert(qualitySnapshots).values(rows);
    return { rows: rows.length, skipped: false };
  });
}

type MeasurementRun = { id: string; params: unknown; createdAt: Date };

/** The measurement runs of the area, newest first (`label`: only that one). */
function measurementRuns(db: Db, areaKey: string, o: { label?: string; limit?: number } = {}): Promise<MeasurementRun[]> {
  const q = db
    .select({ id: runs.id, params: runs.params, createdAt: runs.createdAt })
    .from(runs)
    .where(
      and(
        eq(runs.scopeType, "area"),
        eq(runs.scopeId, areaKey),
        sql`${QUALITY_MEASURE_STAGE} = any(${runs.stages})`,
        o.label === undefined ? undefined : sql`${runs.params} ->> 'label' = ${o.label}`,
        sql`exists (select 1 from quality_snapshots q where q.run_id = ${runs.id})`,
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id));
  return o.limit === undefined ? q : q.limit(o.limit);
}

/** Measurement views (area rows) of the runs, in the given order. */
async function views(db: Db, areaKey: string, list: MeasurementRun[]): Promise<MeasurementView[]> {
  if (list.length === 0) return [];
  const rows = await db
    .select({ runId: qualitySnapshots.runId, metric: qualitySnapshots.metric, value: qualitySnapshots.value, details: qualitySnapshots.details })
    .from(qualitySnapshots)
    .where(and(inArray(qualitySnapshots.runId, list.map((r) => r.id)), eq(qualitySnapshots.scopeType, "area"), eq(qualitySnapshots.scopeId, areaKey)))
    .orderBy(asc(qualitySnapshots.metric));
  return list.map((run) => {
    const { label, from, to } = measurementParams(run.params as Record<string, unknown>);
    const metrics = Object.fromEntries(rows.filter((r) => r.runId === run.id).map((r) => [r.metric, { value: r.value, details: r.details }]));
    return { runId: run.id, label, from, to, createdAt: run.createdAt, metrics };
  });
}

/** The newest measurement of the area that has stored its snapshot; null without one. */
export async function latestMeasurement(db: Db, areaKey: string): Promise<MeasurementView | null> {
  return (await views(db, areaKey, await measurementRuns(db, areaKey, { limit: 1 })))[0] ?? null;
}

/** The newest `limit` measurements of the area with a stored snapshot, newest first. */
export async function listMeasurements(db: Db, areaKey: string, limit: number): Promise<MeasurementView[]> {
  return views(db, areaKey, await measurementRuns(db, areaKey, { limit }));
}

/** The measurement of the area with this label (with a stored snapshot); null without one. */
export async function measurementByLabel(db: Db, areaKey: string, label: string): Promise<MeasurementView | null> {
  return (await views(db, areaKey, await measurementRuns(db, areaKey, { label, limit: 1 })))[0] ?? null;
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
 * The snapshot of measurement run `runId`, from its params (area, window); `today` (validity, recency) is the UTC date
 * of `now`. Throws for an unknown run or invalid params.
 */
export async function computeMeasurement(db: Db, runId: string, now: Date = new Date()): Promise<{ rows: number; skipped: boolean; areaKey: string }> {
  const [run] = await db.select({ params: runs.params }).from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  const { areaKey, from, to } = measurementParams(run.params as Record<string, unknown>);
  const result = await computeQualitySnapshot(db, { runId, areaKey, window: { from, to }, today: now.toISOString().slice(0, 10) });
  return { ...result, areaKey };
}
