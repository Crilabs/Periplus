import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { areaByKey } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { configActivations, runs } from "@/lib/db/schema";
import { syncAreas } from "@/lib/domain/gazetteer/areas";
import { createRun } from "@/lib/domain/runs";
import { CONSOLIDATION_GEO_STAGE } from "@/lib/pipeline/consolidation/stages";
import { testDb, withRollback } from "@/test/db";

/*
 * The quality page's actions (plan Tasks 9 and 10): „Messen“, „Bewertung starten“ and „Aktivieren“ with zod, the admin
 * check and the redirects; refusals return to /quality with the reason. The saronic area object is synced inside
 * withRollback (never committed).
 */

let current: Db | undefined;
const requireAdmin = vi.fn();
const redirect = vi.fn();
const bossInsert = vi.fn();
vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => current ?? testDb(),
}));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({ insert: (...args: unknown[]) => bossInsert(...args) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import { activateCandidateAction, startEvaluationAction, startMeasurementAction } from "../quality/actions";

const ADMIN = "admin@example.invalid";

testDb();

beforeEach(() => {
  vi.resetAllMocks();
  current = undefined;
  requireAdmin.mockResolvedValue({ email: ADMIN });
  bossInsert.mockImplementation(async (_queue: string, jobs: unknown[]) => jobs.map(() => crypto.randomUUID()));
});

const started = (tx: Db) => tx.select().from(runs).where(eq(runs.triggeredBy, ADMIN));
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("startMeasurementAction", () => {
  it("startMeasurementAction rejects an unknown area and an empty label", () =>
    withRollback(async (tx) => {
      current = tx;
      await expect(startMeasurementAction({ areaKey: "atlantis", label: "Lauf 1" })).rejects.toThrow();
      await expect(startMeasurementAction({ areaKey: "saronic", label: "   " })).rejects.toThrow();
      await expect(startMeasurementAction({ areaKey: "saronic", label: "Lauf 1", from: "gestern" })).rejects.toThrow();
      expect(requireAdmin).toHaveBeenCalledTimes(3);
      expect(await started(tx)).toEqual([]);
      expect(redirect).not.toHaveBeenCalled();
    }));

  it("starts a measurement from the form and opens its run page; a second start returns with the reason", () =>
    withRollback(async (tx) => {
      current = tx;
      await syncAreas(tx, [areaByKey("saronic")]);
      await startMeasurementAction(form({ areaKey: "saronic", label: "Lauf 1", from: "2026-10-01", to: "" }));
      const [run] = await started(tx);
      expect(run).toMatchObject({ scopeId: "saronic", params: { label: "Lauf 1", from: "2026-10-01T00:00:00.000Z" } });
      expect(redirect).toHaveBeenLastCalledWith(`/runs/${run!.id}`);
      await startMeasurementAction(form({ areaKey: "saronic", label: "Lauf 2", from: "2026-10-01" }));
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&error=measurement_running");
      expect(await started(tx)).toHaveLength(1);
    }));

  it("an unauthenticated call never starts a run", () =>
    withRollback(async (tx) => {
      current = tx;
      requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
      await expect(startMeasurementAction({ areaKey: "saronic", label: "Lauf 1" })).rejects.toThrow("NEXT_REDIRECT");
      expect(await started(tx)).toEqual([]);
    }));
});

describe("startEvaluationAction and activateCandidateAction", () => {
  it("a model without prompt version is rejected; an empty comparison set returns with the reason", () =>
    withRollback(async (tx) => {
      current = tx;
      await syncAreas(tx, [areaByKey("saronic")]);
      await expect(startEvaluationAction({ areaKey: "saronic", model: "claude-opus-5-5" })).rejects.toThrow();
      await expect(startEvaluationAction({ areaKey: "saronic", rulesVersion: "latest" })).rejects.toThrow();
      await startEvaluationAction(form({ areaKey: "saronic", rulesVersion: "v1", model: "", promptVersion: "" }));
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&error=comparison_set_empty");
      expect(await started(tx)).toEqual([]);
    }));

  it("activation is refused while the gate is closed and writes its row once it passes", () =>
    withRollback(async (tx) => {
      current = tx;
      await syncAreas(tx, [areaByKey("saronic")]);
      const { id } = await createRun(tx, {
        kind: "reprocess",
        scope: { type: "system", id: "consolidation" },
        stages: [CONSOLIDATION_GEO_STAGE],
        params: { comparisonSetArea: "saronic", evaluation: true, rulesVersion: "v1", candidate: { rulesVersion: "v1" } },
        triggeredBy: "test",
      });
      await activateCandidateAction(form({ areaKey: "saronic", evaluationRunId: id }));
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&error=regression_gate_closed");
      expect(await tx.select().from(configActivations).where(eq(configActivations.evaluationRunId, id))).toEqual([]);

      await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, id));
      await activateCandidateAction({ areaKey: "saronic", evaluationRunId: id });
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&notice=activated");
      expect(await tx.select().from(configActivations).where(eq(configActivations.evaluationRunId, id))).toMatchObject([
        { kind: "consolidation_rules", version: "v1", activatedBy: ADMIN },
      ]);
    }));
});
