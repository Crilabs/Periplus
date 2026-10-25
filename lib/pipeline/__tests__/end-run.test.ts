import { readFileSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestTile, insertTestVersion } from "@/test/text";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, extractionRuns, extractionUnits, mentions, runs } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun, getRun } from "@/lib/domain/runs";
import { tileIdFor } from "@/lib/domain/tiles";
import { EXTRACT_STAGE, planExtraction } from "@/lib/pipeline/text/extract";
import { endRunByAdmin } from "@/lib/pipeline/runs";

/*
 * „Lauf beenden“ is repeatable until its cleanup completed, and a stage planned after (or racing) the end plans
 * nothing (rulings GR-8, CON-1/CON-2). Own tiles, far outside the pilot box, in withRollback.
 */

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const ADMIN = "admin@example.invalid";

async function scene(tx: Db, name: string, lon: number, lat: number) {
  const texts = [`## ${name}`, `${name} is a quiet bay. Holding is good in sand, depth 6 m.`];
  const tile = await insertTestTile(tx, tileIdFor(lon, lat));
  const object = await insertNamedObject(tx, { type: "bay", names: [{ name }], lon, lat, tiles: [tile] });
  const v = await insertTestVersion(tx, texts);
  for (const [i, text] of texts.entries()) {
    const at = text.indexOf(name);
    await tx.insert(mentions).values({ documentVersionId: v.versionId, chunkId: v.chunkIds[i]!, geoObjectId: object, surface: name,
      charStart: at, charEnd: at + name.length, observedAt: "2026-10-19", confidence: 1, matchKind: "deterministic" });
  }
  return v;
}

const stubBoss = () =>
  ({
    findJobs: async () => [],
    cancel: async () => undefined,
    insert: async (_q: string, jobs: Array<{ id?: string }>) => jobs.map((j) => j.id ?? newId()),
  }) as unknown as PgBoss;

describe("Lauf beenden", () => {
  it("a cleanup that failed after the end committed is repeated by the next call, and then recorded", () =>
    withRollback(async (tx) => {
      const v = await scene(tx, "Kolonax", -150.3, -50.3);
      const params = { documentVersionIds: [v.versionId] };
      const { id: runId } = await createRun(tx, { kind: "stage", scope: { type: "system", id: `end-${newId()}` }, stages: [EXTRACT_STAGE], params, triggeredBy: "test" });
      const [job] = await planExtraction(tx, { id: runId, params }, config);
      await beginStage(tx, runId, EXTRACT_STAGE, 1);
      const [batch] = await tx
        .insert(aiBatches)
        .values({ runId, stage: EXTRACT_STAGE, task: "extract-facts", model: "mock", promptVersion: 1, status: "submitting",
          outcomeKey: `end-${newId()}`, requestCount: 1, estimatedCostEur: "1.0" })
        .returning({ id: aiBatches.id });

      const flaky = { findJobs: async () => { throw new Error("connection terminated"); }, cancel: async () => undefined } as unknown as PgBoss;
      await expect(endRunByAdmin(tx, flaky, runId, ADMIN)).rejects.toThrow("connection terminated");
      const pending = (await getRun(tx, runId))!;

      const second = await endRunByAdmin(tx, stubBoss(), runId, ADMIN);
      const units = await tx.select().from(extractionUnits).where(eq(extractionUnits.extractionRunId, job!.extractionRunId as string));
      expect(units.map((u) => u.status)).toEqual(["failed"]);
      const [er] = await tx.select().from(extractionRuns).where(eq(extractionRuns.id, job!.extractionRunId as string));
      expect(er).toMatchObject({ status: "blocked", blockedReason: "run_ended" });
      const [b] = await tx.select().from(aiBatches).where(eq(aiBatches.id, batch!.id));
      expect(b!.status).toBe("failed");
      expect(pending).toMatchObject({ status: "failed", endedBy: ADMIN, endCleanupPending: true });
      expect(second).toEqual({ ended: false, cleanedUp: true, cancelledJobs: 0 });
      expect((await getRun(tx, runId))!.endCleanupPending).toBe(false);

      // Once cleaned up, another click changes nothing.
      expect(await endRunByAdmin(tx, flaky, runId, ADMIN)).toEqual({ ended: false, cleanedUp: false, cancelledJobs: 0 });
    }));

  it("a run that ended by itself is never cleaned up as an admin end", () =>
    withRollback(async (tx) => {
      const { id: runId } = await createRun(tx, { kind: "stage", scope: { type: "system", id: `end-${newId()}` }, stages: [EXTRACT_STAGE], params: {}, triggeredBy: "test" });
      await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, runId));
      expect(await endRunByAdmin(tx, stubBoss(), runId, ADMIN)).toEqual({ ended: false, cleanedUp: false, cancelledJobs: 0 });
      expect((await getRun(tx, runId))!).toMatchObject({ status: "finished", endedBy: null, endCleanupPending: false });
    }));

  it("the backfill marks runs ended before the repeatable cleanup as cleaned up, unless something is left open (GR-13, W2-M-2)", () =>
    withRollback(async (tx) => {
      const v = await scene(tx, "Kolonaz", -150.5, -50.5);
      const params = { documentVersionIds: [v.versionId] };
      const newRun = (p: Record<string, unknown>) =>
        createRun(tx, { kind: "stage", scope: { type: "system", id: `end-${newId()}` }, stages: [EXTRACT_STAGE], params: p, triggeredBy: "test" });
      const { id: clean } = await newRun({});
      const { id: open } = await newRun(params);
      await planExtraction(tx, { id: open, params }, config);
      const { id: cleanedLater } = await newRun({ endCleanedUpAt: "2026-10-20T10:00:00.000Z" });
      const endedAt = new Date("2026-09-01T08:00:00Z");
      // ended by the old „Lauf beenden“: ended_by set, no cleanup marker
      await tx.update(runs).set({ status: "failed", endedBy: ADMIN, endedAt }).where(inArray(runs.id, [clean, open, cleanedLater]));
      expect((await getRun(tx, clean))!.endCleanupPending).toBe(true);

      // the migration, limited to this test's runs (never touch other files' committed rows)
      const migration = readFileSync("drizzle/0051_runs_end_cleanup_backfill.sql", "utf8");
      const scoped = migration.replace("WHERE r.ended_by IS NOT NULL", `WHERE r.id in ('${clean}', '${open}', '${cleanedLater}') AND r.ended_by IS NOT NULL`);
      expect(scoped).not.toBe(migration);
      await tx.execute(sql.raw(scoped));

      expect((await getRun(tx, clean))!.endCleanupPending).toBe(false);
      const [row] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, clean));
      expect(new Date((row!.params as { endCleanedUpAt: string }).endCleanedUpAt).toISOString()).toBe(endedAt.toISOString());
      expect((await getRun(tx, open))!.endCleanupPending).toBe(true);
      const [later] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, cleanedLater));
      expect(later!.params).toEqual({ endCleanedUpAt: "2026-10-20T10:00:00.000Z" });
    }));
});
