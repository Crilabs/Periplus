import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { quietDay } from "@/test/external-calls";
import { insertTestGeoObject, insertTestMention, type TestMention } from "@/test/text";
import { MockModel } from "@/lib/ai/mock";
import type { ExtractedFact, ExtractFactsInput } from "@/lib/ai/tasks/extract-facts";
import type { ModelClient } from "@/lib/ai/types";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import {
  chunks,
  documents,
  documentVersions,
  extractionRuns,
  extractionUnits,
  facts,
  mentions,
  modelComparisonRatings,
  modelComparisons,
  runs,
  sources,
  type DocType,
} from "@/lib/db/schema";
import { activeExtractionRun } from "@/lib/domain/extraction/active-run";
import {
  comparisonShortfall,
  compareRuns,
  ComparisonTooExpensive,
  createModelComparison,
  createModelComparisonWithinBudget,
  deviationSample,
  estimateComparisonCostEur,
  pickComparisonUnits,
  rateDeviation,
  ratingSummary,
  unitKeyOf,
  valuesAgree,
} from "@/lib/domain/extraction/comparison";
import { newId } from "@/lib/domain/ids";
import { recordJobOutcome } from "@/lib/domain/runs";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { enqueueRunAdvance } from "@/lib/jobs/enqueue";
import { BATCH_POLL_QUEUE, RUN_ADVANCE_QUEUE } from "@/lib/jobs/queues";
import { pollBatch, type BatchDeps, type PollOptions } from "@/lib/pipeline/batches";
import { enqueueStage } from "@/lib/pipeline/runs";
import { CHECK_QUEUE, checkExtractionRun } from "@/lib/pipeline/text/check";
import { EXTRACT_QUEUE, extractUnits } from "@/lib/pipeline/text/extract";
import { MODEL_COMPARISON_STAGES, startModelComparisonRun } from "@/lib/pipeline/text/run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";

/*
 * The model comparison (Task 19) inside withRollback. The sample is drawn over all mentions the transaction sees: only
 * its own (mentions are committed by no test), so its rows are the candidates. Geo objects at 21.0° E / 35.2° N.
 */

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const [MODEL_A, MODEL_B] = config.models.comparison.models as [string, string];
const TEXT = "Good holding in sand, well sheltered from the meltemi.";

/** `n` sources of the given types (round-robin), each with `perSource` current versions mentioning one bay. */
async function scene(tx: Db, input: { sources: number; types: DocType[]; perSource: number }) {
  const sourceRows = Array.from({ length: input.sources }, (_, i) => ({
    id: newId(),
    domain: `${newId()}.test.invalid`,
    name: `Test source ${i}`,
    type: input.types[i % input.types.length]!,
    weight: 0.6,
    crawlRules: { startUrls: [] },
    origin: "manual" as const,
  }));
  await tx.insert(sources).values(sourceRows);
  const docs: Array<typeof documents.$inferInsert> = [];
  const versions: Array<typeof documentVersions.$inferInsert> = [];
  const chunkRows: Array<typeof chunks.$inferInsert> = [];
  const mentionRows: Array<typeof mentions.$inferInsert> = [];
  for (const s of sourceRows) {
    const objectId = await insertTestGeoObject(tx);
    for (let j = 0; j < input.perSource; j++) {
      const documentId = newId();
      const versionId = newId();
      const chunkId = newId();
      const url = `https://${s.domain}/${j}`;
      docs.push({ id: documentId, sourceId: s.id, url, urlNormalized: url, docType: s.type });
      versions.push({
        id: versionId,
        documentId,
        fetchedAt: new Date("2026-10-19T10:00:00Z"),
        contentHash: newId(),
        rawHash: "r",
        rawKey: `archive/${documentId}/raw.html`,
        mdKey: `archive/${documentId}/raw.md`,
        observedAt: "2026-10-19",
        observedAtBasis: "fetched",
        docType: s.type,
        converter: "local",
        charCount: TEXT.length,
      });
      chunkRows.push({ id: chunkId, documentVersionId: versionId, ordinal: 0, text: TEXT, textNormalized: TEXT, textHash: "t", charStart: 0, charEnd: TEXT.length, wordCount: 9 });
      mentionRows.push({
        documentVersionId: versionId,
        chunkId,
        geoObjectId: objectId,
        surface: "Good",
        charStart: 0,
        charEnd: 4,
        observedAt: "2026-10-19",
        confidence: 1,
        matchKind: "deterministic",
        matchScore: 1,
      });
    }
  }
  await tx.insert(documents).values(docs);
  await tx.insert(documentVersions).values(versions);
  await tx.execute(sql`
    update documents d set current_version_id = v.id from document_versions v
    where v.document_id = d.id and d.source_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(sourceRows.map((s) => s.id))}::jsonb))
  `);
  await tx.insert(chunks).values(chunkRows);
  await tx.insert(mentions).values(mentionRows);
  return { sourceIds: sourceRows.map((s) => s.id), versionIds: versions.map((v) => v.id!) };
}

function recordingBoss() {
  const inserted: Array<{ queue: string; id?: string; data: Record<string, unknown> }> = [];
  const boss = {
    insert: async (queue: string, jobs: Array<{ id?: string; data: Record<string, unknown> }>) => {
      const fresh = jobs.filter((j) => !inserted.some((i) => i.id !== undefined && i.id === j.id));
      for (const job of fresh) inserted.push({ queue, ...job });
      return fresh.map((j) => j.id ?? newId());
    },
  } as unknown as PgBoss;
  return { boss, inserted };
}

/** A model client sending each batch to the mock of its model (`ctx.model`), as the provider would. */
function modelRouter(byModel: Record<string, MockModel>): ModelClient {
  const owner = new Map<string, MockModel>();
  const of = (model: string | undefined) => {
    const mock = model ? byModel[model] : undefined;
    if (!mock) throw new Error(`no mock for model ${model}`);
    return mock;
  };
  return {
    call: (task, input, ctx) => of(ctx?.model).call(task, input, ctx),
    async submitBatch(task, requests, ctx) {
      const mock = of(ctx?.model);
      const submitted = await mock.submitBatch(task, requests, ctx);
      owner.set(submitted.batchId, mock);
      return submitted;
    },
    collectBatch: (task, batchId) => owner.get(batchId)!.collectBatch(task, batchId),
    cancelBatch: (batchId) => owner.get(batchId)!.cancelBatch(batchId),
    listBatches: async (window) => (await Promise.all(Object.values(byModel).map((m) => m.listBatches(window)))).flat(),
  };
}

const fact = (attribute: string, value: unknown, quote: string): ExtractedFact => ({
  attribute,
  value: JSON.stringify(value),
  quote,
  chunk: 1,
  confidence: 0.8,
  observed_at: null,
  poi_name: null,
});

/** Executes every job of the run like the worker: stage jobs, `run.advance`, `ai.batch.poll`. */
async function drive(tx: Db, rec: ReturnType<typeof recordingBoss>, model: ModelClient, runId: string, now: Date) {
  const deps: BatchDeps = { model, boss: rec.boss, config, now: () => now, reservationScope: { runIds: [runId] } };
  for (let i = 0; i < rec.inserted.length; i++) {
    const { queue, data } = rec.inserted[i]!;
    if (queue === RUN_ADVANCE_QUEUE) await enqueueStage(tx, rec.boss, String(data.runId), String(data.nextStage));
    else if (queue === BATCH_POLL_QUEUE) await pollBatch(tx, { ...deps, handlers: BATCH_HANDLERS }, String(data.batchId), { n: data.n, mode: data.mode } as PollOptions);
    else {
      const job = data as { runId: string; stage: string; key: string; extractionRunId: string; unitIds: string[] };
      if (queue === EXTRACT_QUEUE) await extractUnits(tx, deps, job);
      else if (queue === CHECK_QUEUE) await checkExtractionRun(tx, job.extractionRunId, config);
      else throw new Error(`no driver for queue ${queue}`);
      const result = await recordJobOutcome(tx, job.runId, job.stage, job.key, "done");
      if (result.nextStage) await enqueueRunAdvance(rec.boss, job.runId, result.nextStage, tx);
    }
  }
  const [row] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
  return row!.status;
}

/** A comparison with a finished run row and its two extraction runs, for facts written directly. */
async function comparisonWithRuns(tx: Db) {
  const [run] = await tx.insert(runs).values({ kind: "stage", scopeType: "system", scopeId: "model-comparison", triggeredBy: "test", status: "finished" }).returning({ id: runs.id });
  const [comparison] = await tx
    .insert(modelComparisons)
    .values({ label: `t-${newId()}`, models: [MODEL_A, MODEL_B], runId: run!.id, createdBy: "test" })
    .returning({ id: modelComparisons.id });
  const runOf = async (model: string) => {
    const [row] = await tx
      .insert(extractionRuns)
      .values({ task: "extract-facts", model, promptVersion: 3, factSchemaVersion: config.factSchema.version, purpose: "comparison", comparisonId: comparison!.id, runId: run!.id, status: "finished" })
      .returning({ id: extractionRuns.id });
    return row!.id;
  };
  return { comparisonId: comparison!.id, runA: await runOf(MODEL_A), runB: await runOf(MODEL_B) };
}

async function insertFact(tx: Db, m: TestMention, extractionRunId: string, attribute: string, value: unknown, confidence = 0.8): Promise<string> {
  const [row] = await tx
    .insert(facts)
    .values({
      geoObjectId: m.geoObjectId,
      attribute,
      value,
      mentionId: m.mentionId,
      quote: "Good holding in sand",
      quoteVerified: true,
      quoteChunkId: m.chunkId,
      quoteStart: 0,
      quoteEnd: 20,
      observedAt: "2026-10-19",
      confidence,
      extractionRunId,
      factSchemaVersion: config.factSchema.version,
    })
    .returning({ id: facts.id });
  return row!.id;
}

describe("model comparison", () => {
  it("a comparison run writes two extraction runs on the same units and leaves mention status alone", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const { versionIds } = await scene(tx, { sources: 2, types: ["trip_report", "pilot_guide"], perSource: 2 });
      const { id: comparisonId, units } = await createModelComparison(tx, { label: "pilot", createdBy: "test", cfg: config });
      expect(units).toBe(4);
      const rec = recordingBoss();
      const seen: Record<string, number> = { [MODEL_A]: 0, [MODEL_B]: 0 };
      const answer = (model: string, facts: (input: ExtractFactsInput) => ExtractedFact[]) =>
        new MockModel({ "extract-facts": (input) => (seen[model]!++, { facts: facts(input as ExtractFactsInput) }) }, { batchIdPrefix: `mock-${model}-${newId()}-` });
      const model = modelRouter({
        [MODEL_A]: answer(MODEL_A, () => [fact("holding", "good", "Good holding in sand")]),
        [MODEL_B]: answer(MODEL_B, () => [fact("holding", "moderate", "Good holding in sand"), fact("seabed", ["sand"], "holding in sand")]),
      });
      const { id: runId } = await startModelComparisonRun(tx, rec.boss, { comparisonId, triggeredBy: "test", now }, config);
      expect(await drive(tx, rec, model, runId, now)).toBe("finished");

      const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
      expect(run).toMatchObject({ stages: [...MODEL_COMPARISON_STAGES], params: expect.objectContaining({ comparisonId, models: [MODEL_A, MODEL_B] }) });
      const ers = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, runId)).orderBy(extractionRuns.model);
      expect(ers.map((e) => [e.model, e.purpose, e.status, e.comparisonId])).toEqual(
        [MODEL_A, MODEL_B].sort().map((m) => [m, "comparison", "finished", comparisonId]),
      );
      const unitsOf = async (id: string) =>
        (await tx.select().from(extractionUnits).where(eq(extractionUnits.extractionRunId, id))).map((u) => `${u.documentVersionId}:${u.geoObjectId}:${u.part}`).sort();
      expect(await unitsOf(ers[0]!.id)).toEqual(await unitsOf(ers[1]!.id));
      expect((await unitsOf(ers[0]!.id)).length).toBe(4);
      expect(seen).toEqual({ [MODEL_A]: 4, [MODEL_B]: 4 });
      // no mention was claimed: all still pending for the regular extraction
      const statuses = await tx.select({ s: mentions.extractionStatus }).from(mentions).where(inArray(mentions.documentVersionId, versionIds));
      expect(statuses.map((s) => s.s)).toEqual(["pending", "pending", "pending", "pending"]);

      const summary = await compareRuns(tx, comparisonId, config);
      expect(summary.runs.map((r) => [r.model, r.units, r.facts])).toEqual([
        [MODEL_A, 4, 4],
        [MODEL_B, 4, 8],
      ]);
      expect(summary.agreement).toEqual({ same: 0, deviation: 4, onlyA: 0, onlyB: 4, pct: 0 });
      // a second start is refused
      await expect(startModelComparisonRun(tx, rec.boss, { comparisonId, triggeredBy: "test", now }, config)).rejects.toMatchObject({ reason: "comparison_started" });

      // NOTE T19: while the decision is provisional no comparison run is active; once decided, the chosen model's is
      const [unit] = await tx.select().from(extractionUnits).where(eq(extractionUnits.extractionRunId, ers[0]!.id)).limit(1);
      const runOfModel = (m: string) => ers.find((e) => e.model === m)!.id;
      const decide = (m: string, status: "provisional" | "decided"): AppConfig => {
        const task = config.models.tasks["extract-facts"]!;
        return {
          ...config,
          models: { ...config.models, tasks: { ...config.models.tasks, "extract-facts": { ...task, model: m, promptVersion: ers[0]!.promptVersion, decision: { status, note: "test" } } } },
        };
      };
      expect(await activeExtractionRun(tx, unit!.documentVersionId, unit!.geoObjectId, decide(MODEL_A, "provisional"))).toBeNull();
      expect(await activeExtractionRun(tx, unit!.documentVersionId, unit!.geoObjectId, decide(MODEL_B, "decided"))).toEqual({ id: runOfModel(MODEL_B) });
      expect(await activeExtractionRun(tx, unit!.documentVersionId, unit!.geoObjectId, decide(MODEL_A, "decided"))).toEqual({ id: runOfModel(MODEL_A) });
    }));

  it("the sample spreads 200 units over doc types and sources", () =>
    withRollback(async (tx) => {
      const types: DocType[] = ["trip_report", "pilot_guide", "forum", "marina"];
      const { sourceIds } = await scene(tx, { sources: 10, types, perSource: 30 });
      const pick = await pickComparisonUnits(tx, config.extraction.comparison);
      expect(pick.units.length).toBe(200);
      const own = pick.units.filter((u) => sourceIds.includes(u.sourceId));
      expect(new Set(own.map((u) => u.sourceId)).size).toBe(10);
      expect(new Set(own.map((u) => u.docType))).toEqual(new Set(types));
      // round-robin over types: each type 50 of the 200
      for (const t of types) expect(own.filter((u) => u.docType === t).length).toBe(50);
      expect(pick.shortfall).toEqual([]);
      // stable: the same sample again
      expect((await pickComparisonUnits(tx, config.extraction.comparison)).units).toEqual(pick.units);
    }));

  it("fewer than 8 sources is reported as shortfall", () =>
    withRollback(async (tx) => {
      await scene(tx, { sources: 3, types: ["trip_report", "forum"], perSource: 2 });
      const pick = await pickComparisonUnits(tx, config.extraction.comparison);
      expect(pick.shortfall).toEqual(expect.arrayContaining(["units:6/200", "sources:3/8"]));
      const { id } = await createModelComparison(tx, { label: "few", createdBy: "test", cfg: config });
      const [row] = await tx.select().from(modelComparisons).where(eq(modelComparisons.id, id));
      expect(row!.shortfall).toEqual(pick.shortfall);
      // a document type of the candidates missing from the sample is named
      const units = pick.units.filter((u) => u.docType === "trip_report");
      expect(comparisonShortfall(units, ["trip_report", "forum"], { ...config.extraction.comparison, units: units.length, minSources: 1 })).toEqual([
        "doc_type:forum",
      ]);
    }));

  it("0.5 and 0.55 agree, 0.5 and 0.7 deviate, a fact of one model only counts as onlyA", () =>
    withRollback(async (tx) => {
      const { comparisonId, runA, runB } = await comparisonWithRuns(tx);
      const [m1, m2, m3] = [await insertTestMention(tx), await insertTestMention(tx), await insertTestMention(tx)];
      await insertFact(tx, m1, runA, "shelter.N", 0.5);
      await insertFact(tx, m1, runB, "shelter.N", 0.55);
      await insertFact(tx, m2, runA, "shelter.N", 0.5);
      await insertFact(tx, m2, runB, "shelter.N", 0.7);
      await insertFact(tx, m3, runA, "holding", "good");
      await insertFact(tx, m3, runA, "seabed", [{ type: "sand", share: 1 }], 0.9);
      await insertFact(tx, m3, runB, "seabed", [{ type: "sand", share: 1 }], 0.9);
      const summary = await compareRuns(tx, comparisonId, config);
      expect(summary.agreement).toEqual({ same: 2, deviation: 1, onlyA: 1, onlyB: 0, pct: 50 });
      expect(summary.runs.map((r) => [r.model, r.facts])).toEqual([
        [MODEL_A, 4],
        [MODEL_B, 3],
      ]);
      expect(valuesAgree(["anchor", "buoy"], ["buoy", "anchor"], 0.1)).toBe(true);
      expect(valuesAgree(["anchor"], ["anchor", "buoy"], 0.1)).toBe(false);
      expect(valuesAgree({ min: 5, max: 7 }, { max: 7.05, min: 5 }, 0.1)).toBe(true);
      expect(valuesAgree("good", "moderate", 0.1)).toBe(false);
    }));

  it("of a model's facts on one unit and attribute the most confident one counts", () =>
    withRollback(async (tx) => {
      const { comparisonId, runA, runB } = await comparisonWithRuns(tx);
      const m = await insertTestMention(tx);
      // a second mention of the same object in the same chunk: one unit, two facts of model A on "holding"
      const [second] = await tx
        .insert(mentions)
        .values({ documentVersionId: m.versionId, chunkId: m.chunkId, geoObjectId: m.geoObjectId, surface: "holding", charStart: 5, charEnd: 12, observedAt: "2026-10-19", confidence: 1, matchKind: "deterministic" })
        .returning({ id: mentions.id });
      await insertFact(tx, m, runA, "holding", "good", 0.6);
      await insertFact(tx, { ...m, mentionId: second!.id }, runA, "holding", "poor", 0.95);
      await insertFact(tx, m, runB, "holding", "poor", 0.7);
      expect((await compareRuns(tx, comparisonId, config)).agreement).toEqual({ same: 1, deviation: 0, onlyA: 0, onlyB: 0, pct: 100 });
    }));

  it("the deviation sample is stable and holds 50 items", () =>
    withRollback(async (tx) => {
      const { comparisonId, runA, runB } = await comparisonWithRuns(tx);
      for (let i = 0; i < 60; i++) {
        const m = await insertTestMention(tx);
        await insertFact(tx, m, runA, "holding", "good");
        if (i % 3 !== 0) await insertFact(tx, m, runB, "holding", "poor");
        if (i % 10 === 0) await insertFact(tx, m, runB, "quietness", "quiet");
      }
      const first = await deviationSample(tx, comparisonId, 50, config);
      expect(first).toHaveLength(50);
      expect(first.every((d) => d.a?.value !== d.b?.value)).toBe(true);
      expect(first.every((d) => d.verdict === null && (d.a !== null || d.b !== null))).toBe(true);
      expect(first.filter((d) => d.a && d.b).every((d) => d.a!.quote === "Good holding in sand" && d.a!.context !== null)).toBe(true);
      const again = await deviationSample(tx, comparisonId, 50, config);
      expect(again.map((d) => `${d.unitKey}|${d.attribute}`)).toEqual(first.map((d) => `${d.unitKey}|${d.attribute}`));
      // 60 + 6 keys, 0 the same: 66 deviations or one-sided, the first 50 by md5(unitKey || attribute)
      const all = await deviationSample(tx, comparisonId, 100, config);
      expect(all).toHaveLength(66);
      const md5 = (t: string) => createHash("md5").update(t).digest("hex");
      const byMd5 = [...all].sort((x, y) => md5(x.unitKey + x.attribute).localeCompare(md5(y.unitKey + y.attribute)));
      expect(first.map((d) => d.unitKey + d.attribute)).toEqual(byMd5.slice(0, 50).map((d) => d.unitKey + d.attribute));
    }));

  it("a rating is stored once per item and can be changed", () =>
    withRollback(async (tx) => {
      const { comparisonId, runA } = await comparisonWithRuns(tx);
      const m = await insertTestMention(tx);
      await insertFact(tx, m, runA, "holding", "good");
      const unitKey = unitKeyOf(m.versionId, m.geoObjectId);
      await rateDeviation(tx, { comparisonId, unitKey, attribute: "holding", verdict: "a_correct", by: "a@example.invalid" });
      const read = () => tx.select().from(modelComparisonRatings).where(and(eq(modelComparisonRatings.comparisonId, comparisonId)));
      const [before] = await read();
      await rateDeviation(tx, { comparisonId, unitKey, attribute: "holding", verdict: "unclear", by: "b@example.invalid" });
      const after = await read();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ unitKey, attribute: "holding", verdict: "unclear", ratedBy: "b@example.invalid" });
      expect(after[0]!.ratedAt.getTime()).toBeGreaterThan(before!.ratedAt.getTime());
      expect((await deviationSample(tx, comparisonId, 50, config))[0]!.verdict).toBe("unclear");
      const summary = await ratingSummary(tx, comparisonId);
      expect(summary.rated).toBe(1);
      expect(summary.shares.unclear).toBe(1);
      expect(summary.shares.a_correct).toBe(0);
    }));

  it("the cost estimate refuses above max-eur", () =>
    withRollback(async (tx) => {
      await scene(tx, { sources: 1, types: ["trip_report"], perSource: 1 });
      const { id } = await createModelComparison(tx, { label: "estimate", createdBy: "test", cfg: config });
      const estimate = await estimateComparisonCostEur(tx, id, config);
      // one unit: chunk characters / 4 + system tokens in, outputTokensPerUnit out, per model, batch discount
      const { systemTokens, outputTokensPerUnit } = config.extraction.comparison;
      const input = TEXT.length / 4 + systemTokens;
      const expected = [MODEL_A, MODEL_B].reduce((sum, model) => {
        const p = config.models.pricesEurPerMTok[model]!;
        return sum + ((input / 1e6) * p.input + (outputTokensPerUnit / 1e6) * p.output) * config.models.batch.discount;
      }, 0);
      expect(estimate).toBeCloseTo(expected, 4);
      const label = `too-dear-${newId()}`;
      await expect(createModelComparisonWithinBudget(tx, { label, createdBy: "test", maxEur: estimate / 2, cfg: config })).rejects.toBeInstanceOf(ComparisonTooExpensive);
      // the refused comparison left nothing behind
      expect(await tx.select().from(modelComparisons).where(eq(modelComparisons.label, label))).toEqual([]);
      const ok = await createModelComparisonWithinBudget(tx, { label, createdBy: "test", maxEur: estimate * 2, cfg: config });
      expect(ok).toMatchObject({ units: 1, sources: 1, docTypes: ["trip_report"], estimateEur: estimate });
    }));

  it("a comparison without units, unknown or above today's budget does not start", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      await scene(tx, { sources: 1, types: ["trip_report"], perSource: 1 });
      const { id } = await createModelComparison(tx, { label: "dear", createdBy: "test", cfg: config });
      const estimate = await estimateComparisonCostEur(tx, id, config);
      const poor: AppConfig = { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: estimate / 2 } } };
      const refused = await startModelComparisonRun(tx, recordingBoss().boss, { comparisonId: id, triggeredBy: "test", now }, poor).catch((e: unknown) => e);
      expect(refused).toMatchObject({ reason: "comparison_over_budget" });
      expect((await tx.select().from(modelComparisons).where(eq(modelComparisons.id, id)))[0]!.runId).toBeNull();
      const [row] = await tx.insert(modelComparisons).values({ label: "empty", models: [MODEL_A, MODEL_B], createdBy: "test" }).returning({ id: modelComparisons.id });
      const reason = (p: Promise<unknown>) => p.then(() => "started", (e: unknown) => (e instanceof RunScopeNotReady ? e.reason : String(e)));
      expect(await reason(startModelComparisonRun(tx, recordingBoss().boss, { comparisonId: row!.id, triggeredBy: "test" }))).toBe("comparison_without_units");
      expect(await reason(startModelComparisonRun(tx, recordingBoss().boss, { comparisonId: newId(), triggeredBy: "test" }))).toBe("unknown_comparison");
    }));
});
