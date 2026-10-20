import { asc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { qualityMeasureStage } from "@/lib/jobs/handlers/quality";
import { QUEUES } from "@/lib/jobs/queues";
import { HANDLERS } from "@/lib/jobs/registry";
import { STAGES } from "@/lib/jobs/stages";
import { QUALITY_MEASURE_STAGE } from "@/lib/pipeline/quality-stages";
import { startMeasurement } from "@/lib/pipeline/quality-run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { withRollback } from "@/test/db";
import { insertQualityArea } from "@/test/quality";

/*
 * The measurement run „Messen“ (plan Task 8, ruling M7-P5): stage plan, registration and starter in withRollback
 * (no worker); the snapshot itself is tested in lib/domain/quality/__tests__/snapshot.test.ts.
 */

function recordingBoss() {
  const inserted: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const boss = {
    insert: async (queue: string, jobs: Array<{ id: string; data: Record<string, unknown> }>) => {
      inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
      return jobs.map((j) => j.id);
    },
  } as unknown as PgBoss;
  return { boss, inserted };
}

const someone = () => `${newId()}@test.invalid`;
const runOf = async (tx: Db, id: string) => (await tx.select().from(runs).where(eq(runs.id, id)))[0]!;

describe("measurement stage", () => {
  it("the stage plans one job for the area on its own queue", async () => {
    expect(STAGES[QUALITY_MEASURE_STAGE]).toBe(qualityMeasureStage);
    expect(qualityMeasureStage.queue).toBe("quality.measure");
    expect(QUEUES).toContain("quality.measure");
    expect(HANDLERS["quality.measure"]).toBeTypeOf("function");
    expect(loadConfig("config").queues["quality.measure"]).toEqual({ concurrency: 1, retryLimit: 2, retryDelaySeconds: 60, retryBackoff: true });
    const params = { areaKey: "test-area", label: "Lauf 1", from: "2026-10-01T00:00:00.000Z", to: "2026-10-20T00:00:00.000Z" };
    expect(await qualityMeasureStage.plan({} as Db, { id: newId(), params })).toEqual([{ key: "test-area", areaKey: "test-area" }]);
    await expect(qualityMeasureStage.plan({} as Db, { id: newId(), params: { ...params, to: "never" } })).rejects.toThrow(/ISO/);
  });
});

describe("startMeasurement", () => {
  it("starts the stage run with label and window and enqueues its job", () =>
    withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      const { areaKey } = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
      const triggeredBy = someone();
      const from = new Date("2026-10-01T00:00:00Z");
      const to = new Date("2026-10-20T00:00:00Z");
      const { id } = await startMeasurement(tx, boss, { areaKey, label: "  Lauf 1 ", from, to, triggeredBy });
      expect(await runOf(tx, id)).toMatchObject({
        kind: "stage",
        scopeType: "area",
        scopeId: areaKey,
        stages: [QUALITY_MEASURE_STAGE],
        params: { areaKey, label: "Lauf 1", from: from.toISOString(), to: to.toISOString() },
        triggeredBy,
      });
      expect(inserted).toEqual([{ queue: "quality.measure", data: expect.objectContaining({ key: areaKey, areaKey, runId: id }) }]);
    }));

  it("from defaults to the previous measurement's to", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      const { areaKey } = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
      const firstTo = new Date("2026-10-10T00:00:00Z");
      await startMeasurement(tx, boss, { areaKey, label: "Lauf 1", from: new Date("2026-10-01T00:00:00Z"), to: firstTo, triggeredBy: someone() });
      const before = Date.now();
      const { id } = await startMeasurement(tx, boss, { areaKey, label: "Lauf 2", triggeredBy: someone() });
      const params = (await runOf(tx, id)).params as { from: string; to: string };
      expect(params.from).toBe(firstTo.toISOString());
      // to defaults to now
      expect(new Date(params.to).getTime()).toBeGreaterThanOrEqual(before);
      expect(new Date(params.to).getTime()).toBeLessThanOrEqual(Date.now());
    }));

  it("without a previous measurement from is the creation of the oldest run", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      const { areaKey } = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
      const [oldest] = await tx.select({ createdAt: runs.createdAt }).from(runs).orderBy(asc(runs.createdAt)).limit(1);
      const { id } = await startMeasurement(tx, boss, { areaKey, label: "Lauf 1", triggeredBy: someone() });
      const params = (await runOf(tx, id)).params as { from: string };
      expect(params.from).toBe((oldest?.createdAt ?? new Date(0)).toISOString());
    }));

  it("a duplicate label is rejected", () =>
    withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      const { areaKey } = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
      const other = await insertQualityArea(tx, [{ lon: 21.51, lat: 35.2 }]);
      const window = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z") };
      await startMeasurement(tx, boss, { areaKey, label: "Lauf 1", ...window, triggeredBy: someone() });
      const triggeredBy = someone();
      await expect(startMeasurement(tx, boss, { areaKey, label: "Lauf 1 ", ...window, triggeredBy })).rejects.toMatchObject({
        constructor: RunScopeNotReady,
        reason: "measurement_label_taken",
      });
      expect(await tx.select().from(runs).where(eq(runs.triggeredBy, triggeredBy))).toEqual([]);
      expect(inserted).toHaveLength(1);
      // the label is unique per area: another area may use it
      await expect(startMeasurement(tx, boss, { areaKey: other.areaKey, label: "Lauf 1", ...window, triggeredBy })).resolves.toMatchObject({ id: expect.any(String) });
    }));

  it("an unknown area, an empty or too long label and an empty window are refused before the run exists", () =>
    withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      const { areaKey } = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
      const triggeredBy = someone();
      const window = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z") };
      await expect(startMeasurement(tx, boss, { areaKey: `test-${newId()}`, label: "Lauf 1", ...window, triggeredBy })).rejects.toMatchObject({
        constructor: RunScopeNotReady,
        reason: "unknown_area",
      });
      await expect(startMeasurement(tx, boss, { areaKey, label: "   ", ...window, triggeredBy })).rejects.toThrow(/label/);
      await expect(startMeasurement(tx, boss, { areaKey, label: "x".repeat(41), ...window, triggeredBy })).rejects.toThrow(/label/);
      await expect(startMeasurement(tx, boss, { areaKey, label: "x".repeat(40), from: window.to, to: window.to, triggeredBy: someone() })).rejects.toThrow(
        /window/,
      );
      expect(await tx.select().from(runs).where(eq(runs.triggeredBy, triggeredBy))).toEqual([]);
      expect(inserted).toEqual([]);
    }));
});
