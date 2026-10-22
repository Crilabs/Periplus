import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { comparisonResults, qualitySnapshots, type MetricKey } from "@/lib/db/schema";
import { createRun } from "@/lib/domain/runs";
import { QUALITY_MEASURE_STAGE } from "@/lib/pipeline/quality-stages";
import { withRollback } from "@/test/db";
import { insertQualitySubdivision } from "@/test/quality";
import { comparisonValues, loadComparisonSubjects } from "../comparison-values";
import { detailNumbers, HISTORY_SIZE, qualityDashboard } from "../dashboard";

// The dashboard of a synthetic subdivision at 21.0° E / 35.2° N with snapshot rows inserted directly, rolled back.

const quality = getConfig().quality;

/** A measurement run of the subdivision with subdivision rows `metrics` (and tile rows `tiles`), as the measurement stores them. */
async function measurement(
  tx: Db,
  subdivisionKey: string,
  label: string,
  metrics: Partial<Record<MetricKey, { value: number | null; details?: Record<string, unknown> }>>,
  tiles: Record<string, Partial<Record<MetricKey, number | null>>> = {},
): Promise<string> {
  const { id } = await createRun(tx, {
    kind: "stage",
    scope: { type: "subdivision", id: subdivisionKey },
    stages: [QUALITY_MEASURE_STAGE],
    params: { subdivisionKey, label, from: "2026-10-01T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z" },
    triggeredBy: "test",
  });
  const rows: Array<typeof qualitySnapshots.$inferInsert> = Object.entries(metrics).map(([metric, m]) => ({
    runId: id,
    scopeType: "subdivision",
    scopeId: subdivisionKey,
    metric: metric as MetricKey,
    value: m!.value,
    details: m!.details ?? {},
  }));
  for (const [tileId, values] of Object.entries(tiles)) {
    for (const [metric, value] of Object.entries(values)) rows.push({ runId: id, scopeType: "tile", scopeId: tileId, metric: metric as MetricKey, value });
  }
  await tx.insert(qualitySnapshots).values(rows);
  return id;
}

describe("qualityDashboard", () => {
  it("the dashboard shows the latest measurement against pilot and full targets", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, tileIds, addPlace } = await insertQualitySubdivision(tx, [{ lon: 21.01, lat: 35.2 }, { lon: 21.26, lat: 35.2 }]);
      await measurement(tx, subdivisionKey, "Lauf 0", { coverage: { value: 0.5 } });
      const [west, east] = tileIds as [string, string];
      const runId = await measurement(
        tx,
        subdivisionKey,
        "Lauf 1",
        {
          coverage: { value: 0.9, details: { set: 10, confirmed: 9 } },
          cost_per_place: { value: 1.2 },
          review_minutes_per_100: { value: 45 },
          places_per_tile: { value: 23.5, details: { tiles: [{ tileId: west, places: 42 }, { tileId: east, places: 5 }] } },
        },
        { [west]: { coverage: 1 }, [east]: { coverage: null } },
      );
      const p = await addPlace({ inSet: true });
      const subject = (await loadComparisonSubjects(tx, subdivisionKey))[0]!;
      await tx.insert(comparisonResults).values({
        placeId: p.placeId,
        attribute: "existence",
        valueHash: comparisonValues(subject, quality.navily).existence.hash,
        result: "match",
        method: "manual",
        checkedBy: "test",
      });

      const d = await qualityDashboard(tx, subdivisionKey, quality);
      expect(d.latest).toMatchObject({ runId, label: "Lauf 1" });
      const row = (m: MetricKey) => d.rows.find((r) => r.metric === m)!;
      expect(row("coverage")).toEqual({ metric: "coverage", value: 0.9, pilot: 0.85, full: 0.95, statusPilot: "met", statusFull: "missed" });
      expect(row("cost_per_place")).toMatchObject({ value: 1.2, pilot: 2, full: 0.5, statusPilot: "met", statusFull: "missed" });
      expect(row("review_minutes_per_100")).toMatchObject({ pilot: null, full: 30, statusPilot: "no_target", statusFull: "missed" });
      expect(row("multi_document")).toMatchObject({ value: null, statusPilot: "no_value", statusFull: "no_value" });
      expect(row("highlight_share")).toMatchObject({ statusPilot: "no_target", statusFull: "no_target" });
      expect(d.rows.map((r) => r.metric)).toHaveLength(17);
      expect(d.tiles).toEqual([
        { tileId: west, metrics: { coverage: 1 }, places: 42, outsideTarget: true },
        { tileId: east, metrics: { coverage: null }, places: 5, outsideTarget: true },
      ]);
      expect(d.comparison).toEqual({ setSize: 1, target: 50, checked: 1, pending: 15 });
    }));

  it("history lists the last measurements oldest first", () =>
    withRollback(async (tx) => {
      const { subdivisionKey } = await insertQualitySubdivision(tx, [{ lon: 21.01, lat: 35.2 }]);
      for (let i = 1; i <= HISTORY_SIZE + 1; i++) await measurement(tx, subdivisionKey, `Lauf ${i}`, { coverage: { value: i / 100 } });
      // a queued measurement without rows is no measurement yet
      await createRun(tx, { kind: "stage", scope: { type: "subdivision", id: subdivisionKey }, stages: [QUALITY_MEASURE_STAGE], params: { subdivisionKey, label: "offen", from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z" }, triggeredBy: "test" });
      const d = await qualityDashboard(tx, subdivisionKey, quality);
      expect(d.history.map((m) => m.label)).toEqual(Array.from({ length: HISTORY_SIZE }, (_, i) => `Lauf ${i + 2}`));
      expect(d.latest!.label).toBe(`Lauf ${HISTORY_SIZE + 1}`);
    }));

  it("a subdivision without measurements has empty parts", () =>
    withRollback(async (tx) => {
      const { subdivisionKey } = await insertQualitySubdivision(tx, [{ lon: 21.01, lat: 35.2 }]);
      const d = await qualityDashboard(tx, subdivisionKey, quality);
      expect(d).toMatchObject({ latest: null, history: [], tiles: [], comparison: { setSize: 0, target: 50, checked: 0, pending: 0 } });
      expect(d.rows.every((r) => r.value === null)).toBe(true);
      expect((await qualityDashboard(tx, "test-unknown", quality)).comparison.setSize).toBe(0);
    }));
});

describe("detailNumbers", () => {
  it("lists numbers, nested as a.b, and leaves out strings, arrays and booleans", () => {
    expect(detailNumbers({ set: 10, share: 0.12345, ids: ["x"], name: "y", flag: true, byKind: { review: { tasks: 1200 } }, none: null })).toEqual([
      "set: 10",
      "share: 0,123",
      "byKind.review.tasks: 1.200",
    ]);
  });
});
