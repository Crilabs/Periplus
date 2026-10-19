import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { extractionRuns, runs } from "@/lib/db/schema";
import { createRun, failRun, getRun } from "@/lib/domain/runs";
import { CONSOLIDATION_STAGES } from "@/lib/pipeline/consolidation/stages";
import { CHECK_STAGE } from "@/lib/pipeline/text/check";
import { insertExtraction, insertMention, insertMentionFact, insertPlace, insertSource } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";

/*
 * The run page's actions after a skipped consolidation (ruling M5-H-R2): „Belegtreue neu prüfen“ starts the
 * consolidation once nothing blocks it, „Konsolidierung nachholen“ starts it by hand; a start that fails after the
 * committed recheck is a notice, not an error page. In withRollback on the synthetic grid at 20.7° E / 34.7° N.
 */

let current: Db | undefined;
const requireAdmin = vi.fn();
const redirect = vi.fn();
const refresh = vi.fn();
const bossInsert = vi.fn();
vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => current ?? testDb(),
}));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({ insert: (...args: unknown[]) => bossInsert(...args) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: () => refresh() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import { catchUpConsolidationAction, recheckExtractionRunAction } from "../runs/[id]/actions";

const ADMIN = "admin@example.invalid";
const LON = 20.72;
const LAT = 34.72;

testDb();

beforeEach(() => {
  vi.resetAllMocks();
  current = undefined;
  requireAdmin.mockResolvedValue({ email: ADMIN });
  bossInsert.mockImplementation(async (_queue: string, jobs: unknown[]) => jobs.map(() => crypto.randomUUID()));
});

/** A text run that failed before its quote check: one place with a fact, its extraction run blocked `run_failed`. */
async function failedTextRun(tx: Db): Promise<{ runId: string; extractionRunId: string; objectId: string }> {
  const { id: runId } = await createRun(tx, {
    kind: "stage",
    scope: { type: "system", id: "texts" },
    stages: [CHECK_STAGE, ...CONSOLIDATION_STAGES],
    params: { documentVersionIds: [] },
    triggeredBy: "test",
  });
  const { objectId } = await insertPlace(tx, { lon: LON, lat: LAT, name: "Prüfbucht" });
  const m = await insertMention(tx, objectId, { sourceId: await insertSource(tx) });
  const extractionRunId = await insertExtraction(tx, objectId, m, { runId });
  await insertMentionFact(tx, objectId, m, extractionRunId);
  await tx.update(runs).set({ status: "running", params: { documentVersionIds: [m.versionId] } }).where(eq(runs.id, runId));
  await tx.update(extractionRuns).set({ status: "running", finishedAt: null }).where(eq(extractionRuns.id, extractionRunId));
  await failRun(tx, runId, "stage transition failed: test");
  return { runId, extractionRunId, objectId };
}

const catchUps = (tx: Db) => tx.select().from(runs).where(eq(runs.triggeredBy, ADMIN));

describe("„Belegtreue neu prüfen“ and „Konsolidierung nachholen“", () => {
  it("a recheck that lifts the last block starts the consolidation of the run's objects after it committed", () =>
    withRollback(async (tx) => {
      current = tx;
      const r = await failedTextRun(tx);
      await recheckExtractionRunAction({ extractionRunId: r.extractionRunId });
      const [er] = await tx.select({ status: extractionRuns.status }).from(extractionRuns).where(eq(extractionRuns.id, r.extractionRunId));
      expect(er!.status).toBe("finished");
      const started = await catchUps(tx);
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ stages: [...CONSOLIDATION_STAGES], params: { geoObjectIds: [r.objectId] } });
      expect(bossInsert.mock.calls.some(([queue]) => queue === "consolidation.geo")).toBe(true);
      expect((await getRun(tx, r.runId))!.consolidationSkip).toMatchObject({ reason: "run_failed", catchUpRunId: started[0]!.id });
      expect(redirect).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalled();
      // the button afterwards starts nothing again
      await catchUpConsolidationAction({ runId: r.runId });
      expect(await catchUps(tx)).toHaveLength(1);
      expect(redirect).toHaveBeenLastCalledWith(`/runs/${r.runId}`);
    }));

  it("„Konsolidierung nachholen“ while the quote fidelity still blocks says so and starts nothing", () =>
    withRollback(async (tx) => {
      current = tx;
      const r = await failedTextRun(tx);
      await catchUpConsolidationAction({ runId: r.runId });
      expect(redirect).toHaveBeenLastCalledWith(`/runs/${r.runId}?notice=consolidation_blocked`);
      expect(await catchUps(tx)).toEqual([]);
    }));

  it("a consolidation start failing after the committed recheck is a notice, the recheck stands", () =>
    withRollback(async (tx) => {
      current = tx;
      const r = await failedTextRun(tx);
      bossInsert.mockRejectedValue(new Error("queue down"));
      await recheckExtractionRunAction({ extractionRunId: r.extractionRunId });
      expect(redirect).toHaveBeenLastCalledWith(`/runs/${r.runId}?notice=consolidation_not_started`);
      const [er] = await tx.select({ status: extractionRuns.status }).from(extractionRuns).where(eq(extractionRuns.id, r.extractionRunId));
      expect(er!.status).toBe("finished");
      // the run that could not start failed, and the button is offered again
      const [orphan] = await catchUps(tx);
      expect(orphan).toMatchObject({ status: "failed" });
      expect((await getRun(tx, r.runId))!.consolidationSkip).toMatchObject({ reason: "run_failed", catchUpRunId: null });
    }));

  it("no session: nothing is checked or started", () =>
    withRollback(async (tx) => {
      current = tx;
      const r = await failedTextRun(tx);
      requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
      await expect(recheckExtractionRunAction({ extractionRunId: r.extractionRunId })).rejects.toThrow("NEXT_REDIRECT");
      await expect(catchUpConsolidationAction({ runId: r.runId })).rejects.toThrow("NEXT_REDIRECT");
      const [er] = await tx.select({ status: extractionRuns.status }).from(extractionRuns).where(eq(extractionRuns.id, r.extractionRunId));
      expect(er!.status).toBe("blocked");
      expect(await catchUps(tx)).toEqual([]);
    }));
});
