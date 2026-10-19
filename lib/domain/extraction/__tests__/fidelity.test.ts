import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertTestExtractionRun, insertTestGeoObject, insertTestRun, insertTestVersion } from "@/test/text";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { extractionRuns, extractionUnits, facts, mentions, routes, routeStops, type ExtractionPurpose } from "@/lib/db/schema";
import { activeExtractionRun } from "@/lib/domain/extraction/active-run";
import { belegtreue, checkQuoteFidelity } from "@/lib/domain/extraction/fidelity";
import { checkExtractionRun, planCheck } from "@/lib/pipeline/text/check";

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
  values: { model?: string; promptVersion?: number; purpose?: ExtractionPurpose; status?: "running" | "finished" | "blocked"; startedAt?: Date } = {},
) {
  const id = await insertTestExtractionRun(tx, {
    runId: s.runId,
    model: values.model ?? "claude-sonnet-5-5",
    promptVersion: values.promptVersion ?? 2,
    purpose: values.purpose ?? "regular",
    status: values.status ?? "running",
    startedAt: values.startedAt ?? new Date("2026-10-19T10:00:00Z"),
  });
  await tx.insert(extractionUnits).values({
    extractionRunId: id,
    documentVersionId: s.versionId,
    geoObjectId: s.geoObjectId,
    part: 0,
    level: "place",
    mentionIds: [s.mentionId],
    chunkIds: s.chunkIds,
    status: "done",
  });
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
      expect(await activeExtractionRun(tx, s.versionId, config)).toBeNull();
    }));

  it("the active run follows the configured model; a comparison run is ignored", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const sonnet = await extractionRun(tx, s, { status: "finished" });
      const opus = await extractionRun(tx, s, { model: "claude-opus-5-5", status: "finished", purpose: "comparison", startedAt: new Date("2026-10-19T11:00:00Z") });
      expect(await activeExtractionRun(tx, s.versionId, config)).toEqual({ id: sonnet });
      const opusConfig: AppConfig = {
        ...config,
        models: { ...config.models, tasks: { ...config.models.tasks, "extract-facts": { ...config.models.tasks["extract-facts"]!, model: "claude-opus-5-5" } } },
      };
      // the comparison run has the configured model now, but is never active
      expect(await activeExtractionRun(tx, s.versionId, opusConfig)).toBeNull();
      expect(opus).not.toBe(sonnet);
      // another prompt version is not the active configuration either
      const v1Config: AppConfig = {
        ...config,
        models: { ...config.models, tasks: { ...config.models.tasks, "extract-facts": { ...config.models.tasks["extract-facts"]!, promptVersion: 1 } } },
      };
      expect(await activeExtractionRun(tx, s.versionId, v1Config)).toBeNull();
    }));

  it("a newer finished run replaces an older one for the same version", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      await extractionRun(tx, s, { status: "finished" });
      const later = await insertTestRun(tx);
      const newer = await extractionRun(tx, { ...s, runId: later }, { status: "finished", purpose: "reprocess", startedAt: new Date("2026-10-20T10:00:00Z") });
      expect(await activeExtractionRun(tx, s.versionId, config)).toEqual({ id: newer });
      // a still running newer run does not count, nor one without a done unit for the version
      const third = await insertTestRun(tx);
      await extractionRun(tx, { ...s, runId: third }, { status: "running", startedAt: new Date("2026-10-21T10:00:00Z") });
      const fourth = await insertTestRun(tx);
      const failedUnits = await extractionRun(tx, { ...s, runId: fourth }, { status: "finished", startedAt: new Date("2026-10-22T10:00:00Z") });
      await tx.update(extractionUnits).set({ status: "failed" }).where(eq(extractionUnits.extractionRunId, failedUnits));
      expect(await activeExtractionRun(tx, s.versionId, config)).toEqual({ id: newer });
    }));
});
