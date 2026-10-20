import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { areaByKey, getConfig, loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { comparisonResults, comparisonSet, configActivations, evaluationProfiles, places, runs } from "@/lib/db/schema";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { comparisonValues, loadComparisonSubjects } from "@/lib/domain/quality/comparison-values";
import { areaGeoObjectId } from "@/lib/pipeline/tile-scope";
import { insertProfile } from "@/test/consolidation";
import { insertNamedObject } from "@/test/text";
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

const OPUS = { model: "claude-opus-5-5", promptVersion: loadConfig("config").models.tasks["extract-facts"]!.promptVersion };
const ATTRIBUTES = { "services.water": true };
const activationsOf = (tx: Db, evaluationRunId: string) => tx.select().from(configActivations).where(eq(configActivations.evaluationRunId, evaluationRunId));

/** The place of the saronic set (synthetic, at 21.01° E / 35.2° N, rolled back) with its profile and geo object. */
async function setPlace(tx: Db): Promise<{ placeId: string; geoObjectId: string }> {
  await syncAreas(tx, [areaByKey("saronic")]);
  const geoObjectId = await insertNamedObject(tx, { type: "bay", names: [{ name: "Testbucht" }], lon: 21.01, lat: 35.2 });
  const [place] = await tx
    .insert(places)
    .values({ geoObjectId, kind: "anchorage", status: "confirmed", validFrom: "2000-01-01", position: geomFromGeoJson({ type: "Point", coordinates: [21.01, 35.2] }) })
    .returning({ id: places.id });
  await tx.insert(comparisonSet).values({ placeId: place!.id, areaId: (await areaGeoObjectId(tx, "saronic"))!, addedBy: "test" });
  await insertProfile(tx, geoObjectId, ATTRIBUTES, {});
  return { placeId: place!.id, geoObjectId };
}

/**
 * Finishes an evaluation run over the set as its consolidation would: one evaluation profile per set place with the
 * place's current values, and a `match` for its water value, so the comparison passes.
 */
async function finishEvaluation(tx: Db, runId: string) {
  for (const s of await loadComparisonSubjects(tx, "saronic")) {
    const [p] = await tx.select({ geoObjectId: places.geoObjectId }).from(places).where(eq(places.id, s.placeId));
    await tx.insert(evaluationProfiles).values({ runId, geoObjectId: p!.geoObjectId, rulesVersion: "v1", factSchemaVersion: "v2", attributes: ATTRIBUTES, provenance: {}, contentHash: "h" });
    await tx.insert(comparisonResults).values({
      placeId: s.placeId,
      attribute: "services.water",
      profileVersion: s.profileVersion,
      valueHash: comparisonValues(s, getConfig().quality.navily)["services.water"].hash,
      result: "match",
      method: "manual",
      checkedBy: "test",
    });
  }
  await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, runId));
}

/** A set place and a finished evaluation run (`params` besides the area) that passes the gate. */
async function evaluated(tx: Db, params: Record<string, unknown>) {
  const place = await setPlace(tx);
  const { id } = await createRun(tx, {
    kind: "reprocess",
    scope: { type: "system", id: "consolidation" },
    stages: [CONSOLIDATION_GEO_STAGE],
    params: { comparisonSetArea: "saronic", evaluation: true, ...params },
    triggeredBy: "test",
  });
  await finishEvaluation(tx, id);
  return { ...place, evaluationRunId: id };
}

describe("startMeasurementAction", () => {
  it("startMeasurementAction rejects an unknown area and an empty label", () =>
    withRollback(async (tx) => {
      current = tx;
      // invalid input returns with a German notice, never an error page (ruling M7-E-R2 M-6)
      await startMeasurementAction({ areaKey: "atlantis", label: "Lauf 1" });
      expect(redirect).toHaveBeenLastCalledWith("/quality?error=invalid_input");
      await startMeasurementAction({ areaKey: "saronic", label: "   " });
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&error=invalid_input");
      await startMeasurementAction(form({ areaKey: "saronic", label: "Lauf 1", from: "gestern" }));
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&error=invalid_input");
      expect(requireAdmin).toHaveBeenCalledTimes(3);
      expect(await started(tx)).toEqual([]);
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

  it("a date „bis“ includes that day, and a „bis“ of today ends now (ruling M7-E-R2 M-3)", () =>
    withRollback(async (tx) => {
      current = tx;
      await syncAreas(tx, [areaByKey("saronic")]);
      await startMeasurementAction(form({ areaKey: "saronic", label: "Lauf 1", from: "2026-10-01", to: "2026-10-05" }));
      const [first] = await started(tx);
      expect(first!.params).toMatchObject({ from: "2026-10-01T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z" });
      await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, first!.id));
      const before = Date.now();
      await startMeasurementAction(form({ areaKey: "saronic", label: "Lauf 2", from: "2026-10-01", to: new Date().toISOString().slice(0, 10) }));
      const second = (await started(tx)).find((r) => r.id !== first!.id)!;
      const to = new Date((second.params as { to: string }).to).getTime();
      expect(to).toBeGreaterThanOrEqual(before - 1000);
      expect(to).toBeLessThanOrEqual(Date.now());
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
      await startEvaluationAction({ areaKey: "saronic", model: "claude-opus-5-5" });
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&error=invalid_input");
      await startEvaluationAction({ areaKey: "saronic", rulesVersion: "latest" });
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&error=invalid_input");
      await startEvaluationAction(form({ areaKey: "saronic", rulesVersion: "v1", model: "", promptVersion: "" }));
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&error=comparison_set_empty");
      expect(await started(tx)).toEqual([]);
    }));

  it("activation is refused while the gate is closed and writes its row once it passes", () =>
    withRollback(async (tx) => {
      current = tx;
      const { evaluationRunId } = await evaluated(tx, { rulesVersion: "v1", candidate: { rulesVersion: "v1" } });
      await tx.update(runs).set({ status: "running" }).where(eq(runs.id, evaluationRunId));
      await activateCandidateAction(form({ areaKey: "saronic", evaluationRunId }));
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&error=regression_gate_closed");
      expect(await activationsOf(tx, evaluationRunId)).toEqual([]);

      await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, evaluationRunId));
      await activateCandidateAction({ areaKey: "saronic", evaluationRunId });
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&notice=activated");
      // v1 is the active version already: no rules row pins it (ruling M7-E-R2)
      expect(await activationsOf(tx, evaluationRunId)).toEqual([]);
    }));

  it("an empty comparison set never activates (ruling M7-E-R2)", () =>
    withRollback(async (tx) => {
      current = tx;
      const { evaluationRunId, placeId } = await evaluated(tx, { rulesVersion: "v1", candidate: { rulesVersion: "v1", extraction: OPUS } });
      await tx.delete(comparisonSet).where(eq(comparisonSet.placeId, placeId));
      await activateCandidateAction({ areaKey: "saronic", evaluationRunId });
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&error=regression_gate_closed");
      expect(await activationsOf(tx, evaluationRunId)).toEqual([]);
    }));

  it("an extraction-only candidate from the form („unverändert“) stores no rules version and activates only the extraction", () =>
    withRollback(async (tx) => {
      current = tx;
      await setPlace(tx);
      await startEvaluationAction(form({ areaKey: "saronic", rulesVersion: "", model: OPUS.model, promptVersion: String(OPUS.promptVersion) }));
      const [run] = await started(tx);
      expect(redirect).toHaveBeenLastCalledWith(`/runs/${run!.id}`);
      expect((run!.params as { candidate: unknown }).candidate).toEqual({ extraction: OPUS });

      // the run evaluated the set: its profiles hold the places' values, checked against Navily
      await finishEvaluation(tx, run!.id);
      await activateCandidateAction({ areaKey: "saronic", evaluationRunId: run!.id });
      expect(redirect).toHaveBeenLastCalledWith("/quality?area=saronic&notice=activated");
      expect((await activationsOf(tx, run!.id)).map((r) => [r.kind, r.version])).toEqual([["extraction", `${OPUS.model}@p${OPUS.promptVersion}`]]);
    }));
});
