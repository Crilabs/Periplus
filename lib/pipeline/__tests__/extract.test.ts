import { readFileSync } from "node:fs";
import { z } from "zod";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { quietDay } from "@/test/external-calls";
import { insertNamedObject, insertTestTile, insertTestVersion } from "@/test/text";
import { buildParams } from "@/lib/ai/anthropic";
import { MockBatchError, MockModel } from "@/lib/ai/mock";
import { extractFactsTask, type ExtractedFact, type ExtractFactsInput } from "@/lib/ai/tasks/extract-facts";
import { ZERO_USAGE } from "@/lib/ai/types";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiBatchItems, extractionRuns, extractionUnits, facts, mentions, type GeoObjectType } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun, endRun, recordJobOutcome } from "@/lib/domain/runs";
import { tileIdFor } from "@/lib/domain/tiles";
import { failBatchUnit, pollBatch, type BatchHandlerEntry } from "@/lib/pipeline/batches";
import {
  EXTRACT_STAGE,
  extractFactsBatchEntry,
  extractionRunStats,
  extractUnits,
  planExtraction,
  unitInput,
} from "@/lib/pipeline/text/extract";
import { matchVersion } from "@/lib/pipeline/text/mentions";

/*
 * Stage extraction.mention end to end inside withRollback: plan → job (message batch via MockModel) → poll (handler).
 */

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const HANDLERS: Record<string, BatchHandlerEntry> = { "extract-facts": extractFactsBatchEntry };
const DIR = join(process.cwd(), "test/fixtures/texts");

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

const TEXTS = [
  "## Kolona",
  "Kolona is a quiet bay. Holding is good in sand, depth 6 m.",
  "Ermioni, the town, has fuel. Kolona gets crowded in August.",
];

const holding: ExtractedFact = {
  attribute: "holding",
  value: '"good"',
  quote: "Holding is good in sand",
  chunk: 2,
  confidence: 0.9,
  observed_at: null,
  poi_name: null,
};

/** Pending deterministic mentions of the object at every occurrence of `surface` in the version's chunks. */
async function mentionAll(tx: Db, v: { versionId: string; chunkIds: string[] }, texts: string[], geoObjectId: string, surface: string) {
  for (const [i, text] of texts.entries()) {
    for (let at = text.indexOf(surface); at >= 0; at = text.indexOf(surface, at + 1)) {
      await tx.insert(mentions).values({
        documentVersionId: v.versionId,
        chunkId: v.chunkIds[i]!,
        geoObjectId,
        surface,
        charStart: at,
        charEnd: at + surface.length,
        observedAt: "2026-10-19",
        confidence: 1,
        matchKind: "deterministic",
      });
    }
  }
}

/** A bay Kolona and a town Ermioni (no place: skipped), mentioned in one version. */
async function scene(tx: Db) {
  const tile = await insertTestTile(tx, tileIdFor(21.0, 35.2));
  const named = (name: string, type: GeoObjectType, lon: number) => insertNamedObject(tx, { type, names: [{ name }], lon, lat: 35.2, tiles: [tile] });
  const kolona = await named("Kolona", "bay", 21.0);
  const ermioni = await named("Ermioni", "settlement", 21.05);
  const v = await insertTestVersion(tx, TEXTS);
  await mentionAll(tx, v, TEXTS, kolona, "Kolona");
  await mentionAll(tx, v, TEXTS, ermioni, "Ermioni");
  const ms = await tx.select().from(mentions).where(eq(mentions.documentVersionId, v.versionId));
  return { ...v, kolona, ermioni, mentions: ms };
}

async function startRun(tx: Db, params: Record<string, unknown>) {
  const { id } = await createRun(tx, {
    kind: "stage",
    scope: { type: "system", id: `extract-test-${newId()}` },
    stages: [EXTRACT_STAGE],
    params,
    triggeredBy: "test",
  });
  return id;
}

/** Plans the stage, sends every job and polls every batch; returns the jobs. */
async function runStage(tx: Db, model: MockModel, runId: string, now: Date, params: Record<string, unknown>) {
  const { boss } = recordingBoss();
  const jobs = await planExtraction(tx, { id: runId, params }, config);
  await beginStage(tx, runId, EXTRACT_STAGE, jobs.length);
  const deps = { model, boss, config, now: () => now, reservationScope: { runIds: [runId] } };
  for (const job of jobs) {
    await extractUnits(tx, deps, { runId, stage: EXTRACT_STAGE, key: job.key, extractionRunId: job.extractionRunId as string, unitIds: job.unitIds as string[] });
  }
  const batches = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId)).orderBy(aiBatches.id);
  for (const b of batches) await pollBatch(tx, { ...deps, handlers: HANDLERS }, b.id);
  return { jobs, deps, batches };
}

const statusOf = async (tx: Db, ids: string[]) =>
  (await tx.select({ id: mentions.id, s: mentions.extractionStatus }).from(mentions).where(inArray(mentions.id, ids))).map((r) => r.s);

describe("stage extraction.mention", () => {
  it("a run extracts every pending mention once and marks it done", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      const seen: ExtractFactsInput[] = [];
      const model = new MockModel({
        "extract-facts": (input) => {
          seen.push(input as ExtractFactsInput);
          return { facts: [holding] };
        },
      });
      const params = { documentVersionIds: [s.versionId] };
      const runId = await startRun(tx, params);
      const { jobs } = await runStage(tx, model, runId, now, params);
      expect(jobs).toHaveLength(1);
      const batches = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      expect(batches.map((b) => [b.model, b.status])).toEqual([["claude-sonnet-5-5", "distributed"]]);
      // one unit for Kolona (its three mentions, all three chunks), the town is skipped
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ level: "place", object: { name: "Kolona", type: "bay" }, docType: "trip_report", observedAt: "2026-10-19" });
      expect(seen[0]!.chunks.map((c) => c.n)).toEqual([1, 2, 3]);
      const kolona = s.mentions.filter((m) => m.geoObjectId === s.kolona).map((m) => m.id);
      expect(await statusOf(tx, kolona)).toEqual(["done", "done", "done"]);
      const [run] = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, runId));
      expect(run).toMatchObject({ task: "extract-facts", model: "claude-sonnet-5-5", promptVersion: 2, factSchemaVersion: "v2", purpose: "regular" });
      const units = await tx.select().from(extractionUnits).where(eq(extractionUnits.extractionRunId, run!.id));
      expect(units.map((u) => [u.geoObjectId, u.status, u.mentionIds.length])).toEqual([[s.kolona, "done", 3]]);
      expect(units[0]!.stats).toMatchObject({ proposed: 1, stored: 1 });
      const stored = await tx.select().from(facts).where(eq(facts.extractionRunId, run!.id));
      expect(stored.map((f) => [f.attribute, f.value, f.mentionId])).toEqual([["holding", "good", kolona.find((id) => s.mentions.find((m) => m.id === id)!.chunkId === s.chunkIds[1])]]);

      // a second run over the same version finds nothing pending: no extraction run, no units, no request
      const second = await startRun(tx, params);
      expect(await planExtraction(tx, { id: second, params }, config)).toEqual([]);
      expect(await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, second))).toHaveLength(0);
      expect(seen).toHaveLength(1);
    }));

  it("skipped mentions are marked skipped and cost nothing", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      const model = new MockModel(
        { "extract-facts": () => ({ facts: [] }) },
        { itemCost: { usage: { ...ZERO_USAGE, inputTokens: 1000, outputTokens: 200 }, costEur: 0.004 } },
      );
      const params = { documentVersionIds: [s.versionId] };
      const runId = await startRun(tx, params);
      const { batches } = await runStage(tx, model, runId, now, params);
      const town = s.mentions.filter((m) => m.geoObjectId === s.ermioni).map((m) => m.id);
      expect(town).toHaveLength(1);
      expect(await statusOf(tx, town)).toEqual(["skipped"]);
      const items = await tx.select().from(aiBatchItems).where(eq(aiBatchItems.batchId, batches[0]!.id));
      expect(items).toHaveLength(1);
      const [unit] = await tx.select().from(extractionUnits).where(eq(extractionUnits.id, items[0]!.subjectId));
      expect(unit!.geoObjectId).toBe(s.kolona);
      expect([unit!.inputTokens, unit!.outputTokens, Number(unit!.costEur)]).toEqual([1000, 200, 0.004]);
      // cost per mention counts only the three Kolona mentions sent to the model
      const [run] = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, runId));
      const stats = await extractionRunStats(tx, run!.id);
      expect([stats.costEur, stats.costPerMentionEur]).toEqual([0.004, 0.001333]);
    }));

  it("a retried extraction job does not duplicate units or facts", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      let calls = 0;
      const model = new MockModel({
        "extract-facts": () => {
          calls++;
          return { facts: [holding] };
        },
      });
      const params = { documentVersionIds: [s.versionId] };
      const runId = await startRun(tx, params);
      const { jobs, deps, batches } = await runStage(tx, model, runId, now, params);
      // the plan again (a repeated run.advance): same extraction run, no new units, nothing pending to plan
      expect(await planExtraction(tx, { id: runId, params }, config)).toEqual([]);
      // the job again (redelivered) reuses its batch; the poll again distributes nothing twice
      const job = { runId, stage: EXTRACT_STAGE, key: jobs[0]!.key, extractionRunId: jobs[0]!.extractionRunId as string, unitIds: jobs[0]!.unitIds as string[] };
      expect(await extractUnits(tx, deps, job)).toMatchObject({ reused: true });
      await pollBatch(tx, { ...deps, handlers: HANDLERS }, batches[0]!.id);
      // the handler itself, handed the item once more, leaves a done unit alone
      const [item] = await tx.select().from(aiBatchItems).where(eq(aiBatchItems.batchId, batches[0]!.id));
      await extractFactsBatchEntry.handle(
        tx,
        { ...item!, usage: { inputTokens: 1, outputTokens: 1 }, costEur: 9, batch: { id: batches[0]!.id, model: "m", promptVersion: 1, runId, stage: EXTRACT_STAGE } },
        { config },
      );
      expect(await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId))).toHaveLength(1);
      const [run] = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, runId));
      const units = await tx.select().from(extractionUnits).where(eq(extractionUnits.extractionRunId, run!.id));
      expect(units).toHaveLength(1);
      expect(units[0]!.costEur).toBe("0.000000");
      expect(await tx.select().from(facts).where(eq(facts.extractionRunId, run!.id))).toHaveLength(1);
      expect(calls).toBe(1);
    }));

  it("run stats sum facts, rejections and cost per mention", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const tile = await insertTestTile(tx, tileIdFor(21.0, 35.2));
      const kolona = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.0, lat: 35.2, tiles: [tile] });
      const limnionas = await insertNamedObject(tx, { type: "bay", names: [{ name: "Limnionas" }], lon: 21.02, lat: 35.2, tiles: [tile] });
      const texts = ["Kolona has good holding in sand.", "x", "y", "z", "Limnionas is quiet. Limnionas is small."];
      const v = await insertTestVersion(tx, texts);
      await mentionAll(tx, v, texts, kolona, "Kolona");
      await mentionAll(tx, v, texts, limnionas, "Limnionas");
      const model = new MockModel(
        {
          "extract-facts": (input) => {
            const i = input as ExtractFactsInput;
            if (i.object.name === "Kolona") {
              return {
                facts: [
                  { ...holding, quote: "Kolona has good holding in sand", chunk: 1 },
                  { ...holding, attribute: "seabed", value: '["sand"]', quote: "Kolona has excellent holding", chunk: 1 },
                ],
              };
            }
            return { facts: [{ ...holding, attribute: "quietness", value: '"quiet"', quote: "Limnionas is quiet.", chunk: 2 }, { ...holding, value: "good" }] };
          },
        },
        { itemCost: { usage: { ...ZERO_USAGE, inputTokens: 500, outputTokens: 100 }, costEur: 0.003 } },
      );
      const params = { documentVersionIds: [v.versionId] };
      const runId = await startRun(tx, params);
      await runStage(tx, model, runId, now, params);
      const [run] = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, runId));
      const stats = await extractionRunStats(tx, run!.id);
      expect(stats).toEqual({
        units: 2,
        done: 2,
        failed: 0,
        facts: 2,
        proposed: 4,
        stored: 2,
        rejectedQuote: 1,
        invalidValue: 1,
        unknownAttribute: 0,
        duplicate: 0,
        poiMentions: 0,
        poiUnmatched: 0,
        poiNameRejected: 0,
        overLimit: 0,
        costEur: 0.006,
        // three mentions (Kolona once, Limnionas twice) went to the model
        costPerMentionEur: 0.002,
      });
      const [written] = await tx.select({ stats: extractionRuns.stats }).from(extractionRuns).where(eq(extractionRuns.id, run!.id));
      expect(written!.stats).toEqual(stats);
    }));

  it("an item that fails for good marks its unit failed, the others are done", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const tile = await insertTestTile(tx, tileIdFor(21.0, 35.2));
      const kolona = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.0, lat: 35.2, tiles: [tile] });
      const limnionas = await insertNamedObject(tx, { type: "bay", names: [{ name: "Limnionas" }], lon: 21.02, lat: 35.2, tiles: [tile] });
      const texts = ["Kolona has good holding in sand.", "x", "y", "Limnionas is quiet in the evening."];
      const v = await insertTestVersion(tx, texts);
      await mentionAll(tx, v, texts, kolona, "Kolona");
      await mentionAll(tx, v, texts, limnionas, "Limnionas");
      const model = new MockModel({
        "extract-facts": (input) => {
          if ((input as ExtractFactsInput).object.name === "Limnionas") throw new MockBatchError("refused", false);
          return { facts: [] };
        },
      });
      const params = { documentVersionIds: [v.versionId] };
      const runId = await startRun(tx, params);
      await runStage(tx, model, runId, now, params);
      const [run] = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, runId));
      const stats = await extractionRunStats(tx, run!.id);
      expect([stats.units, stats.done, stats.failed]).toEqual([2, 1, 1]);
      // the failed unit's mentions are failed, not done (ruling M4-G-R3): only a reprocess extracts them again
      const byObject = await tx.select({ o: mentions.geoObjectId, s: mentions.extractionStatus }).from(mentions).where(eq(mentions.documentVersionId, v.versionId));
      expect(byObject.filter((m) => m.o === limnionas).map((m) => m.s)).toEqual(["failed"]);
      expect(byObject.filter((m) => m.o === kolona).map((m) => m.s)).toEqual(["done"]);
    }));

  it("a reprocess run extracts done mentions again into a new extraction run", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      const model = new MockModel({ "extract-facts": () => ({ facts: [holding] }) });
      const params = { documentVersionIds: [s.versionId] };
      const first = await startRun(tx, params);
      await runStage(tx, model, first, now, params);
      const again = { ...params, reprocess: true };
      const second = await startRun(tx, again);
      await runStage(tx, model, second, now, again);
      const runs = await tx.select().from(extractionRuns).where(inArray(extractionRuns.runId, [first, second]));
      expect(runs.map((r) => r.purpose).sort()).toEqual(["regular", "reprocess"]);
      for (const r of runs) expect(await tx.select().from(facts).where(eq(facts.extractionRunId, r.id))).toHaveLength(1);
      // the skipped town stays skipped
      expect(await statusOf(tx, s.mentions.filter((m) => m.geoObjectId === s.ermioni).map((m) => m.id))).toEqual(["skipped"]);
    }));

  it("the batch runs on the extraction run's model and prompt version, not on those configured when the job runs", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      // planned on opus with prompt v1; when the job runs, sonnet and prompt v2 are configured
      const opus: AppConfig = {
        ...config,
        models: {
          ...config.models,
          tasks: { ...config.models.tasks, "extract-facts": { ...config.models.tasks["extract-facts"]!, model: "claude-opus-5-5", promptVersion: 1 } },
        },
      };
      const params = { documentVersionIds: [s.versionId] };
      const runId = await startRun(tx, params);
      const [job] = await planExtraction(tx, { id: runId, params }, opus);
      await beginStage(tx, runId, EXTRACT_STAGE, 1);
      const { boss } = recordingBoss();
      const model = new MockModel({ "extract-facts": () => ({ facts: [] }) });
      await extractUnits(
        tx,
        { model, boss, config, now: () => now, reservationScope: { runIds: [runId] } },
        { runId, stage: EXTRACT_STAGE, key: job!.key, extractionRunId: job!.extractionRunId as string, unitIds: job!.unitIds as string[] },
      );
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      expect([batch!.model, batch!.promptVersion]).toEqual(["claude-opus-5-5", 1]);
      const [unit] = await tx.select().from(extractionUnits).where(eq(extractionUnits.id, (job!.unitIds as string[])[0]!));
      expect(unit!.status).toBe("submitted");
    }));

  it("the prompt carries the word scale and keeps unit data out of the system prompt", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const params = { documentVersionIds: [s.versionId] };
      const runId = await startRun(tx, params);
      const [job] = await planExtraction(tx, { id: runId, params }, config);
      const input = await unitInput(tx, (job!.unitIds as string[])[0]!);
      const taskConfig = config.models.tasks["extract-facts"]!;
      const params1 = buildParams(extractFactsTask, input, taskConfig, "claude-sonnet-5-5");
      const other = buildParams(extractFactsTask, { ...input, object: { name: "Other", type: "harbour", parents: [] }, chunks: [{ n: 1, text: "Other text." }] }, taskConfig, "claude-sonnet-5-5");
      const system = (params1.system as Array<{ text: string; cache_control?: unknown }>)[0]!;
      expect(system.cache_control).toEqual({ type: "ephemeral" });
      expect((other.system as Array<{ text: string }>)[0]!.text).toBe(system.text);
      expect(system.text).toContain("| good |");
      expect(system.text).toMatch(/\| poor \| [^|]+ \| 0\.1 \|/);
      // no attribute line describes the 0–1 number the model must not give
      for (const line of system.text.split("\n").filter((l) => /^(shelter\.|swell_protection|seabed) — /.test(l))) {
        expect(line).not.toMatch(/0 \(open\) to 1|, 0 to 1|area shares/);
      }
      const user = params1.messages[0]!.content as string;
      expect(user).toContain('<chunk n="2">\nKolona is a quiet bay.');
      expect(user).toContain("Object: Kolona (bay)");
    }));

  it("fixture documents yield the expected facts", () =>
    withRollback(async (tx) => {
      type Gazetteer = { tiles: string[]; objects: Array<{ key: string; type: GeoObjectType; names: Array<{ name: string; language: string }>; lon: number; lat: number; tiles: string[]; parent?: string }> };
      type Expected = { documents: Record<string, { facts: Array<[string, string, unknown, string]> }> };
      type Answers = { responses: Record<string, Record<string, ExtractedFact[]>> };
      const gazetteer = JSON.parse(readFileSync(join(DIR, "gazetteer.json"), "utf8")) as Gazetteer;
      const expected = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8")) as Expected;
      const answers = JSON.parse(readFileSync(join(DIR, "extract-facts.json"), "utf8")) as Answers;
      const texts = Object.fromEntries(Object.keys(expected.documents).map((f) => [f, readFileSync(join(DIR, f), "utf8")]));
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      for (const t of gazetteer.tiles) await insertTestTile(tx, t);
      const ids = new Map<string, string>();
      for (const o of gazetteer.objects) ids.set(o.key, await insertNamedObject(tx, { ...o, parentId: o.parent ? ids.get(o.parent)! : null }));
      const keyOf = new Map([...ids].map(([k, v]) => [v, k]));
      const model = new MockModel({
        "extract-facts": (input) => {
          const i = input as ExtractFactsInput;
          const file = Object.keys(texts).find((f) => texts[f]!.includes(i.chunks[0]!.text))!;
          return { facts: answers.responses[file]?.[i.object.name] ?? [] };
        },
      });
      for (const file of Object.keys(expected.documents)) {
        const v = await insertTestVersion(tx, texts[file]!.trim().split(/\n\s*\n/));
        await matchVersion(tx, v.versionId, { runId: null, cfg: config });
        const params = { documentVersionIds: [v.versionId] };
        const runId = await startRun(tx, params);
        await runStage(tx, model, runId, now, params);
        const [run] = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, runId));
        const rows = await tx.select().from(facts).where(eq(facts.extractionRunId, run!.id));
        const got = rows.map((f) => [keyOf.get(f.geoObjectId), f.attribute, f.value, f.quote]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        expect(got, file).toEqual(expected.documents[file]!.facts);
        // every stored quote is the located span of its chunk (modulo markup)
        for (const f of rows) expect(f.quoteVerified && f.quoteStart! < f.quoteEnd!).toBe(true);
        const stats = await extractionRunStats(tx, run!.id);
        expect(stats.facts, file).toBe(expected.documents[file]!.facts.length);
        expect(stats.rejectedQuote, file).toBe(file === "de-trip-report.md" ? 1 : 0);
        const open = await tx
          .select()
          .from(mentions)
          .where(and(eq(mentions.documentVersionId, v.versionId), eq(mentions.extractionStatus, "pending")));
        expect(open, file).toEqual([]);
      }
    }));
  it("the cost of a unit and its run counts every billed attempt, also a retried first one", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      let calls = 0;
      const model = new MockModel(
        {
          "extract-facts": () => {
            // the first answer is cut off at max_tokens: retryable, but billed
            if (calls++ === 0) throw new MockBatchError("max_tokens", true, { usage: { ...ZERO_USAGE, inputTokens: 800, outputTokens: 16000 }, costEur: 0.002 });
            return { facts: [holding] };
          },
        },
        { itemCost: { usage: { ...ZERO_USAGE, inputTokens: 1000, outputTokens: 200 }, costEur: 0.003 } },
      );
      const params = { documentVersionIds: [s.versionId] };
      const runId = await startRun(tx, params);
      const { deps } = await runStage(tx, model, runId, now, params);
      const all = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId)).orderBy(aiBatches.id);
      expect(all.map((b) => b.status)).toEqual(["distributed", "submitted"]);
      await pollBatch(tx, { ...deps, handlers: HANDLERS }, all[1]!.id);
      const [run] = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, runId));
      const [unit] = await tx.select().from(extractionUnits).where(eq(extractionUnits.extractionRunId, run!.id));
      expect([unit!.status, unit!.inputTokens, unit!.outputTokens, Number(unit!.costEur)]).toEqual(["done", 1800, 16200, 0.005]);
      const stats = await extractionRunStats(tx, run!.id);
      expect([stats.costEur, stats.costPerMentionEur]).toEqual([0.005, 0.001667]);
    }));

  it("what the provider billed for an expired batch counts for its run", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      const model = new MockModel(
        { "extract-facts": () => ({ facts: [holding] }) },
        { batchRounds: 1, itemCost: { usage: { ...ZERO_USAGE, inputTokens: 1000, outputTokens: 200 }, costEur: 0.004 } },
      );
      const params = { documentVersionIds: [s.versionId] };
      const runId = await startRun(tx, params);
      const { boss } = recordingBoss();
      const [job] = await planExtraction(tx, { id: runId, params }, config);
      await beginStage(tx, runId, EXTRACT_STAGE, 1);
      const deps = { model, boss, config, now: () => now, reservationScope: { runIds: [runId] } };
      await extractUnits(tx, deps, { runId, stage: EXTRACT_STAGE, key: job!.key, extractionRunId: job!.extractionRunId as string, unitIds: job!.unitIds as string[] });
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      // still running past maxHours: the batch expires and its unit fails, then the booking poll books what it billed
      const late = new Date(now.getTime() + (config.models.batch.maxHours + 1) * 3_600_000);
      const lateDeps = { ...deps, now: () => late, handlers: HANDLERS };
      expect(await pollBatch(tx, lateDeps, batch!.id)).toBe("failed");
      await pollBatch(tx, lateDeps, batch!.id, { mode: "book" });
      const [item] = await tx.select().from(aiBatchItems).where(eq(aiBatchItems.batchId, batch!.id));
      expect([item!.status, Number(item!.costEur)]).toEqual(["failed", 0.004]);
      const stats = await extractionRunStats(tx, job!.extractionRunId as string);
      expect([stats.failed, stats.costEur]).toEqual([1, 0.004]);
      const kolona = s.mentions.filter((m) => m.geoObjectId === s.kolona).map((m) => m.id);
      expect(await statusOf(tx, kolona)).toEqual(["failed", "failed", "failed"]);
    }));

  it("a batch of a run an admin ended fails its units with what they were billed", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      const model = new MockModel(
        { "extract-facts": () => ({ facts: [holding] }) },
        { itemCost: { usage: { ...ZERO_USAGE, inputTokens: 1000, outputTokens: 200 }, costEur: 0.004 } },
      );
      const params = { documentVersionIds: [s.versionId] };
      const runId = await startRun(tx, params);
      const { boss } = recordingBoss();
      const [job] = await planExtraction(tx, { id: runId, params }, config);
      await beginStage(tx, runId, EXTRACT_STAGE, 1);
      const deps = { model, boss, config, now: () => now, reservationScope: { runIds: [runId] } };
      await extractUnits(tx, deps, { runId, stage: EXTRACT_STAGE, key: job!.key, extractionRunId: job!.extractionRunId as string, unitIds: job!.unitIds as string[] });
      expect(await endRun(tx, runId, "admin")).toBe(true);
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      expect(await pollBatch(tx, { ...deps, handlers: HANDLERS }, batch!.id)).toBe("failed");
      const [unit] = await tx.select().from(extractionUnits).where(eq(extractionUnits.extractionRunId, job!.extractionRunId as string));
      expect([unit!.status, Number(unit!.costEur)]).toEqual(["failed", 0.004]);
      expect(await tx.select().from(facts).where(eq(facts.extractionRunId, job!.extractionRunId as string))).toHaveLength(0);
      const kolona = s.mentions.filter((m) => m.geoObjectId === s.kolona).map((m) => m.id);
      expect(await statusOf(tx, kolona)).toEqual(["failed", "failed", "failed"]);
    }));

  it("a dead-lettered poll fails its units; a manual retry still completes them", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      const model = new MockModel({ "extract-facts": () => ({ facts: [holding] }) });
      const params = { documentVersionIds: [s.versionId] };
      const runId = await startRun(tx, params);
      const { boss } = recordingBoss();
      const [job] = await planExtraction(tx, { id: runId, params }, config);
      await beginStage(tx, runId, EXTRACT_STAGE, 1);
      const deps = { model, boss, config, now: () => now, reservationScope: { runIds: [runId] } };
      await extractUnits(tx, deps, { runId, stage: EXTRACT_STAGE, key: job!.key, extractionRunId: job!.extractionRunId as string, unitIds: job!.unitIds as string[] });
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      const unitStatus = async () => (await tx.select().from(extractionUnits).where(eq(extractionUnits.extractionRunId, job!.extractionRunId as string)))[0]!.status;
      const kolona = s.mentions.filter((m) => m.geoObjectId === s.kolona).map((m) => m.id);
      // the dead-letter branch gets the handler table from the worker's composition root
      expect(await failBatchUnit(tx, boss, batch!.id, HANDLERS)).toBe(true);
      expect(await unitStatus()).toBe("failed");
      expect(await statusOf(tx, kolona)).toEqual(["failed", "failed", "failed"]);
      // a manual retry of the poll revives the batch and distributes it: the unit and its mentions are done after all
      expect(await pollBatch(tx, { ...deps, handlers: HANDLERS }, batch!.id)).toBe("distributed");
      expect(await unitStatus()).toBe("done");
      expect(await statusOf(tx, kolona)).toEqual(["done", "done", "done"]);
    }));

  it("units still open when the stage finishes fail with their mentions", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const tile = await insertTestTile(tx, tileIdFor(21.0, 35.2));
      const kolona = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.0, lat: 35.2, tiles: [tile] });
      const limnionas = await insertNamedObject(tx, { type: "bay", names: [{ name: "Limnionas" }], lon: 21.02, lat: 35.2, tiles: [tile] });
      const texts = ["Kolona has good holding in sand.", "x", "y", "Limnionas is quiet in the evening."];
      const v = await insertTestVersion(tx, texts);
      await mentionAll(tx, v, texts, kolona, "Kolona");
      await mentionAll(tx, v, texts, limnionas, "Limnionas");
      const model = new MockModel({ "extract-facts": () => ({ facts: [] }) });
      const params = { documentVersionIds: [v.versionId] };
      const runId = await startRun(tx, params);
      const { boss } = recordingBoss();
      const [job] = await planExtraction(tx, { id: runId, params }, config);
      const units = await tx.select().from(extractionUnits).where(eq(extractionUnits.extractionRunId, job!.extractionRunId as string));
      const lost = units.find((u) => u.geoObjectId === limnionas)!;
      // its input cannot be built (a chunk is gone): the job leaves it out of its batch, it stays pending
      await tx.update(extractionUnits).set({ chunkIds: [newId()] }).where(eq(extractionUnits.id, lost.id));
      await beginStage(tx, runId, EXTRACT_STAGE, 1);
      const deps = { model, boss, config, now: () => now, reservationScope: { runIds: [runId] } };
      await extractUnits(tx, deps, { runId, stage: EXTRACT_STAGE, key: job!.key, extractionRunId: job!.extractionRunId as string, unitIds: job!.unitIds as string[] });
      await recordJobOutcome(tx, runId, EXTRACT_STAGE, job!.key, "done");
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      await pollBatch(tx, { ...deps, handlers: HANDLERS }, batch!.id);
      const after = await tx.select().from(extractionUnits).where(eq(extractionUnits.extractionRunId, job!.extractionRunId as string));
      expect(Object.fromEntries(after.map((u) => [u.geoObjectId, u.status]))).toEqual({ [kolona]: "done", [limnionas]: "failed" });
      expect(await statusOf(tx, lost.mentionIds)).toEqual(["failed"]);
    }));

  it("an answer that does not fit the output schema fails only its own unit", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const tile = await insertTestTile(tx, tileIdFor(21.0, 35.2));
      const kolona = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.0, lat: 35.2, tiles: [tile] });
      const limnionas = await insertNamedObject(tx, { type: "bay", names: [{ name: "Limnionas" }], lon: 21.02, lat: 35.2, tiles: [tile] });
      const texts = ["Kolona has good holding in sand.", "x", "y", "Limnionas is quiet in the evening."];
      const v = await insertTestVersion(tx, texts);
      await mentionAll(tx, v, texts, kolona, "Kolona");
      await mentionAll(tx, v, texts, limnionas, "Limnionas");
      const model = new MockModel({
        "extract-facts": (input) =>
          (input as ExtractFactsInput).object.name === "Limnionas"
            ? { facts: "none" }
            : { facts: [{ ...holding, quote: "Kolona has good holding in sand", chunk: 1 }] },
      });
      // collected without the schema check, so the stored output reaches the handler as it came
      const loose: Record<string, BatchHandlerEntry> = {
        "extract-facts": { ...extractFactsBatchEntry, task: { ...extractFactsBatchEntry.task, output: z.unknown() } },
      };
      const params = { documentVersionIds: [v.versionId] };
      const runId = await startRun(tx, params);
      const { boss } = recordingBoss();
      const [job] = await planExtraction(tx, { id: runId, params }, config);
      await beginStage(tx, runId, EXTRACT_STAGE, 1);
      const deps = { model, boss, config, now: () => now, reservationScope: { runIds: [runId] } };
      await extractUnits(tx, deps, { runId, stage: EXTRACT_STAGE, key: job!.key, extractionRunId: job!.extractionRunId as string, unitIds: job!.unitIds as string[] });
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      expect(await pollBatch(tx, { ...deps, handlers: loose }, batch!.id)).toBe("distributed");
      const units = await tx.select().from(extractionUnits).where(eq(extractionUnits.extractionRunId, job!.extractionRunId as string));
      expect(Object.fromEntries(units.map((u) => [u.geoObjectId, u.status]))).toEqual({ [kolona]: "done", [limnionas]: "failed" });
      expect(await tx.select().from(facts).where(eq(facts.extractionRunId, job!.extractionRunId as string))).toHaveLength(1);
      const items = await tx.select().from(aiBatchItems).where(eq(aiBatchItems.batchId, batch!.id));
      expect(items.every((i) => i.distributedAt !== null && i.distributionError === null)).toBe(true);
    }));

  it("the prompt takes the fact limit from config and the attributes from the extraction run's schema version", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const params = { documentVersionIds: [s.versionId] };
      const runId = await startRun(tx, params);
      const [job] = await planExtraction(tx, { id: runId, params }, config);
      const unitId = (job!.unitIds as string[])[0]!;
      const seven: AppConfig = { ...config, extraction: { ...config.extraction, maxFactsPerUnit: 7 } };
      const taskConfig = config.models.tasks["extract-facts"]!;
      const systemOf = async () => {
        const p = buildParams(extractFactsTask, await unitInput(tx, unitId, seven), taskConfig, "claude-sonnet-5-5");
        return (p.system as Array<{ text: string }>)[0]!.text;
      };
      const v2 = await systemOf();
      expect(v2).toContain("At most 7 facts.");
      expect(v2).not.toContain("At most 40");
      expect(v2).toMatch(/^holding — /m);
      // the rules of ruling M4-G-R4: names in the quote, no sector from a wind name, depths as stated
      expect(v2).toContain("must appear in the fact's quote");
      expect(v2).toContain("never turn it into a `shelter.<sector>` value");
      expect(v2).toMatch(/^depth\.anchoring_min — Minimum depth in the anchor area, metres as stated in the text — /m);
      expect(v2).toMatch(/^depth\.approach — [^\n]*only when the text gives these numbers explicitly/m);
      expect(v2).not.toContain("below LAT");
      // an extraction run planned on v1 keeps v1's attribute list, whatever is active now
      await tx.update(extractionRuns).set({ factSchemaVersion: "v1" }).where(eq(extractionRuns.id, job!.extractionRunId as string));
      expect(await systemOf()).not.toMatch(/^holding — /m);
    }));
});
