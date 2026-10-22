import { getConfig } from "@/lib/config";
import type { QualityConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { METRIC_KEYS, type MetricKey } from "@/lib/db/schema";
import { loadComparisonSubjects } from "./comparison-values";
import { factPrecisionMetric } from "./metrics";
import { latestMeasurement, listMeasurements, metricStatus, tileSnapshots, type MeasurementView, type MetricStatus } from "./snapshot";

/*
 * The quality dashboard `/quality` (spec 10): the newest measurement of a subdivision against the pilot and full-operation
 * targets of `config/quality.json`, the history of the last measurements, its tile rows and the state of the
 * comparison set. Read only; the page formats.
 */

/** Measurements shown in „Verlauf“. */
export const HISTORY_SIZE = 10;

/** How a metric's value reads: a share (percent), euro, minutes or a count. */
export type MetricUnit = "share" | "eur" | "minutes" | "count";

export const METRIC_UNITS: Record<MetricKey, MetricUnit> = {
  coverage: "share",
  coverage_navily: "share",
  multi_source: "share",
  multi_document: "share",
  fact_precision: "share",
  quote_fidelity: "share",
  shelter_confidence: "share",
  route_reconstruction: "share",
  cost_per_place: "eur",
  review_minutes: "minutes",
  review_minutes_per_100: "minutes",
  highlight_share: "share",
  recent_observation_share: "share",
  places_per_tile: "count",
  place_confirmation: "share",
  place_websites: "share",
  marina_services: "share",
};

export type DashboardRow = {
  metric: MetricKey;
  value: number | null;
  pilot: number | null;
  full: number | null;
  statusPilot: MetricStatus;
  statusFull: MetricStatus;
};

export type QualityDashboard = {
  latest: MeasurementView | null;
  /** The last `HISTORY_SIZE` measurements, oldest first. */
  history: MeasurementView[];
  /**
   * The newest measurement's tile rows, with the tile's confirmed places (`places_per_tile` details; null when the
   * measurement lists none) and whether that count lies outside `placesPerTile`.
   */
  tiles: Array<{ tileId: string; metrics: Partial<Record<MetricKey, number | null>>; places: number | null; outsideTarget: boolean }>;
  /** One row per metric (`METRIC_KEYS` order) with the newest measurement's value. */
  rows: DashboardRow[];
  /** The comparison set now: size, pilot target, attributes with an outcome for their current value, attributes without. */
  comparison: { setSize: number; target: number; checked: number; pending: number };
};

/** The dashboard of the subdivision (an unknown subdivision or one without measurements has empty parts). */
export async function qualityDashboard(db: Db, subdivisionKey: string, cfg: QualityConfig = getConfig().quality): Promise<QualityDashboard> {
  const latest = await latestMeasurement(db, subdivisionKey);
  const history = (await listMeasurements(db, subdivisionKey, HISTORY_SIZE)).reverse();
  const counts = new Map(
    ((latest?.metrics.places_per_tile?.details.tiles ?? []) as Array<{ tileId: string; places: number }>).map((t) => [t.tileId, Number(t.places)]),
  );
  const tiles = (latest ? await tileSnapshots(db, latest.runId) : []).map((t) => {
    const places = counts.get(t.tileId) ?? null;
    return { ...t, places, outsideTarget: places !== null && (places < cfg.placesPerTile.min || places > cfg.placesPerTile.max) };
  });
  const targets = cfg.targets as Partial<Record<MetricKey, { pilot: number | null; full: number | null }>>;
  const rows = METRIC_KEYS.map((metric): DashboardRow => {
    const value = latest?.metrics[metric]?.value ?? null;
    const target = Object.hasOwn(targets, metric) ? targets[metric] : undefined;
    return {
      metric,
      value,
      pilot: target?.pilot ?? null,
      full: target?.full ?? null,
      statusPilot: metricStatus(metric, value, cfg, "pilot"),
      statusFull: metricStatus(metric, value, cfg, "full"),
    };
  });
  const precision = await factPrecisionMetric(db, { subdivisionKey });
  const d = precision.details as { compared?: number; notAtNavily?: number; pending?: number };
  // 0 for an unknown subdivision
  const setSize = (await loadComparisonSubjects(db, subdivisionKey)).length;
  return {
    latest,
    history,
    tiles,
    rows,
    comparison: {
      setSize,
      target: cfg.comparisonSet.pilotSize,
      checked: Number(d.compared ?? 0) + Number(d.notAtNavily ?? 0),
      pending: Number(d.pending ?? 0),
    },
  };
}

/**
 * The numbers of a snapshot's `details` as `key: value` pairs for a tooltip (nested objects as `a.b`; strings, arrays
 * and booleans are left out, so ids never show). Numbers in German format.
 */
export function detailNumbers(details: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(details).flatMap(([k, v]) => {
    const name = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number") return [`${name}: ${v.toLocaleString("de-DE", { maximumFractionDigits: 3 })}`];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return detailNumbers(v as Record<string, unknown>, name);
    return [];
  });
}
