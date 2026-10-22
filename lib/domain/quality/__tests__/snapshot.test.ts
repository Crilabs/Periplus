import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { METRIC_KEYS, qualitySnapshots, type MetricKey } from "@/lib/db/schema";
import { createRun } from "@/lib/domain/runs";
import { newId } from "@/lib/domain/ids";
import { qualityMeasureHandler } from "@/lib/jobs/handlers/quality";
import type { JobContext } from "@/lib/jobs/worker";
import { QUALITY_MEASURE_STAGE } from "@/lib/pipeline/quality-stages";
import { insertMention, insertProfile, insertSource } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { quietDay } from "@/test/external-calls";
import { insertQualitySubdivision, NAVILY_MARKERS, rowsWrittenInTransaction } from "@/test/quality";
import {
  computeQualitySnapshot,
  isSerializationFailure,
  latestMeasurement,
  listMeasurements,
  measurementByLabel,
  metricStatus,
  TILE_METRICS,
  tileSnapshots,
} from "../snapshot";

// Measurements of a synthetic subdivision at 21.0–21.3° E / 35.2° N (outside the pilot box), rolled back; the window is a
// far-future day nobody else writes to, so spend, review and run sums are never DB-wide.

const quality = getConfig().quality;
const DAY_MS = 24 * 3_600_000;
const WEST = { lon: 21.01, lat: 35.2 };
const EAST = { lon: 21.26, lat: 35.2 };
const SUBDIVISION_METRICS = METRIC_KEYS.filter((m) => m !== "coverage_navily");

async function scene(tx: Db) {
  const from = await quietDay(tx);
  const window = { from, to: new Date(from.getTime() + DAY_MS) };
  const sub = await insertQualitySubdivision(tx, [WEST, EAST]);
  const [s1, s2] = [await insertSource(tx), await insertSource(tx)];
  for (let i = 0; i < 3; i++) {
    const p = await sub.addPlace({ inSet: true });
    await insertMention(tx, p.geoObjectId, { sourceId: s1 });
    if (i === 0) await insertMention(tx, p.geoObjectId, { sourceId: s2 });
    await insertProfile(tx, p.geoObjectId, { "highlight.food": { present: i === 0, names: [] } }, {});
  }
  await sub.addPlace({ at: EAST });
  return { ...sub, window };
}

/** A measurement run of the subdivision, as `startMeasurement` creates it. */
async function measurementRun(tx: Db, subdivisionKey: string, label: string, window: { from: Date; to: Date }) {
  const { id } = await createRun(tx, {
    kind: "stage",
    scope: { type: "subdivision", id: subdivisionKey },
    stages: [QUALITY_MEASURE_STAGE],
    params: { subdivisionKey, label, from: window.from.toISOString(), to: window.to.toISOString() },
    triggeredBy: "test",
  });
  return id;
}

const rowsOf = (tx: Db, runId: string) => tx.select().from(qualitySnapshots).where(eq(qualitySnapshots.runId, runId));

describe("computeQualitySnapshot", () => {
  it("a measurement writes subdivision rows for 16 metrics and tile rows for 8", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, tileIds, window } = await scene(tx);
      const runId = await measurementRun(tx, subdivisionKey, "Lauf 1", window);
      const r = await computeQualitySnapshot(tx, { runId, subdivisionKey, window, today: "2026-10-20", cfg: quality });
      // 16 subdivision metrics (the place metrics of specs 16 and 17 among them): every key but coverage_navily, multi_document included (ruling M7-P30)
      expect(SUBDIVISION_METRICS).toHaveLength(16);
      // multi_document is the acceptance metric (ruling M7-P12), so tiles have it too (ruling M7-D-R1)
      expect(TILE_METRICS).toContain("multi_document");
      expect(r).toEqual({ rows: 16 + 2 * 8, skipped: false });

      const rows = await rowsOf(tx, runId);
      const subRows = rows.filter((x) => x.scopeType === "subdivision");
      expect(subRows.every((x) => x.scopeId === subdivisionKey)).toBe(true);
      expect(subRows.map((x) => x.metric).sort()).toEqual([...SUBDIVISION_METRICS].sort());
      for (const tileId of tileIds) {
        expect(rows.filter((x) => x.scopeType === "tile" && x.scopeId === tileId).map((x) => x.metric).sort()).toEqual([...TILE_METRICS].sort());
      }
      const value = (metric: MetricKey, scopeId = subdivisionKey) => rows.find((x) => x.metric === metric && x.scopeId === scopeId)!.value;
      expect(value("coverage")).toBe(1);
      expect(value("multi_source")).toBeCloseTo(1 / 4);
      expect(value("multi_document")).toBeCloseTo(1 / 4);
      expect(value("highlight_share")).toBeCloseTo(1 / 4);
      expect(value("highlight_share", tileIds[0])).toBeCloseTo(1 / 3);
      expect(value("highlight_share", tileIds[1])).toBe(0);
      expect(value("places_per_tile")).toBe(2);
      // nothing measured in the quiet window: no spend per place yet, no review effort, no text runs
      expect([value("cost_per_place"), value("review_minutes"), value("quote_fidelity")]).toEqual([0, 0, null]);
    }));

  it("tile rows are written for coast tiles valid on the measurement date only (ruling M7-D-R2)", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, tileIds, window } = await scene(tx);
      const third = await insertQualitySubdivision(tx, [{ lon: 21.51, lat: 35.2 }]);
      await tx.execute(sql`update tiles set subdivision_id = (select subdivision_id from tiles where id = ${tileIds[0]!}) where id = ${third.tileIds[0]!}`);
      // the east tile has no coast; the third tile ends on 2030-12-01, valid on the database date but not on today
      await tx.execute(sql`update tiles set has_coast = false where id = ${tileIds[1]!}`);
      await tx.execute(sql`update tiles set valid_to = '2030-12-01' where id = ${third.tileIds[0]!}`);
      const runId = await measurementRun(tx, subdivisionKey, "Lauf 1", window);
      await computeQualitySnapshot(tx, { runId, subdivisionKey, window, today: "2031-01-01", cfg: quality });
      const tileRows = (await rowsOf(tx, runId)).filter((x) => x.scopeType === "tile");
      expect([...new Set(tileRows.map((x) => x.scopeId))]).toEqual([tileIds[0]]);
    }));

  it("a measurement reads all its metrics from one snapshot: a repeatable read transaction (final review A M-2)", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, window } = await scene(tx);
      const runId = await measurementRun(tx, subdivisionKey, "Lauf 1", window);
      const configs: unknown[] = [];
      // the test transaction runs the nested one as a savepoint; the proxy records the options it was asked for
      const db = new Proxy(tx, {
        get: (target, prop, receiver) =>
          prop === "transaction"
            ? (fn: (t: Db) => Promise<unknown>, config?: unknown) => {
                configs.push(config);
                return target.transaction(fn);
              }
            : Reflect.get(target, prop, receiver),
      });
      expect((await computeQualitySnapshot(db, { runId, subdivisionKey, window, today: "2026-10-20", cfg: quality })).skipped).toBe(false);
      expect(configs).toEqual([{ isolationLevel: "repeatable read" }]);
    }));

  it("a retried job writes nothing twice", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, window } = await scene(tx);
      const runId = await measurementRun(tx, subdivisionKey, "Lauf 1", window);
      const logs: Array<Record<string, unknown>> = [];
      const ctx = { db: tx, runId, jobId: newId(), log: { info: (f: Record<string, unknown>) => void logs.push(f), warn: () => undefined, error: () => undefined } };
      const job = { key: subdivisionKey, subdivisionKey, runId, stage: QUALITY_MEASURE_STAGE };
      await qualityMeasureHandler(job, ctx as unknown as JobContext);
      const first = (await rowsOf(tx, runId)).length;
      expect(first).toBe(16 + 2 * 8);
      await qualityMeasureHandler(job, ctx as unknown as JobContext);
      expect((await rowsOf(tx, runId)).length).toBe(first);
      expect(logs).toEqual([
        { runId, subdivisionKey, rows: first, skipped: false },
        { runId, subdivisionKey, rows: 0, skipped: true },
      ]);
      expect(await computeQualitySnapshot(tx, { runId, subdivisionKey, window, today: "2026-10-20" })).toEqual({ rows: 0, skipped: true });
    }));

  it("a serialization failure (40001), also wrapped as a cause, is recognised; other errors are not", () => {
    expect(isSerializationFailure(Object.assign(new Error("could not serialize"), { code: "40001" }))).toBe(true);
    expect(isSerializationFailure(new Error("query failed", { cause: Object.assign(new Error("x"), { code: "40001" }) }))).toBe(true);
    expect(isSerializationFailure(Object.assign(new Error("dup"), { code: "23505" }))).toBe(false);
    expect(isSerializationFailure("40001")).toBe(false);
  });

  it("snapshot details hold counts and own ids only (Grundprinzip 9, ruling M7-P23)", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, window } = await scene(tx);
      const runId = await measurementRun(tx, subdivisionKey, "Lauf 1", window);
      await computeQualitySnapshot(tx, { runId, subdivisionKey, window, today: "2026-10-20" });
      const ownId = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|q025:\d+:\d+|\d{4}-\d{2}-\d{2})$/;
      const strings = (v: unknown): string[] =>
        typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
      for (const row of await rowsOf(tx, runId)) {
        for (const s of strings(row.details)) expect(s, `${row.metric}: ${s}`).toMatch(ownId);
      }
      for (const row of await rowsWrittenInTransaction(tx)) expect(row).not.toMatch(NAVILY_MARKERS);
    }));
});

describe("measurement views", () => {
  it("latest, list, by label and tile rows read stored measurements of the subdivision", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, tileIds, window } = await scene(tx);
      expect(await latestMeasurement(tx, subdivisionKey)).toBeNull();
      const first = await measurementRun(tx, subdivisionKey, "Lauf 1", window);
      await computeQualitySnapshot(tx, { runId: first, subdivisionKey, window, today: "2026-10-20" });
      const secondWindow = { from: window.to, to: new Date(window.to.getTime() + DAY_MS) };
      const second = await measurementRun(tx, subdivisionKey, "Lauf 2", secondWindow);
      await computeQualitySnapshot(tx, { runId: second, subdivisionKey, window: secondWindow, today: "2026-10-20" });
      // a measurement run without stored rows (queued) is not a measurement yet
      await measurementRun(tx, subdivisionKey, "Lauf 3", { from: secondWindow.to, to: new Date(secondWindow.to.getTime() + DAY_MS) });
      // ids are time ordered: the second run is the newest
      const latest = await latestMeasurement(tx, subdivisionKey);
      expect(latest).toMatchObject({ runId: second, label: "Lauf 2", from: secondWindow.from, to: secondWindow.to });
      expect(latest!.metrics.coverage).toEqual({ value: 1, details: { set: 3, confirmed: 3 } });
      expect(Object.keys(latest!.metrics).sort()).toEqual([...SUBDIVISION_METRICS].sort());
      expect((await listMeasurements(tx, subdivisionKey, 10)).map((m) => m.label)).toEqual(["Lauf 2", "Lauf 1"]);
      expect((await listMeasurements(tx, subdivisionKey, 1)).map((m) => m.label)).toEqual(["Lauf 2"]);
      expect((await measurementByLabel(tx, subdivisionKey, "Lauf 1"))?.runId).toBe(first);
      expect(await measurementByLabel(tx, subdivisionKey, "Lauf 3")).toBeNull();
      expect(await latestMeasurement(tx, `test-${newId()}`)).toBeNull();

      const tiles = await tileSnapshots(tx, first);
      expect(tiles.map((t) => t.tileId)).toEqual([...tileIds].sort());
      // the set lies in the west tile; the east tile has no set, so no coverage
      const of = (tileId: string) => tiles.find((t) => t.tileId === tileId)!.metrics;
      expect([of(tileIds[0]!).coverage, of(tileIds[1]!).coverage]).toEqual([1, null]);
      expect(Object.keys(of(tileIds[0]!)).sort()).toEqual([...TILE_METRICS].sort());
      const stored = await tx.select().from(qualitySnapshots).where(and(eq(qualitySnapshots.runId, first), eq(qualitySnapshots.scopeType, "tile")));
      expect(stored).toHaveLength(2 * TILE_METRICS.length);
    }));
});

describe("metricStatus", () => {
  it.each([
    ["coverage", 0.85, "pilot", "met"],
    ["coverage", 0.849, "pilot", "missed"],
    ["coverage", 0.9, "full", "missed"],
    ["cost_per_place", 2.0, "pilot", "missed"],
    ["cost_per_place", 1.99, "pilot", "met"],
    ["review_minutes_per_100", 25, "pilot", "no_target"],
    ["review_minutes_per_100", 25, "full", "met"],
    ["highlight_share", 0.4, "pilot", "no_target"],
    ["quote_fidelity", null, "pilot", "no_value"],
    ["multi_document", 0.7, "pilot", "met"],
  ] as const)("metricStatus %s %s %s → %s", (m, v, l, s) => expect(metricStatus(m, v, quality, l)).toBe(s));
});
