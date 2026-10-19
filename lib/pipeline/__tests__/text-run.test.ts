import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { quietDay } from "@/test/external-calls";
import { memoryArchive } from "@/test/s3";
import { insertNamedObject, insertTestSource, insertTestTile, insertTestVersion } from "@/test/text";
import type { Transport } from "@/lib/adapters/http";
import { MockModel } from "@/lib/ai/mock";
import type { ClassifyDocumentInput } from "@/lib/ai/tasks/classify-document";
import type { ExtractedFact, ExtractFactsInput } from "@/lib/ai/tasks/extract-facts";
import type { ExtractRouteInput } from "@/lib/ai/tasks/extract-route";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import {
  aiBatches,
  ambiguousMatches,
  documentVersions,
  extractionRuns,
  extractionUnits,
  facts,
  mentions,
  routes,
  runs,
  serpQueries,
  serpResults,
  sources,
  type GeoObjectType,
} from "@/lib/db/schema";
import { activeExtractionRun } from "@/lib/domain/extraction/active-run";
import { belegtreue } from "@/lib/domain/extraction/fidelity";
import { newId } from "@/lib/domain/ids";
import { recordJobOutcome } from "@/lib/domain/runs";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { enqueueRunAdvance } from "@/lib/jobs/enqueue";
import { BATCH_POLL_QUEUE, RUN_ADVANCE_QUEUE } from "@/lib/jobs/queues";
import type { JobData } from "@/lib/jobs/worker";
import { pollBatch, type BatchDeps, type PollOptions } from "@/lib/pipeline/batches";
import { enqueueStage } from "@/lib/pipeline/runs";
import { CHECK_QUEUE, checkExtractionRun, recheckBlockedExtractionRun } from "@/lib/pipeline/text/check";
import { CLASSIFY_QUEUE, classifyVersions } from "@/lib/pipeline/text/classify";
import { DISAMBIGUATE_QUEUE, DISAMBIGUATE_STAGE, disambiguateMatches } from "@/lib/pipeline/text/disambiguate";
import { EXTRACT_QUEUE, extractUnits } from "@/lib/pipeline/text/extract";
import { GEOCODE_QUEUE, geocodeCandidate } from "@/lib/pipeline/text/geocode";
import { MENTIONS_QUEUE, matchVersion, matchVersions } from "@/lib/pipeline/text/mentions";
import { ROUTE_QUEUE, extractRoutes } from "@/lib/pipeline/text/routes";
import { startReprocessRun, startTextRun, TEXT_RUN_STAGES } from "@/lib/pipeline/text/run";
import { freezeTextRunParams } from "@/lib/pipeline/text/versions";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";

/*
 * Text runs end to end inside withRollback: the run starters, then every job the run enqueues is executed in order by
 * calling the stage functions directly (no pg-boss worker), message batches through MockModel and `pollBatch` right
 * after each batch stage job. Geo data is the synthetic fixture gazetteer around 21.0° E / 35.2° N.
 */

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const DIR = join(process.cwd(), "test/fixtures/texts");
const FILES = ["de-trip-report.md", "en-pilot-guide.md", "el-forum.md"] as const;
const DOC_TYPES = { "de-trip-report.md": "trip_report", "en-pilot-guide.md": "pilot_guide", "el-forum.md": "forum" } as const;
const TILE_A = "q025:804:500";

type Gazetteer = {
  tiles: string[];
  objects: Array<{ key: string; type: GeoObjectType; names: Array<{ name: string; language: string }>; lon: number; lat: number; tiles: string[]; parent?: string }>;
};
type Answers = { responses: Record<string, Record<string, ExtractedFact[]>> };

const gazetteer = JSON.parse(readFileSync(join(DIR, "gazetteer.json"), "utf8")) as Gazetteer;
const answers = JSON.parse(readFileSync(join(DIR, "extract-facts.json"), "utf8")) as Answers;
const texts = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(DIR, f), "utf8").trim()])) as Record<(typeof FILES)[number], string>;
const fileOf = (text: string) => FILES.find((f) => texts[f].includes(text.trim().slice(0, 40)));

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

/** A route stop for the first sentence of a section naming Kolona (a verbatim quote), else none. */
function routeAnswer(input: ExtractRouteInput) {
  const sentence = input.text.split(/(?<=\.)\s+/).find((s) => s.includes("Kolona"));
  return { stops: sentence ? [{ name: "Kolona", date: null, mooring: "anchor", quote: sentence.replace(/\.$/, ""), leg: null }] : [] };
}

/** Every model task of a text run, answered from the fixtures; `seen` collects the extraction inputs. */
function fixtureModel(seen: { extract: ExtractFactsInput[]; disambiguate: number; route: number } = { extract: [], disambiguate: 0, route: 0 }) {
  const model = new MockModel({
    "classify-document": (input) => {
      const file = fileOf((input as ClassifyDocumentInput).text.split("\n").find((l) => l.length > 40) ?? "");
      return {
        doc_type: file ? DOC_TYPES[file] : "trip_report",
        languages: [],
        published_at: null,
        observed_at: null,
        observed_at_explicit: false,
        observed_at_reason: null,
        areas: [],
      };
    },
    "disambiguate-mention": () => {
      seen.disambiguate++;
      return { choice: 1, confidence: 0.9 };
    },
    "extract-facts": (input) => {
      const i = input as ExtractFactsInput;
      seen.extract.push(i);
      const file = fileOf(i.chunks[0]!.text);
      return { facts: (file && answers.responses[file]?.[i.object.name]) ?? [] };
    },
    "extract-route": (input) => {
      seen.route++;
      return routeAnswer(input as ExtractRouteInput);
    },
  }, { batchIdPrefix: `mock-${newId()}-` });
  return { model, seen };
}

/** The tile with the island Kalonisi: a text naming the island has the tile in its candidate space (prepass). */
async function islandTile(tx: Db): Promise<{ tile: string; island: string }> {
  const tile = await insertTestTile(tx, TILE_A);
  const island = await insertNamedObject(tx, { type: "island", names: [{ name: "Kalonisi" }], lon: 21.12, lat: 35.12, tiles: [tile] });
  return { tile, island };
}

const noNetwork: Transport = async () => {
  throw new Error("no network in tests");
};

/**
 * Executes every job the run enqueued, in order, like the worker would: stage jobs call their stage function and then
 * record their outcome (enqueueing `run.advance` when it finishes the stage), `run.advance` plans the next stage, and
 * `ai.batch.poll` polls the batch (which records the batch unit's outcome). Returns the run's status.
 */
async function drive(tx: Db, rec: ReturnType<typeof recordingBoss>, model: MockModel, runId: string, now: Date, opts: { failQueue?: string } = {}) {
  const archive = archiveOf.get(tx);
  const deps: BatchDeps = { model, boss: rec.boss, config, now: () => now, reservationScope: { runIds: [runId] } };
  type Job = JobData & { runId: string; stage: string; key: string };
  const stageJobs: Record<string, (job: Job) => Promise<unknown>> = {
    [CLASSIFY_QUEUE]: (job) => classifyVersions(tx, { ...deps, archive: archive! }, job as Job & { documentVersionIds: string[] }),
    [MENTIONS_QUEUE]: (job) => matchVersions(tx, job as Job & { versionIds: string[] }, config),
    [DISAMBIGUATE_QUEUE]: (job) => disambiguateMatches(tx, deps, job as Job & { ambiguousIds: string[] }),
    [GEOCODE_QUEUE]: (job) => geocodeCandidate(tx, job.candidateId as string, { transport: noNetwork }, { runId: job.runId, cfg: config }),
    [EXTRACT_QUEUE]: (job) => extractUnits(tx, deps, job as Job & { extractionRunId: string; unitIds: string[] }),
    [ROUTE_QUEUE]: (job) => extractRoutes(tx, { ...deps, archive: archive! }, job as Parameters<typeof extractRoutes>[2]),
    [CHECK_QUEUE]: (job) => checkExtractionRun(tx, job.extractionRunId as string, config),
  };
  for (let i = 0; i < rec.inserted.length; i++) {
    const { queue, data } = rec.inserted[i]!;
    if (queue === RUN_ADVANCE_QUEUE) {
      await enqueueStage(tx, rec.boss, String(data.runId), String(data.nextStage));
    } else if (queue === BATCH_POLL_QUEUE) {
      await pollBatch(tx, { ...deps, handlers: BATCH_HANDLERS }, String(data.batchId), { n: data.n, mode: data.mode } as PollOptions);
    } else {
      const job = data as Job;
      const run = stageJobs[queue];
      if (!run) throw new Error(`no driver for queue ${queue}`);
      // A job of `failQueue` dead-letters before doing anything (e.g. a transient provider or S3 error).
      const failed = queue === opts.failQueue;
      if (!failed) await run(job);
      const result = await recordJobOutcome(tx, job.runId, job.stage, job.key, failed ? "failed" : "done");
      if (result.nextStage) await enqueueRunAdvance(rec.boss, job.runId, result.nextStage, tx);
    }
  }
  const [row] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
  return row!.status;
}

/** The memory archive of a test transaction (the classification and route stages read the Markdown from it). */
const archiveOf = new Map<Db, ReturnType<typeof memoryArchive>>();

/** The fixture gazetteer and the three fixture documents (archived Markdown), each from its own source. */
async function fixtureScene(tx: Db) {
  const archive = memoryArchive();
  archiveOf.set(tx, archive);
  for (const t of gazetteer.tiles) await insertTestTile(tx, t);
  const ids = new Map<string, string>();
  for (const o of gazetteer.objects) ids.set(o.key, await insertNamedObject(tx, { ...o, parentId: o.parent ? ids.get(o.parent)! : null }));
  const versions: Record<string, string> = {};
  for (const file of FILES) {
    const v = await insertTestVersion(tx, texts[file].split(/\n\s*\n/));
    const [row] = await tx.select({ mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, v.versionId));
    await archive.put(row!.mdKey, texts[file], "text/markdown");
    versions[file] = v.versionId;
  }
  return { ids, versions, versionIds: Object.values(versions) };
}

const factsOf = (tx: Db, extractionRunIds: string[]) =>
  extractionRunIds.length === 0 ? Promise.resolve([]) : tx.select().from(facts).where(inArray(facts.extractionRunId, extractionRunIds)).orderBy(facts.id);
const extractionRunsOf = (tx: Db, runId: string) => tx.select().from(extractionRuns).where(eq(extractionRuns.runId, runId)).orderBy(extractionRuns.task);

/** A full text run over the fixture documents; returns the run and the scene. */
async function fullRun(tx: Db) {
  const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
  const scene = await fixtureScene(tx);
  const rec = recordingBoss();
  const { model, seen } = fixtureModel();
  const { id: runId } = await startTextRun(tx, rec.boss, { documentVersionIds: scene.versionIds, triggeredBy: "test" }, config);
  const status = await drive(tx, rec, model, runId, now);
  return { ...scene, runId, status, seen, now };
}

describe("text run", () => {
  it("pending selects only versions without a mention pass", () =>
    withRollback(async (tx) => {
      await islandTile(tx);
      const matched = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      const fresh = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      await matchVersion(tx, matched.versionId, { runId: null, cfg: config });
      const { documentVersionIds } = await freezeTextRunParams(tx, { pending: true }, config);
      expect(documentVersionIds).toContain(fresh.versionId);
      expect(documentVersionIds).not.toContain(matched.versionId);
      // another match configuration has not passed the matched version
      const other: AppConfig = { ...config, mentions: { ...config.mentions, maxCandidates: config.mentions.maxCandidates + 1 } };
      expect((await freezeTextRunParams(tx, { pending: true }, other)).documentVersionIds).toContain(matched.versionId);
      // an older version of a document is never pending, only its current one
      const newer = await insertTestVersion(tx, ["Rund um Kalonisi."], { documentId: fresh.documentId, fetchedAt: new Date("2026-10-20T10:00:00Z") });
      const again = await freezeTextRunParams(tx, { pending: true }, config);
      expect(again.documentVersionIds).toContain(newer.versionId);
      expect(again.documentVersionIds).not.toContain(fresh.versionId);
    }));

  it("a tile run takes the versions mentioning its objects plus the pending versions of its sources; a reprocess run no pending ones", () =>
    withRollback(async (tx) => {
      const { tile } = await islandTile(tx);
      const mentioned = await insertTestVersion(tx, ["Rund um Kalonisi."]);
      await matchVersion(tx, mentioned.versionId, { runId: null, cfg: config });
      // a source a SERP search of the tile found, with a version not matched yet; another source without such a search
      const found = await insertTestSource(tx);
      const elsewhere = await insertTestSource(tx);
      const pendingHere = await insertTestVersion(tx, ["Noch nicht abgeglichen."], { sourceId: found });
      const pendingElsewhere = await insertTestVersion(tx, ["Noch nicht abgeglichen."], { sourceId: elsewhere });
      const [src] = await tx.select({ domain: sources.domain }).from(sources).where(eq(sources.id, found));
      const domain = src!.domain;
      const [q] = await tx
        .insert(serpQueries)
        .values({ keyword: `k-${newId()}`, languageCode: "de", locationCode: 2300, depth: 20, level: "tile", scopeId: tile, rawKey: `serp/x/${newId()}.json`, fetchedAt: new Date() })
        .returning({ id: serpQueries.id });
      await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url: `https://${domain}/`, urlNormalized: `https://${domain}/`, domain, title: "t", snippet: "s" });

      const tileRun = (await freezeTextRunParams(tx, { tileId: tile }, config)).documentVersionIds;
      expect(tileRun).toEqual(expect.arrayContaining([mentioned.versionId, pendingHere.versionId]));
      expect(tileRun).not.toContain(pendingElsewhere.versionId);
      const reprocess = (await freezeTextRunParams(tx, { tileId: tile, reprocess: true }, config)).documentVersionIds;
      expect(reprocess).toContain(mentioned.versionId);
      expect(reprocess).not.toContain(pendingHere.versionId);
    }));

  it("the starters refuse an unknown tile, an area without tiles and versions that are not current", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      const v = await insertTestVersion(tx, ["Alt."]);
      await insertTestVersion(tx, ["Neu."], { documentId: v.documentId });
      const reason = (p: Promise<unknown>) => p.then(() => "started", (e: unknown) => (e instanceof RunScopeNotReady ? e.reason : String(e)));
      expect(await reason(startTextRun(tx, boss, { tileId: "q025:1:1", triggeredBy: "test" }, config))).toBe("unknown_tile");
      expect(await reason(startTextRun(tx, boss, { areaKey: `nope-${newId()}`, triggeredBy: "test" }, config))).toBe("unknown_area");
      const empty: AppConfig = { ...config, areas: [...config.areas, { ...config.areas[0]!, key: `empty-${newId()}` }] };
      expect(await reason(startReprocessRun(tx, boss, { scope: { areaKey: empty.areas.at(-1)!.key }, triggeredBy: "test" }, empty))).toBe("area_without_tiles");
      expect(await reason(startTextRun(tx, boss, { documentVersionIds: [v.versionId], rematch: true, triggeredBy: "test" }, config))).toBe("versions_not_current");
      expect(await reason(startTextRun(tx, boss, { documentVersionIds: [newId()], triggeredBy: "test" }, config))).toBe("versions_not_current");
      // a pending run with nothing to do still starts
      expect(await reason(startTextRun(tx, boss, { pending: true, triggeredBy: "test" }, config))).toBe("started");
    }));

  it("a full text run over the fixture documents ends finished with belegtreue 1", () =>
    withRollback(async (tx) => {
      const r = await fullRun(tx);
      expect(r.status).toBe("finished");
      const [run] = await tx.select().from(runs).where(eq(runs.id, r.runId));
      expect(run).toMatchObject({ kind: "stage", scopeType: "system", scopeId: "texts", stages: [...TEXT_RUN_STAGES] });
      const ers = await extractionRunsOf(tx, r.runId);
      expect(ers.map((e) => [e.task, e.status, e.purpose])).toEqual([
        ["extract-facts", "finished", "regular"],
        ["extract-route", "finished", "regular"],
      ]);
      const fidelity = await belegtreue(tx, r.runId);
      expect(fidelity.facts).toBeGreaterThan(0);
      expect(fidelity.ratio).toBe(1);
      expect(fidelity.verified).toBe(fidelity.facts);
      // every stage ran: the ambiguous spans went to the model, the trip report got its route
      expect(r.seen.disambiguate).toBeGreaterThan(0);
      expect(await tx.select().from(ambiguousMatches).where(and(inArray(ambiguousMatches.documentVersionId, r.versionIds), eq(ambiguousMatches.status, "pending")))).toEqual([]);
      const routed = await tx.select({ v: routes.documentVersionId }).from(routes).where(inArray(routes.extractionRunId, ers.map((e) => e.id)));
      expect(routed.map((x) => x.v)).toEqual([r.versions["de-trip-report.md"]]);
      const stored = await factsOf(tx, ers.map((e) => e.id));
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.every((f) => f.quoteVerified)).toBe(true);
      // no mention is left pending
      const left = await tx.select().from(mentions).where(and(inArray(mentions.documentVersionId, r.versionIds), eq(mentions.extractionStatus, "pending")));
      expect(left).toEqual([]);
    }));

  it("a run whose route stage fails completely blocks its unchecked extraction runs; the recheck finishes them", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const scene = await fixtureScene(tx);
      const rec = recordingBoss();
      const { model } = fixtureModel();
      const { id: runId } = await startTextRun(tx, rec.boss, { documentVersionIds: scene.versionIds, triggeredBy: "test" }, config);
      expect(await drive(tx, rec, model, runId, now, { failQueue: ROUTE_QUEUE })).toBe("failed");
      // the check stage never ran: the paid fact extraction is blocked, not left running for ever
      const ers = await extractionRunsOf(tx, runId);
      const factsRun = ers.find((e) => e.task === "extract-facts")!;
      expect(factsRun).toMatchObject({ status: "blocked", blockedReason: "run_failed", quoteCheck: null });
      expect(ers.every((e) => e.status === "blocked" && e.blockedReason === "run_failed")).toBe(true);
      const unit = (await tx.select().from(extractionUnits).where(eq(extractionUnits.extractionRunId, factsRun.id)))[0]!;
      expect(await activeExtractionRun(tx, unit.documentVersionId, unit.geoObjectId, config)).toBeNull();
      // "Belegtreue neu prüfen" finishes it, as its quotes hold up, and it becomes active
      expect(await recheckBlockedExtractionRun(tx, factsRun.id, config)).toBe(true);
      const [after] = await tx.select().from(extractionRuns).where(eq(extractionRuns.id, factsRun.id));
      expect(after).toMatchObject({ status: "finished", blockedReason: null });
      expect((await factsOf(tx, [factsRun.id])).length).toBeGreaterThan(0);
      expect(await activeExtractionRun(tx, unit.documentVersionId, unit.geoObjectId, config)).toEqual({ id: factsRun.id });
    }));

  it("reprocess creates a new extraction run and keeps the old facts", () =>
    withRollback(async (tx) => {
      const r = await fullRun(tx);
      const firstRuns = (await extractionRunsOf(tx, r.runId)).map((e) => e.id);
      const before = await factsOf(tx, firstRuns);
      const rec = recordingBoss();
      const { model } = fixtureModel();
      const { id: runId } = await startReprocessRun(tx, rec.boss, { scope: { tileId: TILE_A }, triggeredBy: "test" }, config);
      expect(await drive(tx, rec, model, runId, r.now)).toBe("finished");
      const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
      expect(run).toMatchObject({ kind: "reprocess", scopeType: "tile", scopeId: TILE_A, params: expect.objectContaining({ reprocess: true, tileId: TILE_A }) });
      const second = await extractionRunsOf(tx, runId);
      expect(second.map((e) => [e.task, e.status, e.purpose])).toEqual([
        ["extract-facts", "finished", "reprocess"],
        ["extract-route", "finished", "reprocess"],
      ]);
      const after = await factsOf(tx, second.map((e) => e.id));
      expect(after.length).toBeGreaterThan(0);
      // the old facts are all still there, unchanged
      expect(await factsOf(tx, firstRuns)).toEqual(before);
      expect((await belegtreue(tx, runId)).ratio).toBe(1);
    }));

  it("reprocess adds no duplicate mentions", () =>
    withRollback(async (tx) => {
      const r = await fullRun(tx);
      const snapshot = async () =>
        (await tx.select({ id: mentions.id }).from(mentions).where(inArray(mentions.documentVersionId, r.versionIds))).map((m) => m.id).sort();
      const before = await snapshot();
      const rec = recordingBoss();
      const { model, seen } = fixtureModel();
      const { id: runId } = await startReprocessRun(tx, rec.boss, { scope: { tileId: TILE_A }, triggeredBy: "test" }, config);
      expect(await drive(tx, rec, model, runId, r.now)).toBe("finished");
      expect(await snapshot()).toEqual(before);
      // nothing went to the disambiguation again, and every mention of the reprocessed versions was extracted again
      expect(seen.disambiguate).toBe(0);
      expect(seen.extract.length).toBeGreaterThan(0);
      const [er] = await tx.select().from(extractionRuns).where(and(eq(extractionRuns.runId, runId), eq(extractionRuns.task, "extract-facts")));
      const units = await tx.select({ mentionIds: extractionUnits.mentionIds }).from(extractionUnits).where(eq(extractionUnits.extractionRunId, er!.id));
      expect(units.flatMap((u) => u.mentionIds).length).toBeGreaterThan(0);
    }));

  it("a rematch run after a new name extracts only the new mentions", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      archiveOf.set(tx, memoryArchive());
      const { tile, island } = await islandTile(tx);
      const kolona = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.1, lat: 35.1, tiles: [tile] });
      const vathy = await insertNamedObject(tx, { type: "bay", names: [{ name: "Vathy" }], lon: 21.15, lat: 35.15, tiles: [tile] });
      const name = `Xen${newId().replace(/-/g, "").slice(-10).replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!)}`;
      const v = await insertTestVersion(tx, [`Vor Kalonisi ankerten wir in Kolona und dann vor Vathy. Danach in der Bucht von ${name}.`]);
      await tx.update(documentVersions).set({ classifiedDocType: "trip_report", classifiedModel: "claude-haiku-5-5", classifiedPromptVersion: 1 }).where(eq(documentVersions.id, v.versionId));
      // the first match ran with "vathy" as a common word: Vathy waited for the model; Kolona was extracted
      const earlier: AppConfig = {
        ...config,
        mentions: { ...config.mentions, commonWords: { ...config.mentions.commonWords, en: [...(config.mentions.commonWords.en ?? []), "vathy"] } },
      };
      await matchVersion(tx, v.versionId, { runId: null, cfg: earlier });
      const [amb] = await tx.select().from(ambiguousMatches).where(eq(ambiguousMatches.documentVersionId, v.versionId));
      expect(amb).toMatchObject({ surface: "Vathy", status: "pending" });
      await tx.update(mentions).set({ extractionStatus: "done" }).where(eq(mentions.documentVersionId, v.versionId));
      // the review created the new name's object (as "Ort anlegen" does)
      const xen = await insertNamedObject(tx, { type: "bay", names: [{ name }], lon: 21.12, lat: 35.12, tiles: [tile] });

      const rec = recordingBoss();
      const { model, seen } = fixtureModel();
      const { id: runId } = await startTextRun(tx, rec.boss, { documentVersionIds: [v.versionId], rematch: true, triggeredBy: "test" }, config);
      expect(await drive(tx, rec, model, runId, now)).toBe("finished");

      const ms = await tx.select().from(mentions).where(eq(mentions.documentVersionId, v.versionId));
      expect(ms.map((m) => m.geoObjectId).filter((id) => id !== island).sort()).toEqual([kolona, vathy, xen].sort());
      // the formerly ambiguous span is a mention now and no longer waits for the model: never both
      expect((await tx.select().from(ambiguousMatches).where(eq(ambiguousMatches.id, amb!.id)))[0]!.status).toBe("resolved");
      expect(seen.disambiguate).toBe(0);
      expect(await tx.select().from(aiBatches).where(and(eq(aiBatches.runId, runId), eq(aiBatches.stage, DISAMBIGUATE_STAGE)))).toEqual([]);
      // only the new mentions were extracted (Kolona was extracted before), and the report was not routed again
      expect(seen.extract.map((i) => i.object.name).sort()).toEqual([name, "Vathy"].sort());
      const [er] = await tx.select().from(extractionRuns).where(and(eq(extractionRuns.runId, runId), eq(extractionRuns.task, "extract-facts")));
      const units = await tx.select({ geoObjectId: extractionUnits.geoObjectId }).from(extractionUnits).where(eq(extractionUnits.extractionRunId, er!.id));
      expect(units.map((u) => u.geoObjectId).sort()).toEqual([vathy, xen].sort());
    }));

  it("a rematch run matches the new name in a chunk carried into the current version", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      archiveOf.set(tx, memoryArchive());
      const { tile } = await islandTile(tx);
      const kolona = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.1, lat: 35.1, tiles: [tile] });
      const name = `Xen${newId().replace(/-/g, "").slice(-10).replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!)}`;
      const named = `Von Kolona ging es weiter in die Bucht von ${name}.`;
      // the first version collected the name; the refetched one changed its first chunk and carried the second
      const v1 = await insertTestVersion(tx, ["Vor Kalonisi ankerten wir.", named]);
      await matchVersion(tx, v1.versionId, { runId: null, cfg: config });
      const v2 = await insertTestVersion(tx, ["Vor Kalonisi ankerten wir lange.", named], {
        documentId: v1.documentId,
        carried: { 1: v1.chunkIds[1]! },
        fetchedAt: new Date("2026-10-20T10:00:00Z"),
      });
      for (const v of [v1, v2]) {
        await tx.update(documentVersions).set({ classifiedDocType: "trip_report", classifiedModel: "claude-haiku-5-5", classifiedPromptVersion: 1 }).where(eq(documentVersions.id, v.versionId));
      }
      await matchVersion(tx, v2.versionId, { runId: null, cfg: config });
      await tx.update(mentions).set({ extractionStatus: "done" }).where(inArray(mentions.documentVersionId, [v1.versionId, v2.versionId]));
      const xen = await insertNamedObject(tx, { type: "bay", names: [{ name }], lon: 21.12, lat: 35.12, tiles: [tile] });

      const rec = recordingBoss();
      const { model, seen } = fixtureModel();
      const { id: runId } = await startTextRun(tx, rec.boss, { documentVersionIds: [v2.versionId], rematch: true, triggeredBy: "test" }, config);
      expect(await drive(tx, rec, model, runId, now)).toBe("finished");
      // the carried chunk gets the new object's mention, on the current version; Kolona stays with the original chunk
      const carried = await tx.select().from(mentions).where(eq(mentions.chunkId, v2.chunkIds[1]!));
      expect(carried.map((m) => [m.geoObjectId, m.documentVersionId, m.surface])).toEqual([[xen, v2.versionId, expect.stringContaining(name)]]);
      expect((await tx.select().from(mentions).where(eq(mentions.chunkId, v1.chunkIds[1]!))).map((m) => m.geoObjectId)).toEqual([kolona]);
      // only the new object is extracted
      expect(seen.extract.map((i) => i.object.name)).toEqual([name]);
    }));

  it("mentions a reprocess run's match added are not extracted again by the next regular run", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      archiveOf.set(tx, memoryArchive());
      const { tile } = await islandTile(tx);
      await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.1, lat: 35.1, tiles: [tile] });
      const name = `Xen${newId().replace(/-/g, "").slice(-10).replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!)}`;
      const v = await insertTestVersion(tx, [`Vor Kalonisi ankerten wir in Kolona. Danach in der Bucht von ${name}.`]);
      await tx.update(documentVersions).set({ classifiedDocType: "pilot_guide", classifiedModel: "claude-haiku-5-5", classifiedPromptVersion: 1 }).where(eq(documentVersions.id, v.versionId));
      const run = async (start: (rec: ReturnType<typeof recordingBoss>) => Promise<{ id: string }>) => {
        const rec = recordingBoss();
        const { model, seen } = fixtureModel();
        const { id } = await start(rec);
        expect(await drive(tx, rec, model, id, now)).toBe("finished");
        return seen.extract.map((i) => i.object.name);
      };
      expect(await run((rec) => startTextRun(tx, rec.boss, { documentVersionIds: [v.versionId], triggeredBy: "test" }, config))).toEqual(["Kalonisi", "Kolona"]);
      // the gazetteer grows; a reprocess of the tile matches the version again and extracts the new mention too
      const xen = await insertNamedObject(tx, { type: "bay", names: [{ name }], lon: 21.12, lat: 35.12, tiles: [tile] });
      expect((await run((rec) => startReprocessRun(tx, rec.boss, { scope: { tileId: tile }, triggeredBy: "test" }, config))).sort()).toEqual(["Kalonisi", "Kolona", name].sort());
      const statusOfXen = async () =>
        (await tx.select({ s: mentions.extractionStatus }).from(mentions).where(and(eq(mentions.documentVersionId, v.versionId), eq(mentions.geoObjectId, xen))))[0]!.s;
      expect(await statusOfXen()).toBe("pending");
      // the next regular run claims it, but its reprocess extraction is active already: nothing is paid again
      expect(await run((rec) => startTextRun(tx, rec.boss, { documentVersionIds: [v.versionId], triggeredBy: "test" }, config))).toEqual([]);
      expect(await statusOfXen()).toBe("done");
    }));

  it("a rematch with a configuration that makes a matched span ambiguous adds no waiting row over the mention", () =>
    withRollback(async (tx) => {
      const { tile } = await islandTile(tx);
      const vathy = await insertNamedObject(tx, { type: "bay", names: [{ name: "Vathy" }], lon: 21.15, lat: 35.15, tiles: [tile] });
      const v = await insertTestVersion(tx, ["Abends lagen wir vor Vathy auf Kalonisi."]);
      await matchVersion(tx, v.versionId, { runId: null, cfg: config });
      expect((await tx.select().from(mentions).where(eq(mentions.documentVersionId, v.versionId))).map((m) => m.geoObjectId)).toContain(vathy);
      const later: AppConfig = {
        ...config,
        mentions: { ...config.mentions, commonWords: { ...config.mentions.commonWords, en: [...(config.mentions.commonWords.en ?? []), "vathy"] } },
      };
      await matchVersion(tx, v.versionId, { runId: null, cfg: later });
      expect(await tx.select().from(ambiguousMatches).where(eq(ambiguousMatches.documentVersionId, v.versionId))).toEqual([]);
    }));

  it("a regular run does not route a trip report a run before routed on the same model and prompt", () =>
    withRollback(async (tx) => {
      const r = await fullRun(tx);
      const rec = recordingBoss();
      const { model, seen } = fixtureModel();
      const { id: runId } = await startTextRun(tx, rec.boss, { documentVersionIds: [r.versions["de-trip-report.md"]!], triggeredBy: "test" }, config);
      expect(await drive(tx, rec, model, runId, r.now)).toBe("finished");
      expect(seen.route).toBe(0);
      const [er] = await tx.select().from(extractionRuns).where(and(eq(extractionRuns.runId, runId), eq(extractionRuns.task, "extract-route")));
      expect(er?.stats ?? {}).toMatchObject({ versions: 0, versionsRoutedBefore: 1, versionsNotSent: 0 });
    }));

  it("'Belegtreue neu prüfen' checks a blocked extraction run again and leaves other runs alone", () =>
    withRollback(async (tx) => {
      const r = await fullRun(tx);
      const [er] = await tx.select().from(extractionRuns).where(and(eq(extractionRuns.runId, r.runId), eq(extractionRuns.task, "extract-facts")));
      expect(await recheckBlockedExtractionRun(tx, er!.id, config)).toBe(false);
      await tx.update(extractionRuns).set({ status: "blocked", blockedReason: "late_results" }).where(eq(extractionRuns.id, er!.id));
      expect(await recheckBlockedExtractionRun(tx, er!.id, config)).toBe(true);
      const [after] = await tx.select().from(extractionRuns).where(eq(extractionRuns.id, er!.id));
      expect(after).toMatchObject({ status: "finished", blockedReason: null });
    }));
});
