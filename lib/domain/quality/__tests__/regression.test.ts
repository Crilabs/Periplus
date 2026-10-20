import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { getConfig, loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { comparisonResults, comparisonSet, configActivations, evaluationProfiles, profiles, runs, type ComparisonAttribute, type ComparisonResultValue } from "@/lib/db/schema";
import { activeRulesVersion, consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import { markConsolidationSkipped } from "@/lib/domain/consolidation/skipped";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import type { ModelClient } from "@/lib/ai/types";
import { setModelClientFactory } from "@/lib/jobs/handlers/ai-batch";
import { consolidationSummaryHandler } from "@/lib/jobs/handlers/consolidation";
import type { JobContext } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import { requestPlaceDiscovery } from "@/lib/pipeline/consolidation/followup";
import { summaryJobs } from "@/lib/pipeline/consolidation/summary";
import { startGeometryRun } from "@/lib/pipeline/geometry-run";
import { startTextRun } from "@/lib/pipeline/text/run";
import { buildBayScene } from "@/test/geometry/scene";
import { createRun } from "@/lib/domain/runs";
import { CONSOLIDATION_GEO_STAGE } from "@/lib/pipeline/consolidation/stages";
import { consolidateGeoJob, consolidationGeoJobs } from "@/lib/pipeline/consolidation/geo";
import { catchUpConsolidation, startConsolidationRun } from "@/lib/pipeline/consolidation/run";
import { startEvaluation } from "@/lib/pipeline/quality-run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { insertExtraction, insertMention, insertMentionFact, insertProfile, insertSource } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertQualitySubdivision } from "@/test/quality";
import { comparisonValues, loadComparisonSubjects } from "../comparison-values";
import { activateCandidate, compareEvaluation, listEvaluations, NotAnEvaluationRun, RegressionGateClosed } from "../regression";

/*
 * The regression gate (spec 10, plan Task 10, rulings M7-P10/P11): old/new comparison over a comparison set of two
 * places with evaluation profiles inserted directly, activation and the rules resolver. A released rules version „v2“
 * exists for this file only (a copy of v1, mocked into the config module), so an activation can name a version other
 * than active.json's. Synthetic subdivision at 21.0° E / 35.2° N, every row in withRollback.
 */

/** The versions `getConsolidationConfig` was asked for (`undefined`: active.json), to see which rules a job read. */
const configReads = vi.hoisted(() => [] as Array<string | undefined>);

vi.mock("@/lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...real,
    consolidationVersions: (dir?: string) => [...real.consolidationVersions(dir), "v2"],
    getConsolidationConfig: (version?: string, dir?: string) => {
      configReads.push(version);
      return version === "v2" ? { ...real.getConsolidationConfig("v1", dir), version: "v2" } : real.getConsolidationConfig(version, dir);
    },
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


const BASE: Array<Record<string, unknown>> = [{ "services.water": true, "depth.anchoring_min": 5 }, { "services.water": false }];

/**
 * Two set places with profiles (`BASE`), outcomes for their current values (place 1: existence, position, water and
 * depth match; place 2: existence match, water confirmed own) and a finished evaluation run of `rulesVersion` v2 whose
 * evaluation profiles hold `next` (default: the same attributes).
 */
async function scene(tx: Db, next: Array<Record<string, unknown>> = BASE, current: Array<Record<string, unknown>> = BASE) {
  const sub = await insertQualitySubdivision(tx, [{ lon: 21.01, lat: 35.2 }]);
  const places = [await sub.addPlace({ inSet: true }), await sub.addPlace({ inSet: true })];
  for (const [i, p] of places.entries()) await insertProfile(tx, p.geoObjectId, current[i]!, {});
  const outcomes: Array<[number, ComparisonAttribute, ComparisonResultValue]> = [
    [0, "existence", "match"],
    [0, "position", "match"],
    [0, "services.water", "match"],
    [0, "depth", "match"],
    [1, "existence", "match"],
    [1, "services.water", "deviation_confirmed_own"],
  ];
  for (const [i, attribute, result] of outcomes) await addResult(tx, sub.subdivisionKey, places[i]!.placeId, attribute, result);
  const runId = await evaluationRunRow(tx, sub.subdivisionKey, { rulesVersion: "v2", candidate: { rulesVersion: "v2" } });
  for (const [i, p] of places.entries()) {
    await tx.insert(evaluationProfiles).values({ runId, geoObjectId: p.geoObjectId, rulesVersion: "v2", factSchemaVersion: "v2", attributes: next[i]!, provenance: {}, contentHash: `h${i}` });
  }
  return { ...sub, places, runId };
}

/** A finished evaluation run over the subdivision's set (as `startConsolidationRun` writes it). */
async function evaluationRunRow(tx: Db, subdivisionKey: string, params: Record<string, unknown>): Promise<string> {
  const { id } = await createRun(tx, {
    kind: "reprocess",
    scope: { type: "system", id: "consolidation" },
    stages: [CONSOLIDATION_GEO_STAGE],
    params: { comparisonSetSubdivision: subdivisionKey, evaluation: true, ...params },
    triggeredBy: "test",
  });
  await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, id));
  return id;
}

/** An outcome for the place's current own value (or, with `evaluationRunId`, its value in that run's profile). */
async function addResult(tx: Db, subdivisionKey: string, placeId: string, attribute: ComparisonAttribute, result: ComparisonResultValue, evaluationRunId?: string) {
  const subject = (await loadComparisonSubjects(tx, subdivisionKey, { evaluationRunId })).find((s) => s.placeId === placeId)!;
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
      const { runId, places, subdivisionKey } = await scene(tx, [{ "services.water": true, "depth.anchoring_min": 8 }, BASE[1]!]);
      await addResult(tx, subdivisionKey, places[0]!.placeId, "depth", "deviation", runId);
      const c = await compareEvaluation(tx, runId);
      expect(c).toMatchObject({ pending: 0, changed: [{ attribute: "depth", checked: true }] });
      expect(c.next.precision).toBeCloseTo(5 / 6);
      expect(c.reasons).toEqual(["Präzision sinkt von 100,0 % auf 83,3 %"]);
      const refused = await activateCandidate(tx, { evaluationRunId: runId, activatedBy: "a" }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RegressionGateClosed);
      expect((refused as RegressionGateClosed).reasons).toEqual(c.reasons);
      // a checked change that holds the precision passes
      await addResult(tx, subdivisionKey, places[0]!.placeId, "depth", "match", runId);
      expect(await compareEvaluation(tx, runId)).toMatchObject({ pending: 0, passes: true });
    }));

  it("a candidate that drops a ban, a hazard or lifts an exclusion fails the gate (GR-2)", () =>
    withRollback(async (tx) => {
      const ban = { kind: "anchoring", months: null };
      const rock = { kind: "rock", name: "Xera" };
      const exclude = { excluded: true, reason: "anchoringBan", detail: null };
      const safe = { ...BASE[0]!, prohibitions: [ban], hazards: [rock], exclude };
      const { runId } = await scene(tx, [{ ...BASE[0]!, prohibitions: [], hazards: [], exclude: { excluded: false, reason: null, detail: null } }, BASE[1]!], [safe, BASE[1]!]);
      const c = await compareEvaluation(tx, runId);
      expect(c.changed).toEqual([]);
      expect(c.safetyLosses.map((l) => l.attribute)).toEqual(["hazards", "prohibitions", "exclude"]);
      expect(c.passes).toBe(false);
      expect(c.reasons).toHaveLength(3);
      expect(c.reasons[0]).toMatch(/^Sicherheitswert entfällt: /);
      await expect(activateCandidate(tx, { evaluationRunId: runId, activatedBy: "a" })).rejects.toThrow(RegressionGateClosed);
      // the same safety values on both sides pass
      const { runId: same } = await scene(tx, [safe, BASE[1]!], [safe, BASE[1]!]);
      expect(await compareEvaluation(tx, same)).toMatchObject({ safetyLosses: [], passes: true });
    }));

  it("an empty comparison set never passes (ruling M7-E-R2)", () =>
    withRollback(async (tx) => {
      const { runId, subdivisionId } = await scene(tx);
      await tx.delete(comparisonSet).where(eq(comparisonSet.subdivisionId, subdivisionId));
      const c = await compareEvaluation(tx, runId);
      expect(c).toMatchObject({ passes: false, reasons: ["Vergleichssatz leer"] });
      await expect(activateCandidate(tx, { evaluationRunId: runId, activatedBy: "a" })).rejects.toThrow(RegressionGateClosed);
      expect(await activations(tx)).toEqual([]);
    }));

  it("a candidate without any compared value never passes (ruling M7-E-R1/R2)", () =>
    withRollback(async (tx) => {
      const sub = await insertQualitySubdivision(tx, [{ lon: 21.01, lat: 35.2 }]);
      const place = await sub.addPlace({ inSet: true });
      await insertProfile(tx, place.geoObjectId, BASE[0]!, {});
      const runId = await evaluationRunRow(tx, sub.subdivisionKey, { rulesVersion: "v2", candidate: { rulesVersion: "v2" } });
      await tx.insert(evaluationProfiles).values({ runId, geoObjectId: place.geoObjectId, rulesVersion: "v2", factSchemaVersion: "v2", attributes: BASE[0]!, provenance: {}, contentHash: "h" });
      const c = await compareEvaluation(tx, runId);
      expect(c).toMatchObject({ next: { compared: 0 }, pending: 0, passes: false, reasons: ["Kein geprüfter Vergleichswert – erst Werte im Navily-Abgleich prüfen"] });
      await expect(activateCandidate(tx, { evaluationRunId: runId, activatedBy: "a" })).rejects.toThrow(RegressionGateClosed);
    }));

  it("a set place with a profile row after the evaluation finished refuses activation (ruling M7-E-R2)", () =>
    withRollback(async (tx) => {
      const { runId, places } = await scene(tx);
      await tx.update(runs).set({ finishedAt: sql`now()` }).where(eq(runs.id, runId));
      expect(await compareEvaluation(tx, runId)).toMatchObject({ passes: true });
      // a regular consolidation after the evaluation: the candidate was never evaluated on these profiles
      await tx.insert(profiles).values({
        geoObjectId: places[0]!.geoObjectId,
        version: 2,
        validFrom: "2026-10-19",
        attributes: BASE[0]!,
        provenance: {},
        sourcesCount: 0,
        documentsCount: 0,
        confidence: 0.8,
        contentHash: "later",
        factSchemaVersion: "v2",
        rulesVersion: "v1",
        createdAt: sql`now() + interval '1 minute'`,
      });
      const c = await compareEvaluation(tx, runId);
      expect(c).toMatchObject({ passes: false, reasons: ["Profile seit der Bewertung geändert (1 Ort) – neu bewerten"] });
      await expect(activateCandidate(tx, { evaluationRunId: runId, activatedBy: "a" })).rejects.toThrow(RegressionGateClosed);
      expect(await activations(tx)).toEqual([]);
    }));

  it("a rules part equal to the active version is never written (ruling M7-E-R2)", () =>
    withRollback(async (tx) => {
      const { runId } = await scene(tx);
      await tx
        .update(runs)
        .set({ params: sql`${runs.params} || ${JSON.stringify({ rulesVersion: "v1", candidate: { rulesVersion: "v1", extraction: OPUS } })}::jsonb` })
        .where(eq(runs.id, runId));
      await activateCandidate(tx, { evaluationRunId: runId, activatedBy: "a" });
      expect((await activations(tx)).map((r) => [r.kind, r.version])).toEqual([["extraction", `${OPUS.model}@p${OPUS.promptVersion}`]]);
      expect(await activeRulesVersion(tx)).toBe("v1");
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
      expect((await listEvaluations(tx, (await runParams(tx, runId)).comparisonSetSubdivision as string))[0]).toMatchObject({ runId, activated: ["consolidation_rules"] });
    }));

  it("an evaluation older than a later activation of the same kind cannot be activated (final review B M-4)", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, places, runId: older } = await scene(tx);
      // a second evaluation of the same set, activated first
      const newer = await evaluationRunRow(tx, subdivisionKey, { rulesVersion: "v2", candidate: { rulesVersion: "v2" } });
      for (const [i, p] of places.entries()) {
        await tx.insert(evaluationProfiles).values({ runId: newer, geoObjectId: p.geoObjectId, rulesVersion: "v2", factSchemaVersion: "v2", attributes: BASE[i]!, provenance: {}, contentHash: `n${i}` });
      }
      await activateCandidate(tx, { evaluationRunId: newer, activatedBy: "a" });
      const reason = "Nach dieser Bewertung wurde eine andere Konfiguration aktiviert – neu bewerten";
      expect((await compareEvaluation(tx, older)).reasons).toContain(reason);
      await expect(activateCandidate(tx, { evaluationRunId: older, activatedBy: "a" })).rejects.toThrow(RegressionGateClosed);
      expect((await activations(tx)).map((r) => r.evaluationRunId)).toEqual([newer]);
      // the activated run itself is not blocked by its own activation (double click stays idempotent)
      expect((await compareEvaluation(tx, newer)).reasons).not.toContain(reason);
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
      // a consolidation without a version (a place merge) takes the active one
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
    const sub = await insertQualitySubdivision(tx, [{ lon: 21.01, lat: 35.2 }]);
    const place = await sub.addPlace({ inSet: true });
    const m = await insertMention(tx, place.geoObjectId, { sourceId: await insertSource(tx) });
    await insertMentionFact(tx, place.geoObjectId, m, await insertExtraction(tx, place.geoObjectId, m), { value: "good" });
    const candidateRun = await insertExtraction(tx, place.geoObjectId, m, { model: OPUS.model, purpose: "comparison", startedAt: new Date("2026-10-18T11:00:00Z") });
    await insertMentionFact(tx, place.geoObjectId, m, candidateRun, { value: "poor" });
    return { ...sub, place };
  }
  const evaluated = async (tx: Db, runId: string, geoObjectId: string) =>
    (await tx.select().from(evaluationProfiles).where(eq(evaluationProfiles.runId, runId))).find((e) => e.geoObjectId === geoObjectId)!.attributes;

  it("an extraction candidate evaluation uses facts of the candidate extraction runs only", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, place } = await candidateScene(tx);
      const rec = recordingBoss();
      const { id } = await startEvaluation(tx, rec.boss, { subdivisionKey, candidate: { extraction: OPUS }, triggeredBy: "test" });
      const params = await runParams(tx, id);
      expect(params).toMatchObject({ evaluation: true, comparisonSetSubdivision: subdivisionKey, rulesVersion: "v1", extraction: OPUS, candidate: { extraction: OPUS } });
      expect(params.candidate).not.toHaveProperty("rulesVersion");
      const jobs = await consolidationGeoJobs(tx, { id, params });
      expect(jobs).toEqual([expect.objectContaining({ geoObjectId: place.geoObjectId, mode: "evaluation", rulesVersion: "v1", extraction: OPUS })]);
      for (const job of jobs) await consolidateGeoJob(tx, { ...job, runId: id });
      expect(await evaluated(tx, id, place.geoObjectId)).toMatchObject({ holding: "poor" });

      // the same set without a candidate extraction: the active run's facts
      const rules = await startEvaluation(tx, rec.boss, { subdivisionKey, candidate: { rulesVersion: "v1" }, triggeredBy: "test" });
      await consolidateGeo(tx, place.geoObjectId, { runId: rules.id, mode: "evaluation", rulesVersion: "v1" });
      expect(await evaluated(tx, rules.id, place.geoObjectId)).toMatchObject({ holding: "good" });
      expect((await runParams(tx, rules.id)).candidate).toEqual({ rulesVersion: "v1" });
      // nothing reached the profiles
      expect(await tx.select().from(profiles).where(eq(profiles.geoObjectId, place.geoObjectId))).toEqual([]);
    }));

  it("the extraction override is refused outside evaluation mode", () =>
    withRollback(async (tx) => {
      const { place, subdivisionKey } = await candidateScene(tx);
      await expect(consolidateGeo(tx, place.geoObjectId, { extraction: OPUS })).rejects.toThrow(/evaluation mode only/);
      await expect(
        startConsolidationRun(tx, recordingBoss().boss, { scope: { comparisonSetSubdivision: subdivisionKey }, extraction: OPUS, triggeredBy: "test" }),
      ).rejects.toThrow(/evaluation run only/);
      expect(await tx.select().from(profiles).where(eq(profiles.geoObjectId, place.geoObjectId))).toEqual([]);
    }));

  it("startEvaluation refuses no candidate and an unknown version, model or prompt", () =>
    withRollback(async (tx) => {
      const { subdivisionKey } = await candidateScene(tx);
      const { boss, inserted } = recordingBoss();
      const start = (candidate: Parameters<typeof startEvaluation>[2]["candidate"]) =>
        startEvaluation(tx, boss, { subdivisionKey, candidate, triggeredBy: "test" });
      const refused = (reason: string) => ({ constructor: RunScopeNotReady, reason });
      await expect(start({})).rejects.toMatchObject(refused("evaluation_candidate_missing"));
      await expect(start({ rulesVersion: "v97" })).rejects.toMatchObject(refused("evaluation_candidate_unknown"));
      await expect(start({ extraction: { model: "gpt-unknown", promptVersion: 1 } })).rejects.toMatchObject(refused("evaluation_candidate_unknown"));
      await expect(start({ extraction: { model: OPUS.model, promptVersion: 99 } })).rejects.toMatchObject(refused("evaluation_candidate_unknown"));
      await expect(startEvaluation(tx, boss, { subdivisionKey: "test-unknown", candidate: { rulesVersion: "v1" }, triggeredBy: "test" })).rejects.toThrow("Unbekannter Landesteil test-unknown");
      expect(inserted).toEqual([]);
    }));
});

describe("frozen rules version (ruling M7-E-R1)", () => {
  /** Activates v2 as a deliberate activation would (a row in config_activations). */
  async function activateV2(tx: Db, subdivisionKey: string) {
    const evaluationRunId = await evaluationRunRow(tx, subdivisionKey, { rulesVersion: "v2", candidate: { rulesVersion: "v2" } });
    await tx.insert(configActivations).values({ kind: "consolidation_rules", version: "v2", evaluationRunId, comparison: {}, activatedBy: "test", activatedAt: sql`clock_timestamp()` });
    expect(await activeRulesVersion(tx)).toBe("v2");
  }

  /** A text run started under v1 whose extraction run holds a verified fact of a set place (its consolidation target). */
  async function textRunScene(tx: Db, rec: ReturnType<typeof recordingBoss>) {
    const sub = await insertQualitySubdivision(tx, [{ lon: 21.01, lat: 35.2 }]);
    const place = await sub.addPlace();
    const run = await startTextRun(tx, rec.boss, { documentVersionIds: [], triggeredBy: "test" });
    const m = await insertMention(tx, place.geoObjectId, { sourceId: await insertSource(tx) });
    await insertMentionFact(tx, place.geoObjectId, m, await insertExtraction(tx, place.geoObjectId, m, { runId: run.id }));
    return { ...sub, place, runId: run.id };
  }

  /** A model client that fails every call: a summary that gets as far as the model has read its rules already. */
  const noModel = { call: async () => { throw new Error("no model call in this test"); } } as unknown as ModelClient;
  const ctx = (tx: Db): JobContext => ({ db: tx, boss: recordingBoss().boss, log: createLogger("test"), jobId: "job" });

  it("text and geometry runs started before an activation keep the old version on their geo, summary and follow-up jobs", () =>
    withRollback(async (tx) => {
      const rec = recordingBoss();
      const text = await textRunScene(tx, rec);
      const bay = await buildBayScene(tx);
      const geometry = await startGeometryRun(tx, rec.boss, { placeId: bay.placeId }, "test");
      for (const id of [text.runId, geometry.id]) expect((await runParams(tx, id)).rulesVersion).toBe("v1");
      await activateV2(tx, text.subdivisionKey);

      for (const id of [text.runId, geometry.id]) {
        const run = { id, params: await runParams(tx, id) };
        const geoJobs = await consolidationGeoJobs(tx, run);
        expect(geoJobs.length).toBeGreaterThan(0);
        expect(geoJobs.every((j) => j.rulesVersion === "v1")).toBe(true);
        for (const job of geoJobs) await consolidateGeoJob(tx, { ...job, runId: id });
      }
      const [profile] = await tx.select({ rulesVersion: profiles.rulesVersion }).from(profiles).where(eq(profiles.runId, text.runId));
      expect(profile!.rulesVersion).toBe("v1");

      // the summary job carries the run's version and the summary reads those rules, not the active ones
      const textRun = { id: text.runId, params: await runParams(tx, text.runId) };
      const [summaryJob] = await summaryJobs(tx, textRun);
      expect(summaryJob).toMatchObject({ geoObjectId: text.place.geoObjectId, rulesVersion: "v1" });
      setModelClientFactory(() => noModel);
      try {
        configReads.length = 0;
        await expect(consolidationSummaryHandler({ ...summaryJob!, runId: text.runId }, ctx(tx))).rejects.toThrow("no model call in this test");
        expect(configReads).toEqual(["v1"]);
      } finally {
        setModelClientFactory(undefined);
      }

      // the follow-up reads the run's rules too
      configReads.length = 0;
      await requestPlaceDiscovery(tx, rec.boss, text.runId);
      expect(configReads).toContain("v1");
      expect(configReads).not.toContain("v2");
    }));

  it("a catch-up consolidates with the rules version of the run it catches up", () =>
    withRollback(async (tx) => {
      const rec = recordingBoss();
      const text = await textRunScene(tx, rec);
      await activateV2(tx, text.subdivisionKey);
      await markConsolidationSkipped(tx, text.runId, "run_ended");
      const result = await catchUpConsolidation(tx, rec.boss, text.runId, "test");
      expect(result.status).toBe("started");
      const catchUp = (result as { consolidationRunId: string }).consolidationRunId;
      expect(await runParams(tx, catchUp)).toMatchObject({ geoObjectIds: [text.place.geoObjectId], rulesVersion: "v1" });
      expect(rec.inserted.filter((j) => j.queue === "consolidation.geo" && j.data.runId === catchUp).map((j) => j.data.rulesVersion)).toEqual(["v1"]);
    }));

  it("consolidationConfigFor refuses a rules version that is not a string", () =>
    withRollback(async (tx) => {
      await expect(consolidationConfigFor(tx, 2)).rejects.toThrow(/rules version must be a string/);
      await expect(consolidationConfigFor(tx, null)).rejects.toThrow(/rules version must be a string/);
      expect((await consolidationConfigFor(tx, undefined)).version).toBe("v1");
    }));
});
