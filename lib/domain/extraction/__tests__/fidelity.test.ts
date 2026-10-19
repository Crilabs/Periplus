import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertTestExtractionRun, insertTestGeoObject, insertTestRun, insertTestVersion } from "@/test/text";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { extractionRuns, extractionUnits, facts, mentions, routes, routeStops, runs, type ExtractionPurpose } from "@/lib/db/schema";
import { activeExtractionRun } from "@/lib/domain/extraction/active-run";
import { belegtreue, checkQuoteFidelity, fidelityOutcome, fidelityShare } from "@/lib/domain/extraction/fidelity";
import { completeUnit, emptyFactStats } from "@/lib/domain/extraction/facts";
import { storeRoute } from "@/lib/domain/extraction/routes";
import { checkExtractionRun, CHECK_STAGE, planCheck } from "@/lib/pipeline/text/check";
import { ROUTE_STAGE } from "@/lib/pipeline/text/routes";
import { TEXT_RUN_STAGES } from "@/lib/pipeline/text/run";

/*
 * Belegtreue (spec 06/10): every text fact and route stop of an extraction run is checked again against its chunk; a
 * run below 100 % is blocked and never the active run of a version (M5 consolidates only the active run).
 */

const config = loadConfig("config");
const TEXT = "Kolona is a quiet bay. Holding is good in sand, depth 6 m.";
const QUOTE = "Holding is good in sand";
const START = TEXT.indexOf(QUOTE);

/** A version with one chunk, a bay and its mention. */
async function scene(tx: Db) {
  const v = await insertTestVersion(tx, [TEXT]);
  const geoObjectId = await insertTestGeoObject(tx);
  const [m] = await tx
    .insert(mentions)
    .values({
      documentVersionId: v.versionId,
      chunkId: v.chunkIds[0]!,
      geoObjectId,
      surface: "Kolona",
      charStart: 0,
      charEnd: 6,
      observedAt: "2026-10-19",
      confidence: 1,
      matchKind: "deterministic",
      extractionStatus: "done",
    })
    .returning({ id: mentions.id });
  return { ...v, geoObjectId, mentionId: m!.id, runId: await insertTestRun(tx) };
}

type Scene = Awaited<ReturnType<typeof scene>>;

/** A text fact of the extraction run; `start` overrides the stored quote start. */
async function insertFact(tx: Db, s: Scene, extractionRunId: string, attribute: string, start = START) {
  const [row] = await tx
    .insert(facts)
    .values({
      geoObjectId: s.geoObjectId,
      attribute,
      value: "good",
      mentionId: s.mentionId,
      quote: QUOTE,
      quoteVerified: true,
      quoteChunkId: s.chunkIds[0]!,
      quoteStart: start,
      quoteEnd: start + QUOTE.length,
      observedAt: "2026-10-19",
      confidence: 0.9,
      extractionRunId,
      factSchemaVersion: "v2",
    })
    .returning({ id: facts.id });
  return row!.id;
}

/** An extraction run of the scene's run with one done unit for the scene's version. */
async function extractionRun(
  tx: Db,
  s: Scene,
  values: {
    model?: string;
    promptVersion?: number;
    purpose?: ExtractionPurpose;
    status?: "running" | "finished";
    startedAt?: Date;
    /** The geo objects with a unit (default the scene's) and the status of these units. */
    geoObjectIds?: string[];
    unitStatus?: "pending" | "done" | "failed";
  } = {},
) {
  const id = await insertTestExtractionRun(tx, {
    runId: s.runId,
    model: values.model ?? "claude-sonnet-5-5",
    promptVersion: values.promptVersion ?? config.models.tasks["extract-facts"]!.promptVersion,
    purpose: values.purpose ?? "regular",
    status: values.status ?? "running",
    startedAt: values.startedAt ?? new Date("2026-10-19T10:00:00Z"),
  });
  await tx.insert(extractionUnits).values(
    (values.geoObjectIds ?? [s.geoObjectId]).map((geoObjectId) => ({
      extractionRunId: id,
      documentVersionId: s.versionId,
      geoObjectId,
      part: 0,
      level: "place",
      mentionIds: geoObjectId === s.geoObjectId ? [s.mentionId] : [],
      chunkIds: s.chunkIds,
      status: values.unitStatus ?? "done",
    })),
  );
  return id;
}

const runRow = async (tx: Db, id: string) => (await tx.select().from(extractionRuns).where(eq(extractionRuns.id, id)))[0]!;

describe("quote fidelity", () => {
  it("a run whose facts all verify is finished with ratio 1", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const id = await extractionRun(tx, s);
      await insertFact(tx, s, id, "holding");
      await insertFact(tx, s, id, "seabed");
      expect(await checkQuoteFidelity(tx, id, config)).toEqual({ facts: 2, verified: 2, ratio: 1, failures: [] });
      const row = await runRow(tx, id);
      expect(row).toMatchObject({ status: "finished", quoteCheck: { facts: 2, verified: 2, ratio: 1, failures: [] } });
      expect(row.finishedAt).toBeInstanceOf(Date);
      expect(await belegtreue(tx, s.runId)).toEqual({ facts: 2, verified: 2, ratio: 1 });

      // a run without any text fact is finished with ratio 1 too
      const empty = await insertTestExtractionRun(tx, { runId: s.runId, model: "claude-opus-5-5" });
      expect(await checkQuoteFidelity(tx, empty, config)).toEqual({ facts: 0, verified: 0, ratio: 1, failures: [] });
      expect((await runRow(tx, empty)).status).toBe("finished");
    }));

  it("a fact whose chunk text no longer contains the quote blocks the run", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const id = await extractionRun(tx, s);
      await insertFact(tx, s, id, "holding");
      // the insert passes every database check; only the control finds that the stored span is not the quote
      const wrong = await insertFact(tx, s, id, "seabed", START + 3);
      const result = await checkQuoteFidelity(tx, id, config);
      expect(result).toEqual({ facts: 2, verified: 1, ratio: 0.5, failures: [{ factId: wrong, kind: "fact", reason: "offset_mismatch" }] });
      expect(await runRow(tx, id)).toMatchObject({ status: "blocked", quoteCheck: { ratio: 0.5 } });
      expect(await belegtreue(tx, s.runId)).toEqual({ facts: 2, verified: 1, ratio: 0.5 });
    }));

  it("a route stop is checked against its chunk too", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const id = await insertTestExtractionRun(tx, { runId: s.runId, task: "extract-route" });
      const [route] = await tx.insert(routes).values({ documentVersionId: s.versionId, extractionRunId: id, stopsCount: 2 }).returning({ id: routes.id });
      const stop = (ordinal: number, quote: string, leg: unknown = null) =>
        tx
          .insert(routeStops)
          .values({ routeId: route!.id, ordinal, name: "Kolona", quote, quoteVerified: true, quoteChunkId: s.chunkIds[0]!, leg })
          .returning({ id: routeStops.id });
      await stop(0, "Kolona is a quiet bay");
      const [bad] = await stop(1, "Holding is good in sand", { distance_nm: 4, duration_h: null, wind_direction: null, wind_beaufort: null, quote: "a leg of 4 nm under sail", quote_chunk_id: s.chunkIds[0]! });
      const result = await checkQuoteFidelity(tx, id, config);
      expect(result).toEqual({ facts: 2, verified: 1, ratio: 0.5, failures: [{ factId: bad!.id, kind: "route_leg", reason: "not_found" }] });
      expect((await runRow(tx, id)).status).toBe("blocked");
    }));

  it("one failure blocks the run even when the rounded share is 1", () => {
    // 1 failure in 2,000,001 rounds to 1.000000: the status follows the failures, not the share (ruling M4-H-R3)
    const ratio = fidelityShare(2_000_000, 2_000_001);
    expect(ratio).toBe(1);
    expect(fidelityOutcome({ failures: [{ factId: "f", kind: "fact", reason: "not_found" }] })).toEqual({ status: "blocked", blockedReason: "quote_fidelity" });
    expect(fidelityOutcome({ failures: [] })).toEqual({ status: "finished", blockedReason: null });
  });

  it("a blocked run records why, and a passing check clears it", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const id = await extractionRun(tx, s);
      await insertFact(tx, s, id, "holding", START + 1);
      await checkQuoteFidelity(tx, id, config);
      expect(await runRow(tx, id)).toMatchObject({ status: "blocked", blockedReason: "quote_fidelity" });
      const ok = await extractionRun(tx, s, { model: "claude-opus-5-5" });
      await insertFact(tx, s, ok, "holding");
      await checkQuoteFidelity(tx, ok, config);
      expect(await runRow(tx, ok)).toMatchObject({ status: "finished", blockedReason: null });
    }));

  it("a unit completed after the check blocks the run (late_results) until the check runs again", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const id = await extractionRun(tx, s, { unitStatus: "failed" });
      await checkExtractionRun(tx, id, config);
      expect(await runRow(tx, id)).toMatchObject({ status: "finished", blockedReason: null });
      expect(await activeExtractionRun(tx, s.versionId, s.geoObjectId, config)).toBeNull();
      // a revived batch completes the unit after all: the check no longer covers its facts
      await insertFact(tx, s, id, "holding");
      const [unit] = await tx.select({ id: extractionUnits.id }).from(extractionUnits).where(eq(extractionUnits.extractionRunId, id));
      expect(await completeUnit(tx, unit!.id, emptyFactStats(), { inputTokens: 1, outputTokens: 1 }, 0)).toBe(true);
      expect(await runRow(tx, id)).toMatchObject({ status: "blocked", blockedReason: "late_results" });
      expect(await activeExtractionRun(tx, s.versionId, s.geoObjectId, config)).toBeNull();
      // checked again, it is finished and covers the late facts
      expect(await checkExtractionRun(tx, id, config)).toMatchObject({ facts: 1, verified: 1, ratio: 1 });
      expect(await runRow(tx, id)).toMatchObject({ status: "finished", blockedReason: null, stats: { done: 1, facts: 1 } });
      expect(await activeExtractionRun(tx, s.versionId, s.geoObjectId, config)).toEqual({ id });
    }));

  it("a unit completed while the run is still running does not block it", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const id = await extractionRun(tx, s, { unitStatus: "pending" });
      const [unit] = await tx.select({ id: extractionUnits.id }).from(extractionUnits).where(eq(extractionUnits.extractionRunId, id));
      await completeUnit(tx, unit!.id, emptyFactStats(), { inputTokens: 1, outputTokens: 1 }, 0);
      expect(await runRow(tx, id)).toMatchObject({ status: "running", blockedReason: null });
    }));

  it("a route stored after the check blocks the route run (late_results)", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      // the route stats read the text run's frozen version set
      await tx.update(runs).set({ params: { documentVersionIds: [s.versionId] } }).where(eq(runs.id, s.runId));
      const id = await insertTestExtractionRun(tx, { runId: s.runId, task: "extract-route" });
      await checkExtractionRun(tx, id, config);
      expect((await runRow(tx, id)).status).toBe("finished");
      const stored = await storeRoute(
        tx,
        { versionId: s.versionId, extractionRunId: id, sections: [{ stops: [{ name: "Kolona", date: null, mooring: "anchor", quote: "Kolona is a quiet bay", leg: null }] }] },
        config,
      );
      expect(stored.stops).toBe(1);
      expect(await runRow(tx, id)).toMatchObject({ status: "blocked", blockedReason: "late_results" });
      expect(await checkExtractionRun(tx, id, config)).toMatchObject({ facts: 1, verified: 1, ratio: 1 });
      expect(await runRow(tx, id)).toMatchObject({ status: "finished", blockedReason: null });
    }));

  it("the route and check stages are the last two text stages, so the check covers routes", () => {
    expect(TEXT_RUN_STAGES.slice(-2)).toEqual([ROUTE_STAGE, CHECK_STAGE]);
  });

  it("the check stage plans one job per extraction run and writes the run's stats", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const a = await extractionRun(tx, s);
      const b = await extractionRun(tx, s, { model: "claude-opus-5-5", purpose: "comparison" });
      await insertFact(tx, s, a, "holding");
      const jobs = await planCheck(tx, { id: s.runId, params: {} });
      expect(jobs).toEqual([a, b].sort().map((id) => ({ key: `check:${id}`, extractionRunId: id })));
      await checkExtractionRun(tx, a, config);
      const row = await runRow(tx, a);
      expect(row).toMatchObject({ status: "finished", stats: { units: 1, done: 1, facts: 1 }, quoteCheck: { ratio: 1 } });
    }));
});

describe("active extraction run", () => {
  it("a blocked run is never the active run", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const id = await extractionRun(tx, s);
      await insertFact(tx, s, id, "holding", START + 1);
      await checkQuoteFidelity(tx, id, config);
      expect((await runRow(tx, id)).status).toBe("blocked");
      expect(await activeExtractionRun(tx, s.versionId, s.geoObjectId, config)).toBeNull();
    }));

  it("the active run follows the configured model; a comparison run is ignored", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const sonnet = await extractionRun(tx, s, { status: "finished" });
      const opus = await extractionRun(tx, s, { model: "claude-opus-5-5", status: "finished", purpose: "comparison", startedAt: new Date("2026-10-19T11:00:00Z") });
      expect(await activeExtractionRun(tx, s.versionId, s.geoObjectId, config)).toEqual({ id: sonnet });
      const opusConfig: AppConfig = {
        ...config,
        models: { ...config.models, tasks: { ...config.models.tasks, "extract-facts": { ...config.models.tasks["extract-facts"]!, model: "claude-opus-5-5" } } },
      };
      // the comparison run has the configured model now, but is never active
      expect(await activeExtractionRun(tx, s.versionId, s.geoObjectId, opusConfig)).toBeNull();
      expect(opus).not.toBe(sonnet);
      // another prompt version is not the active configuration either
      const v1Config: AppConfig = {
        ...config,
        models: { ...config.models, tasks: { ...config.models.tasks, "extract-facts": { ...config.models.tasks["extract-facts"]!, promptVersion: 1 } } },
      };
      expect(await activeExtractionRun(tx, s.versionId, s.geoObjectId, v1Config)).toBeNull();
    }));

  it("is resolved per geo object: a newer run replaces an older one only for the objects it extracted", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const other = await insertTestGeoObject(tx);
      const third = await insertTestGeoObject(tx);
      const older = await extractionRun(tx, s, { status: "finished", geoObjectIds: [s.geoObjectId, other, third] });
      // a later regular run over the rematch selection extracts only the newly confirmed object
      const rematch = await extractionRun(tx, { ...s, runId: await insertTestRun(tx) }, {
        status: "finished",
        startedAt: new Date("2026-10-20T10:00:00Z"),
        geoObjectIds: [other],
      });
      expect(await activeExtractionRun(tx, s.versionId, s.geoObjectId, config)).toEqual({ id: older });
      expect(await activeExtractionRun(tx, s.versionId, other, config)).toEqual({ id: rematch });
      // a newer run whose unit for an object failed keeps the older run active for that object
      const partial = await extractionRun(tx, { ...s, runId: await insertTestRun(tx) }, {
        status: "finished",
        startedAt: new Date("2026-10-21T10:00:00Z"),
        geoObjectIds: [third],
        unitStatus: "failed",
      });
      expect(partial).not.toBe(older);
      expect(await activeExtractionRun(tx, s.versionId, third, config)).toEqual({ id: older });
    }));

  it("a newer finished run replaces an older one for the same version", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      await extractionRun(tx, s, { status: "finished" });
      const later = await insertTestRun(tx);
      const newer = await extractionRun(tx, { ...s, runId: later }, { status: "finished", purpose: "reprocess", startedAt: new Date("2026-10-20T10:00:00Z") });
      expect(await activeExtractionRun(tx, s.versionId, s.geoObjectId, config)).toEqual({ id: newer });
      // a still running newer run does not count, nor one without a done unit for the version
      const third = await insertTestRun(tx);
      await extractionRun(tx, { ...s, runId: third }, { status: "running", startedAt: new Date("2026-10-21T10:00:00Z") });
      const fourth = await insertTestRun(tx);
      const failedUnits = await extractionRun(tx, { ...s, runId: fourth }, { status: "finished", startedAt: new Date("2026-10-22T10:00:00Z") });
      await tx.update(extractionUnits).set({ status: "failed" }).where(eq(extractionUnits.extractionRunId, failedUnits));
      expect(await activeExtractionRun(tx, s.versionId, s.geoObjectId, config)).toEqual({ id: newer });
    }));
});
