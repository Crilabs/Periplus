import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { getConfig, loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { comparisonResults, comparisonSet, configActivations, evaluationProfiles, profiles, runs, type ComparisonAttribute, type ComparisonResultValue } from "@/lib/db/schema";
import { activeRulesVersion, consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { createRun } from "@/lib/domain/runs";
import { CONSOLIDATION_GEO_STAGE } from "@/lib/pipeline/consolidation/stages";
import { startConsolidationRun } from "@/lib/pipeline/consolidation/run";
import { startEvaluation } from "@/lib/pipeline/quality-run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { insertExtraction, insertMention, insertMentionFact, insertProfile, insertSource } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertQualitySubdivision } from "@/test/quality";
import { comparisonValues, loadComparisonSubjects } from "../comparison-values";
import { loadProfileSubjects } from "../profile-subjects";
import { activateCandidate, compareEvaluation, listEvaluations, NotAnEvaluationRun, RegressionGateClosed } from "../regression";

/*
 * The regression gate (spec 10, plan Task 10, rulings M7-P10/P11): old/new comparison over a comparison set of two
 * places with evaluation profiles inserted directly, activation and the rules resolver. A released rules version „v80“
 * exists for this file only (a copy of v1, mocked into the config module), so an activation can name a version other
 * than active.json's. Synthetic subdivision at 21.0° E / 35.2° N, every row in withRollback.
 */

/** The versions `getConsolidationConfig` was asked for (`undefined`: active.json), to see which rules a job read. */
const configReads = vi.hoisted(() => [] as Array<string | undefined>);

vi.mock("@/lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...real,
    consolidationVersions: (dir?: string) => [...real.consolidationVersions(dir), "v80"],
    getConsolidationConfig: (version?: string, dir?: string) => {
      configReads.push(version);
      return version === "v80" ? { ...real.getConsolidationConfig(real.getConfig().consolidation.version, dir), version: "v80" } : real.getConsolidationConfig(version, dir);
    },
  };
});

/** The active rules version (config/consolidation/active.json); „v80“ below is a later released version made up by the mock. */
const ACTIVE_RULES = getConfig().consolidation.version;

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
  const runId = await evaluationRunRow(tx, sub.subdivisionKey, { rulesVersion: "v80", candidate: { rulesVersion: "v80" } });
  for (const [i, p] of places.entries()) {
    await tx.insert(evaluationProfiles).values({ runId, geoObjectId: p.geoObjectId, rulesVersion: "v80", factSchemaVersion: "v2", attributes: next[i]!, provenance: {}, contentHash: `h${i}` });
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
  const subjects = evaluationRunId ? await loadComparisonSubjects(tx, subdivisionKey, { evaluationRunId }) : await loadProfileSubjects(tx, subdivisionKey);
  const subject = subjects.find((s) => s.placeId === placeId)!;
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
      expect(c).toMatchObject({ candidate: { rulesVersion: "v80" }, status: "finished", passes: true, reasons: [] });
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
      const runId = await evaluationRunRow(tx, sub.subdivisionKey, { rulesVersion: "v80", candidate: { rulesVersion: "v80" } });
      await tx.insert(evaluationProfiles).values({ runId, geoObjectId: place.geoObjectId, rulesVersion: "v80", factSchemaVersion: "v2", attributes: BASE[0]!, provenance: {}, contentHash: "h" });
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
        rulesVersion: ACTIVE_RULES,
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
        .set({ params: sql`${runs.params} || ${JSON.stringify({ rulesVersion: ACTIVE_RULES, candidate: { rulesVersion: ACTIVE_RULES, extraction: OPUS } })}::jsonb` })
        .where(eq(runs.id, runId));
      await activateCandidate(tx, { evaluationRunId: runId, activatedBy: "a" });
      expect((await activations(tx)).map((r) => [r.kind, r.version])).toEqual([["extraction", `${OPUS.model}@p${OPUS.promptVersion}`]]);
      expect(await activeRulesVersion(tx)).toBe(ACTIVE_RULES);
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
      expect(await activeRulesVersion(tx)).toBe(ACTIVE_RULES);
      await activateCandidate(tx, { evaluationRunId: runId, activatedBy: "admin@test.invalid" });
      await activateCandidate(tx, { evaluationRunId: runId, activatedBy: "admin@test.invalid" }); // a double click
      const rows = await activations(tx);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "consolidation_rules", version: "v80", evaluationRunId: runId, activatedBy: "admin@test.invalid" });
      // numbers only (Grundprinzip 9)
      expect(rows[0]!.comparison).toEqual({
        old: { precision: 1, coverage: 1, compared: 6 },
        next: { precision: 1, coverage: 1, compared: 6 },
        changed: 0,
        pending: 0,
      });
      expect(await activeRulesVersion(tx)).toBe("v80");
      expect((await consolidationConfigFor(tx)).version).toBe("v80");
      expect((await consolidationConfigFor(tx, ACTIVE_RULES)).version).toBe(ACTIVE_RULES);
      expect((await listEvaluations(tx, (await runParams(tx, runId)).comparisonSetSubdivision as string))[0]).toMatchObject({ runId, activated: ["consolidation_rules"] });
    }));

  it("an evaluation older than a later activation of the same kind cannot be activated (final review B M-4)", () =>
    withRollback(async (tx) => {
      const { subdivisionKey, places, runId: older } = await scene(tx);
      // a second evaluation of the same set, activated first
      const newer = await evaluationRunRow(tx, subdivisionKey, { rulesVersion: "v80", candidate: { rulesVersion: "v80" } });
      for (const [i, p] of places.entries()) {
        await tx.insert(evaluationProfiles).values({ runId: newer, geoObjectId: p.geoObjectId, rulesVersion: "v80", factSchemaVersion: "v2", attributes: BASE[i]!, provenance: {}, contentHash: `n${i}` });
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

  it("an activated version without config file falls back to active.json", () =>
    withRollback(async (tx) => {
      const { runId } = await scene(tx);
      const activate = (version: string) =>
        tx.insert(configActivations).values({ kind: "consolidation_rules", version, evaluationRunId: runId, comparison: {}, activatedBy: "test", activatedAt: sql`clock_timestamp()` });
      await activate("v99");
      expect(await activeRulesVersion(tx)).toBe(ACTIVE_RULES);
      await activate("v80");
      await activate("v98"); // newest, but not released: the newest released one counts
      expect(await activeRulesVersion(tx)).toBe("v80");
      // an extraction approval is no rules activation
      await tx.insert(configActivations).values({ kind: "extraction", version: "v1", evaluationRunId: runId, comparison: {}, activatedBy: "test", activatedAt: sql`clock_timestamp()` });
      expect(await activeRulesVersion(tx)).toBe("v80");
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
      await expect(startEvaluation(tx, boss, { subdivisionKey: "test-unknown", candidate: { rulesVersion: ACTIVE_RULES }, triggeredBy: "test" })).rejects.toThrow("Unbekannter Landesteil test-unknown");
      expect(inserted).toEqual([]);
    }));
});

describe("frozen rules version (ruling M7-E-R1)", () => {
  it("consolidationConfigFor refuses a rules version that is not a string", () =>
    withRollback(async (tx) => {
      await expect(consolidationConfigFor(tx, 2)).rejects.toThrow(/rules version must be a string/);
      await expect(consolidationConfigFor(tx, null)).rejects.toThrow(/rules version must be a string/);
      expect((await consolidationConfigFor(tx, undefined)).version).toBe(ACTIVE_RULES);
    }));
});
