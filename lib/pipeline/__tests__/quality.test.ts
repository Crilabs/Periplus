import { eq } from "drizzle-orm";
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
import { RunScopeNotReady, type RunScopeReason } from "@/lib/pipeline/tile-scope";
import { RUN_SCOPE_REASON_LABELS } from "@/app/(admin)/_components/labels";
import { withRollback } from "@/test/db";
import { insertQualityArea } from "@/test/quality";
import { insertTestRun } from "@/test/text";

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
const setStatus = (tx: Db, id: string, status: "finished" | "failed" | "queued") => tx.update(runs).set({ status }).where(eq(runs.id, id));
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

  it("from defaults to the previous finished measurement's to", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      const { areaKey } = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
      const firstTo = new Date("2026-10-10T00:00:00Z");
      const first = await startMeasurement(tx, boss, { areaKey, label: "Lauf 1", from: new Date("2026-10-01T00:00:00Z"), to: firstTo, triggeredBy: someone() });
      await setStatus(tx, first.id, "finished");
      const before = Date.now();
      const { id } = await startMeasurement(tx, boss, { areaKey, label: "Lauf 2", triggeredBy: someone() });
      const params = (await runOf(tx, id)).params as { from: string; to: string };
      expect(params.from).toBe(firstTo.toISOString());
      // to defaults to now
      expect(new Date(params.to).getTime()).toBeGreaterThanOrEqual(before);
      expect(new Date(params.to).getTime()).toBeLessThanOrEqual(Date.now());
    }));

  it("from skips failed measurements and follows the latest window end, not the latest start (ruling M7-D-R2)", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      const { areaKey } = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
      const at = (day: number) => new Date(Date.UTC(2026, 9, day));
      const start = async (label: string, from: number, to: number, status: "finished" | "failed" | "queued") => {
        const { id } = await startMeasurement(tx, boss, { areaKey, label, from: at(from), to: at(to), triggeredBy: someone() });
        await setStatus(tx, id, status);
      };
      await start("Lauf 1", 1, 10, "finished");
      await start("Lauf 2", 10, 15, "failed"); // its window must be measured again
      await start("Nachmessung", 2, 5, "finished"); // started later for an earlier window
      const { id } = await startMeasurement(tx, boss, { areaKey, label: "Lauf 4", to: at(20), triggeredBy: someone() });
      expect(((await runOf(tx, id)).params as { from: string }).from).toBe(at(10).toISOString());
    }));

  it("a start while a measurement of the area is queued or running is refused; another area is not affected", () =>
    withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      const { areaKey } = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
      const other = await insertQualityArea(tx, [{ lon: 21.51, lat: 35.2 }]);
      const window = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z") };
      const later = { from: new Date("2026-10-20T00:00:00Z"), to: new Date("2026-10-25T00:00:00Z") };
      const first = await startMeasurement(tx, boss, { areaKey, label: "Lauf 1", ...window, triggeredBy: someone() });
      const triggeredBy = someone();
      for (const status of ["queued", "running"] as const) {
        await tx.update(runs).set({ status }).where(eq(runs.id, first.id));
        await expect(startMeasurement(tx, boss, { areaKey, label: "Lauf 2", ...later, triggeredBy })).rejects.toMatchObject({
          constructor: RunScopeNotReady,
          reason: "measurement_running",
        });
      }
      expect(await tx.select().from(runs).where(eq(runs.triggeredBy, triggeredBy))).toEqual([]);
      expect(RUN_SCOPE_REASON_LABELS.measurement_running).toMatch(/Messung/);
      await expect(startMeasurement(tx, boss, { areaKey: other.areaKey, label: "Lauf 2", ...later, triggeredBy })).resolves.toMatchObject({ id: expect.any(String) });
      for (const status of ["finished", "failed"] as const) {
        await setStatus(tx, first.id, status);
        const next = await startMeasurement(tx, boss, { areaKey, label: `Lauf ${status}`, ...later, triggeredBy: someone() });
        await setStatus(tx, next.id, "failed");
      }
      expect(inserted).toHaveLength(4);
    }));

  it("a failed measurement frees its label (ruling M7-D-R1)", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      const { areaKey } = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
      const window = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z") };
      const failed = await startMeasurement(tx, boss, { areaKey, label: "Lauf 1", ...window, triggeredBy: someone() });
      await setStatus(tx, failed.id, "failed");
      const again = await startMeasurement(tx, boss, { areaKey, label: "Lauf 1", ...window, triggeredBy: someone() });
      expect(((await runOf(tx, again.id)).params as { label: string }).label).toBe("Lauf 1");
      // a finished one keeps it
      await setStatus(tx, again.id, "finished");
      await expect(startMeasurement(tx, boss, { areaKey, label: "Lauf 1", ...window, triggeredBy: someone() })).rejects.toMatchObject({
        reason: "measurement_label_taken",
      });
    }));

  it("the first measurement of an area without from is refused with a German hint to from, even with older runs (final review B M-13)", () =>
    withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      const { areaKey } = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
      // older runs exist (paid runs of earlier acceptances): they must not open the pilot's first window
      await insertTestRun(tx);
      await expect(startMeasurement(tx, boss, { areaKey, label: "Lauf 1", triggeredBy: someone() })).rejects.toMatchObject({
        constructor: RunScopeNotReady,
        reason: "measurement_from_required",
      });
      expect(inserted).toEqual([]);
      expect(RUN_SCOPE_REASON_LABELS.measurement_from_required).toMatch(/„von“/);
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
      // refusals a person can trigger are RunScopeNotReady with a German text (ruling M7-D-R2)
      const refused = (reason: RunScopeReason) => ({ constructor: RunScopeNotReady, reason });
      await expect(startMeasurement(tx, boss, { areaKey, label: "   ", ...window, triggeredBy })).rejects.toMatchObject(refused("measurement_label_invalid"));
      await expect(startMeasurement(tx, boss, { areaKey, label: "x".repeat(41), ...window, triggeredBy })).rejects.toMatchObject(
        refused("measurement_label_invalid"),
      );
      await expect(startMeasurement(tx, boss, { areaKey, label: "x".repeat(40), from: window.to, to: window.to, triggeredBy })).rejects.toMatchObject(
        refused("measurement_window_empty"),
      );
      // a default from after the given to is an empty window as well
      const previous = await startMeasurement(tx, boss, { areaKey, label: "Lauf 0", ...window, triggeredBy: someone() });
      await setStatus(tx, previous.id, "finished");
      await expect(startMeasurement(tx, boss, { areaKey, label: "Lauf 1", to: window.from, triggeredBy })).rejects.toMatchObject(
        refused("measurement_window_empty"),
      );
      for (const reason of ["measurement_label_invalid", "measurement_window_empty"] as const) expect(RUN_SCOPE_REASON_LABELS[reason]).toBeTruthy();
      expect(await tx.select().from(runs).where(eq(runs.triggeredBy, triggeredBy))).toEqual([]);
      expect(inserted).toHaveLength(1);
    }));
});
