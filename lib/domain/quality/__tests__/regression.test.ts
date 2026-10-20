import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { areaByKey, getConfig, loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { comparisonResults, configActivations, evaluationProfiles, profiles, runs, type ComparisonAttribute, type ComparisonResultValue } from "@/lib/db/schema";
import { activeRulesVersion, consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { createRun } from "@/lib/domain/runs";
import { CONSOLIDATION_GEO_STAGE } from "@/lib/pipeline/consolidation/stages";
import { consolidateGeoJob, consolidationGeoJobs } from "@/lib/pipeline/consolidation/geo";
import { startConsolidationRun } from "@/lib/pipeline/consolidation/run";
import { startEvaluation } from "@/lib/pipeline/quality-run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { insertExtraction, insertMention, insertMentionFact, insertProfile, insertSource } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertQualityArea } from "@/test/quality";
import { comparisonValues, loadComparisonSubjects } from "../comparison-values";
import { activateCandidate, compareEvaluation, listEvaluations, NotAnEvaluationRun, RegressionGateClosed } from "../regression";

/*
 * The regression gate (spec 10, plan Task 10, rulings M7-P10/P11): old/new comparison over a comparison set of two
 * places with evaluation profiles inserted directly, activation and the rules resolver. A released rules version „v2“
 * exists for this file only (a copy of v1, mocked into the config module), so an activation can name a version other
 * than active.json's. Synthetic area at 21.0° E / 35.2° N, every row in withRollback.
 */

vi.mock("@/lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...real,
    consolidationVersions: (dir?: string) => [...real.consolidationVersions(dir), "v2"],
    getConsolidationConfig: (version?: string, dir?: string) =>
      version === "v2" ? { ...real.getConsolidationConfig("v1", dir), version: "v2" } : real.getConsolidationConfig(version, dir),
  };
});

const navily = getConfig().quality.navily;
const OPUS = { model: "claude-opus-5-5", promptVersion: loadConfig("config").models.tasks["extract-facts"]!.promptVersion };

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

/** The app config with the synthetic area configured (a copy of saronic's settings under its key). */
const withArea = (areaKey: string): AppConfig => ({ ...getConfig(), areas: [...getConfig().areas, { ...areaByKey("saronic"), key: areaKey }] });

const BASE: Array<Record<string, unknown>> = [{ "services.water": true, "depth.anchoring_min": 5 }, { "services.water": false }];

/**
 * Two set places with profiles (`BASE`), outcomes for their current values (place 1: existence, position, water and
 * depth match; place 2: existence match, water confirmed own) and a finished evaluation run of `rulesVersion` v2 whose
 * evaluation profiles hold `next` (default: the same attributes).
 */
async function scene(tx: Db, next: Array<Record<string, unknown>> = BASE) {
  const area = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
  const places = [await area.addPlace({ inSet: true }), await area.addPlace({ inSet: true })];
  for (const [i, p] of places.entries()) await insertProfile(tx, p.geoObjectId, BASE[i]!, {});
  const outcomes: Array<[number, ComparisonAttribute, ComparisonResultValue]> = [
    [0, "existence", "match"],
    [0, "position", "match"],
    [0, "services.water", "match"],
    [0, "depth", "match"],
    [1, "existence", "match"],
    [1, "services.water", "deviation_confirmed_own"],
  ];
  for (const [i, attribute, result] of outcomes) await addResult(tx, area.areaKey, places[i]!.placeId, attribute, result);
  const runId = await evaluationRunRow(tx, area.areaKey, { rulesVersion: "v2", candidate: { rulesVersion: "v2" } });
  for (const [i, p] of places.entries()) {
    await tx.insert(evaluationProfiles).values({ runId, geoObjectId: p.geoObjectId, rulesVersion: "v2", factSchemaVersion: "v2", attributes: next[i]!, provenance: {}, contentHash: `h${i}` });
  }
  return { ...area, places, runId };
}

/** A finished evaluation run over the area's set (as `startConsolidationRun` writes it). */
async function evaluationRunRow(tx: Db, areaKey: string, params: Record<string, unknown>): Promise<string> {
  const { id } = await createRun(tx, {
    kind: "reprocess",
    scope: { type: "system", id: "consolidation" },
    stages: [CONSOLIDATION_GEO_STAGE],
    params: { comparisonSetArea: areaKey, evaluation: true, ...params },
    triggeredBy: "test",
  });
  await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, id));
  return id;
}

/** An outcome for the place's current own value (or, with `evaluationRunId`, its value in that run's profile). */
async function addResult(tx: Db, areaKey: string, placeId: string, attribute: ComparisonAttribute, result: ComparisonResultValue, evaluationRunId?: string) {
  const subject = (await loadComparisonSubjects(tx, areaKey, { evaluationRunId })).find((s) => s.placeId === placeId)!;
  await tx.insert(comparisonResults).values({
    placeId,
    attribute,
    profileVersion: subject.profileVersion,
    evaluationRunId: evaluationRunId ?? null,
    valueHash: comparisonValues(subject, navily)[attribute].hash,
    result,
    method: result.startsWith("deviation_confirmed") ? "review" : "manual",
    checkedBy: "test",
  });
}

const activations = (tx: Db) => tx.select().from(configActivations).orderBy(configActivations.activatedAt);

describe("compareEvaluation and activateCandidate", () => {
  it("an attribute with an unchanged value hash carries the old result", () =>
    withRollback(async (tx) => {
      const { runId } = await scene(tx);
      const c = await compareEvaluation(tx, runId);
      expect(c.pending).toBe(0);
      expect(c.changed).toEqual([]);
      expect(c.next.precision).toBe(c.old.precision);
      expect(c.old).toEqual({ precision: 1, coverage: 1, compared: 6 });
      expect(c).toMatchObject({ candidate: { rulesVersion: "v2" }, status: "finished", passes: true, reasons: [] });
    }));

  it("a changed value is pending and blocks activation", () =>
    withRollback(async (tx) => {
      const { runId, places } = await scene(tx, [{ "services.water": true, "depth.anchoring_min": 8 }, BASE[1]!]);
      const c = await compareEvaluation(tx, runId);
      expect(c.changed).toEqual([{ placeId: places[0]!.placeId, name: expect.any(String), attribute: "depth", oldDisplay: "5 m", newDisplay: "8 m", checked: false }]);
      expect(c).toMatchObject({ pending: 1, passes: false, reasons: ["1 geänderter Wert ungeprüft"] });
      await expect(activateCandidate(tx, { evaluationRunId: runId, activatedBy: "a" })).rejects.toThrow(RegressionGateClosed);
      expect(await activations(tx)).toEqual([]);
    }));

  it("a checked changed value with lower precision blocks activation with a reason", () =>
    withRollback(async (tx) => {
      const { runId, places, areaKey } = await scene(tx, [{ "services.water": true, "depth.anchoring_min": 8 }, BASE[1]!]);
      await addResult(tx, areaKey, places[0]!.placeId, "depth", "deviation", runId);
      const c = await compareEvaluation(tx, runId);
      expect(c).toMatchObject({ pending: 0, changed: [{ attribute: "depth", checked: true }] });
      expect(c.next.precision).toBeCloseTo(5 / 6);
      expect(c.reasons).toEqual(["Präzision sinkt von 100,0 % auf 83,3 %"]);
      const refused = await activateCandidate(tx, { evaluationRunId: runId, activatedBy: "a" }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RegressionGateClosed);
      expect((refused as RegressionGateClosed).reasons).toEqual(c.reasons);
      // a checked change that holds the precision passes
      await addResult(tx, areaKey, places[0]!.placeId, "depth", "match", runId);
      expect(await compareEvaluation(tx, runId)).toMatchObject({ pending: 0, passes: true });
    }));

  it("an unfinished evaluation run cannot be activated", () =>
    withRollback(async (tx) => {
      const { runId } = await scene(tx);
      await tx.update(runs).set({ status: "running" }).where(eq(runs.id, runId));
      expect(await compareEvaluation(tx, runId)).toMatchObject({ passes: false, reasons: ["Bewertungslauf ist noch nicht abgeschlossen"] });
      await expect(activateCandidate(tx, { evaluationRunId: runId, activatedBy: "a" })).rejects.toThrow(RegressionGateClosed);
    }));

  it("activation writes one row and activeRulesVersion returns the candidate", () =>
    withRollback(async (tx) => {
      const { runId } = await scene(tx);
      expect(await activeRulesVersion(tx)).toBe("v1");
      await activateCandidate(tx, { evaluationRunId: runId, activatedBy: "admin@test.invalid" });
      await activateCandidate(tx, { evaluationRunId: runId, activatedBy: "admin@test.invalid" }); // a double click
      const rows = await activations(tx);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "consolidation_rules", version: "v2", evaluationRunId: runId, activatedBy: "admin@test.invalid" });
      // numbers only (Grundprinzip 9)
      expect(rows[0]!.comparison).toEqual({
        old: { precision: 1, coverage: 1, compared: 6 },
        next: { precision: 1, coverage: 1, compared: 6 },
        changed: 0,
        pending: 0,
      });
      expect(await activeRulesVersion(tx)).toBe("v2");
      expect((await consolidationConfigFor(tx)).version).toBe("v2");
      expect((await consolidationConfigFor(tx, "v1")).version).toBe("v1");
      expect((await listEvaluations(tx, (await runParams(tx, runId)).comparisonSetArea as string))[0]).toMatchObject({ runId, activated: ["consolidation_rules"] });
    }));

  it("a run that is no evaluation run is refused", () =>
    withRollback(async (tx) => {
      const { id } = await createRun(tx, { kind: "stage", scope: { type: "system", id: "consolidation" }, stages: [CONSOLIDATION_GEO_STAGE], params: {}, triggeredBy: "test" });
      await expect(compareEvaluation(tx, id)).rejects.toThrow(NotAnEvaluationRun);
    }));
});

const runParams = async (tx: Db, id: string) => (await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, id)))[0]!.params as Record<string, unknown>;

describe("activeRulesVersion (ruling M7-P10)", () => {
  it("a consolidation run without explicit version uses the activated rules version", () =>
    withRollback(async (tx) => {
      const { runId, places } = await scene(tx);
      const rec = recordingBoss();
      const before = await startConsolidationRun(tx, rec.boss, { scope: { geoObjectIds: [places[0]!.geoObjectId] }, triggeredBy: "test" });
      expect((await runParams(tx, before.id)).rulesVersion).toBe("v1");
      await activateCandidate(tx, { evaluationRunId: runId, activatedBy: "a" });
      const after = await startConsolidationRun(tx, rec.boss, { scope: { geoObjectIds: [places[0]!.geoObjectId] }, triggeredBy: "test" });
      expect((await runParams(tx, after.id)).rulesVersion).toBe("v2");
      expect(rec.inserted.filter((j) => j.queue === "consolidation.geo").map((j) => j.data.rulesVersion)).toEqual(["v1", "v2"]);
      // a text or geometry run carries no version: its consolidation takes the active one
      const result = await consolidateGeo(tx, places[1]!.geoObjectId);
      expect(result.status).toBe("created");
      const [profile] = await tx.select({ rulesVersion: profiles.rulesVersion }).from(profiles).where(eq(profiles.geoObjectId, places[1]!.geoObjectId)).orderBy(sql`version desc`).limit(1);
      expect(profile!.rulesVersion).toBe("v2");
    }));

  it("an activated version without config file falls back to active.json", () =>
    withRollback(async (tx) => {
      const { runId } = await scene(tx);
      const activate = (version: string) =>
        tx.insert(configActivations).values({ kind: "consolidation_rules", version, evaluationRunId: runId, comparison: {}, activatedBy: "test", activatedAt: sql`clock_timestamp()` });
      await activate("v99");
      expect(await activeRulesVersion(tx)).toBe("v1");
      await activate("v2");
      await activate("v98"); // newest, but not released: the newest released one counts
      expect(await activeRulesVersion(tx)).toBe("v2");
      // an extraction approval is no rules activation
      await tx.insert(configActivations).values({ kind: "extraction", version: "v1", evaluationRunId: runId, comparison: {}, activatedBy: "test", activatedAt: sql`clock_timestamp()` });
      expect(await activeRulesVersion(tx)).toBe("v2");
    }));

  it("getConsolidationConfig() without a version and getConfig().consolidation are read by the resolver only", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__" && name !== "node_modules") walk(path);
        } else if (/\.tsx?$/.test(name)) {
          const text = readFileSync(path, "utf8");
          if (/getConsolidationConfig\(\s*\)|getConfig\(\)\s*\.consolidation\b|\{[^}]*\bconsolidation\b[^}]*\}\s*=\s*(getConfig\(\)|rest\b)/.test(text)) offenders.push(path);
        }
      }
    };
    for (const dir of ["app", "lib", "scripts", "worker"]) walk(dir);
    expect(offenders.sort()).toEqual(["lib/config/index.ts", "lib/domain/consolidation/active-rules.ts"]);
  });
});

describe("extraction candidates (ruling M7-P11)", () => {
  /** A set place with one fact of the active extraction (holding good) and one of a comparison run of Opus (holding poor). */
  async function candidateScene(tx: Db) {
    const area = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
    const place = await area.addPlace({ inSet: true });
    const m = await insertMention(tx, place.geoObjectId, { sourceId: await insertSource(tx) });
    await insertMentionFact(tx, place.geoObjectId, m, await insertExtraction(tx, place.geoObjectId, m), { value: "good" });
    const candidateRun = await insertExtraction(tx, place.geoObjectId, m, { model: OPUS.model, purpose: "comparison", startedAt: new Date("2026-10-18T11:00:00Z") });
    await insertMentionFact(tx, place.geoObjectId, m, candidateRun, { value: "poor" });
    return { ...area, place };
  }
  const evaluated = async (tx: Db, runId: string, geoObjectId: string) =>
    (await tx.select().from(evaluationProfiles).where(eq(evaluationProfiles.runId, runId))).find((e) => e.geoObjectId === geoObjectId)!.attributes;

  it("an extraction candidate evaluation uses facts of the candidate extraction runs only", () =>
    withRollback(async (tx) => {
      const { areaKey, place } = await candidateScene(tx);
      const rec = recordingBoss();
      const { id } = await startEvaluation(tx, rec.boss, { areaKey, candidate: { extraction: OPUS }, triggeredBy: "test" }, withArea(areaKey));
      const params = await runParams(tx, id);
      expect(params).toMatchObject({ evaluation: true, comparisonSetArea: areaKey, rulesVersion: "v1", extraction: OPUS, candidate: { extraction: OPUS } });
      expect(params.candidate).not.toHaveProperty("rulesVersion");
      const jobs = await consolidationGeoJobs(tx, { id, params });
      expect(jobs).toEqual([expect.objectContaining({ geoObjectId: place.geoObjectId, mode: "evaluation", rulesVersion: "v1", extraction: OPUS })]);
      for (const job of jobs) await consolidateGeoJob(tx, { ...job, runId: id });
      expect(await evaluated(tx, id, place.geoObjectId)).toMatchObject({ holding: "poor" });

      // the same set without a candidate extraction: the active run's facts
      const rules = await startEvaluation(tx, rec.boss, { areaKey, candidate: { rulesVersion: "v1" }, triggeredBy: "test" }, withArea(areaKey));
      await consolidateGeo(tx, place.geoObjectId, { runId: rules.id, mode: "evaluation", rulesVersion: "v1" });
      expect(await evaluated(tx, rules.id, place.geoObjectId)).toMatchObject({ holding: "good" });
      expect((await runParams(tx, rules.id)).candidate).toEqual({ rulesVersion: "v1" });
      // nothing reached the profiles
      expect(await tx.select().from(profiles).where(eq(profiles.geoObjectId, place.geoObjectId))).toEqual([]);
    }));

  it("the extraction override is refused outside evaluation mode", () =>
    withRollback(async (tx) => {
      const { place, areaKey } = await candidateScene(tx);
      await expect(consolidateGeo(tx, place.geoObjectId, { extraction: OPUS })).rejects.toThrow(/evaluation mode only/);
      await expect(
        startConsolidationRun(tx, recordingBoss().boss, { scope: { comparisonSetArea: areaKey }, extraction: OPUS, triggeredBy: "test" }, withArea(areaKey)),
      ).rejects.toThrow(/evaluation run only/);
      expect(await tx.select().from(profiles).where(eq(profiles.geoObjectId, place.geoObjectId))).toEqual([]);
    }));

  it("startEvaluation refuses no candidate and an unknown version, model or prompt", () =>
    withRollback(async (tx) => {
      const { areaKey } = await candidateScene(tx);
      const { boss, inserted } = recordingBoss();
      const start = (candidate: Parameters<typeof startEvaluation>[2]["candidate"]) =>
        startEvaluation(tx, boss, { areaKey, candidate, triggeredBy: "test" }, withArea(areaKey));
      const refused = (reason: string) => ({ constructor: RunScopeNotReady, reason });
      await expect(start({})).rejects.toMatchObject(refused("evaluation_candidate_missing"));
      await expect(start({ rulesVersion: "v97" })).rejects.toMatchObject(refused("evaluation_candidate_unknown"));
      await expect(start({ extraction: { model: "gpt-unknown", promptVersion: 1 } })).rejects.toMatchObject(refused("evaluation_candidate_unknown"));
      await expect(start({ extraction: { model: OPUS.model, promptVersion: 99 } })).rejects.toMatchObject(refused("evaluation_candidate_unknown"));
      await expect(startEvaluation(tx, boss, { areaKey: "test-unknown", candidate: { rulesVersion: "v1" }, triggeredBy: "test" })).rejects.toMatchObject(refused("unknown_area"));
      expect(inserted).toEqual([]);
    }));
});
