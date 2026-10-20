import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSimulatedFetcher, simulatedTransport } from "@/lib/adapters/fetch/simulated";
import type { HttpResponse, Transport } from "@/lib/adapters/http";
import { setSimulationMode } from "@/lib/adapters/simulation";
import type { MockModel } from "@/lib/ai/mock";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, externalCalls, runs } from "@/lib/db/schema";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { spotAsOf } from "@/lib/domain/delivery/read";
import { newId } from "@/lib/domain/ids";
import { parseScenario, type RevisitScenario } from "@/lib/domain/revisit/scenario";
import { verifyRevisit } from "@/lib/domain/revisit/verify";
import { recordJobOutcome } from "@/lib/domain/runs";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { enqueueRunAdvance, enqueueStageJobs } from "@/lib/jobs/enqueue";
import { simulatedFetchDeps } from "@/lib/jobs/handlers/fetch";
import { BATCH_POLL_QUEUE, RUN_ADVANCE_QUEUE } from "@/lib/jobs/queues";
import type { JobData } from "@/lib/jobs/worker";
import { pollBatch, type BatchDeps, type PollOptions } from "@/lib/pipeline/batches";
import { requestPlaceDiscovery } from "@/lib/pipeline/consolidation/followup";
import { consolidateGeoJob } from "@/lib/pipeline/consolidation/geo";
import { summarizeProfile } from "@/lib/pipeline/consolidation/summary";
import { EMBED_STAGE, embedChunks } from "@/lib/pipeline/embed";
import { prepareSourceCrawl } from "@/lib/pipeline/fetch/source";
import { FETCH_URL_STAGE, fetchUrl } from "@/lib/pipeline/fetch/url";
import { REVISIT_STAGES, startRevisitRun } from "@/lib/pipeline/revisit-run";
import { freezeRevisitRun } from "@/lib/pipeline/revisit-stages";
import { enqueueStage } from "@/lib/pipeline/runs";
import { CHECK_QUEUE, checkExtractionRun } from "@/lib/pipeline/text/check";
import { CLASSIFY_QUEUE, classifyVersions } from "@/lib/pipeline/text/classify";
import { DISAMBIGUATE_QUEUE, disambiguateMatches } from "@/lib/pipeline/text/disambiguate";
import { EXTRACT_QUEUE, extractUnits } from "@/lib/pipeline/text/extract";
import { MENTIONS_QUEUE, matchVersions } from "@/lib/pipeline/text/mentions";
import { ROUTE_QUEUE, extractRoutes } from "@/lib/pipeline/text/routes";
import { startTextRun } from "@/lib/pipeline/text/run";
import { withRollback } from "@/test/db";
import { REVISIT_AREA_KEY, seedRevisitArea, type RevisitFixture } from "@/test/revisit/fixture/area";
import { createRevisitFakeModel } from "@/test/revisit/fixture/fake-model";
import { memoryArchive } from "@/test/s3";

/*
 * The simulated revisit end to end on the one-tile fixture area (plan Task 14, spec 10 CI criterion), inside
 * withRollback: „Lauf 1“ (a text run over the recorded versions, 2026-05-01) and the package of that state, then two
 * revisit runs (2026-06-01 and 2026-06-08) started by `startRevisitRun` and driven job by job like the worker would —
 * the simulated crawl (`fetch.source`, `fetch.url` with the scenario's fetcher, `embed.chunks` with fake embeddings),
 * `revisit.freeze`, every text stage with the fake model, the consolidation. Nothing reaches the network: the crawl's
 * only transport is the in-process simulated one, the model is a MockModel, the embeddings come from a fake Voyage
 * transport, and the test checks that no blocked service was called.
 */

const base = loadConfig("config");
const config: AppConfig = {
  ...base,
  areas: [...base.areas, { ...base.areas[0]!, key: REVISIT_AREA_KEY }],
  budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } },
};
const scenario: RevisitScenario = parseScenario(
  readFileSync(join(process.cwd(), "test/revisit/fixture/scenario.json"), "utf8"),
  "test/revisit/fixture/scenario.json",
);

const TIMEOUT = 120_000;

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

/** A fake Voyage endpoint: one constant unit vector per text, no tokens billed. */
const fakeVoyage: Transport = async (req) => {
  const { input } = JSON.parse(String(req.body)) as { input: string[] };
  const vector = Array.from({ length: base.embeddings.dimension }, (_, i) => (i === 0 ? 1 : 0));
  const text = JSON.stringify({ data: input.map((_, index) => ({ index, embedding: vector })), usage: { total_tokens: 0 } });
  const body = new TextEncoder().encode(text);
  return { status: 200, body, headers: { "content-type": "application/json" }, finalUrl: req.url, text: () => text } satisfies HttpResponse;
};

type Job = JobData & { runId: string; stage: string; key: string };

/**
 * Executes every job the run enqueued, in order, like the worker: stage jobs call their stage function, then record
 * their outcome (enqueueing `run.advance` when the stage is done); `run.advance` plans the next stage, `ai.batch.poll`
 * polls the batch. A queue without a driver fails the test (e.g. `mentions.geocode`); `consolidation.followup` has a
 * driver for „Lauf 1“, its absence from a simulated revisit is asserted on the run's stages and queues. Returns the
 * run's status.
 */
async function drive(tx: Db, archive: ReturnType<typeof memoryArchive>, rec: ReturnType<typeof recordingBoss>, model: MockModel, runId: string, day: string) {
  const now = new Date(`${day}T12:00:00Z`);
  const deps: BatchDeps = { model, boss: rec.boss, config, now: () => now, reservationScope: { runIds: [runId] } };
  const cfg = config.fetch;
  const stageJobs: Record<string, (job: Job) => Promise<unknown>> = {
    "fetch.source": (job) => prepareSourceCrawl(tx, job.sourceId as string, { transport: simulatedTransport, archive }, { db: tx, runId, stage: job.stage, sourceId: job.sourceId as string }),
    "fetch.url": (job) =>
      fetchUrl(
        tx,
        job as Job & { sourceId: string; url: string; depth: number },
        {
          // the worker's fetch.url wiring in a simulation, shared (every page from the scenario, no converter service or renderer)
          ...simulatedFetchDeps(createSimulatedFetcher(scenario), cfg),
          archive,
          enqueue: (t, jobs) => enqueueStageJobs(rec.boss, "fetch.url", runId, FETCH_URL_STAGE, jobs, t),
          now: () => new Date(`${day}T06:00:00Z`),
        },
        { db: tx, runId, stage: job.stage, sourceId: job.sourceId as string },
      ),
    [EMBED_STAGE]: (job) => embedChunks(tx, job.chunkIds as string[], { transport: fakeVoyage }, { db: tx, runId, stage: job.stage, sourceId: job.sourceId as string }),
    "revisit.freeze": () => freezeRevisitRun(tx, runId, config),
    [CLASSIFY_QUEUE]: (job) => classifyVersions(tx, { ...deps, archive }, job as Job & { documentVersionIds: string[] }),
    [MENTIONS_QUEUE]: (job) => matchVersions(tx, job as Job & { versionIds: string[] }, config),
    [DISAMBIGUATE_QUEUE]: (job) => disambiguateMatches(tx, deps, job as Job & { ambiguousIds: string[] }),
    [EXTRACT_QUEUE]: (job) => extractUnits(tx, deps, job as Job & { extractionRunId: string; unitIds: string[] }),
    [ROUTE_QUEUE]: (job) => extractRoutes(tx, { ...deps, archive }, job as Parameters<typeof extractRoutes>[2]),
    [CHECK_QUEUE]: (job) => checkExtractionRun(tx, job.extractionRunId as string, config),
    "consolidation.geo": (job) => consolidateGeoJob(tx, job),
    "consolidation.summary": (job) =>
      summarizeProfile(tx, { geoObjectId: job.geoObjectId as string, version: job.version as number, runId, rulesVersion: job.rulesVersion as string | undefined }, { model }),
    "consolidation.followup": (job) => requestPlaceDiscovery(tx, rec.boss, job.runId),
  };
  for (let i = 0; i < rec.inserted.length; i++) {
    const { queue, data } = rec.inserted[i]!;
    if (queue !== BATCH_POLL_QUEUE && String(data.runId) !== runId) continue;
    if (queue === RUN_ADVANCE_QUEUE) {
      await enqueueStage(tx, rec.boss, String(data.runId), String(data.nextStage));
    } else if (queue === BATCH_POLL_QUEUE) {
      await pollBatch(tx, { ...deps, handlers: BATCH_HANDLERS }, String(data.batchId), { n: data.n, mode: data.mode } as PollOptions);
    } else {
      const job = data as Job;
      const run = stageJobs[queue];
      if (!run) throw new Error(`no driver for queue ${queue} (run ${runId})`);
      await run(job);
      const result = await recordJobOutcome(tx, job.runId, job.stage, job.key, "done");
      if (result.nextStage) await enqueueRunAdvance(rec.boss, job.runId, result.nextStage, tx);
    }
  }
  const [row] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
  return row!.status;
}

/** Dates the run: its `created_at` is the run date consolidation and validity go by. */
const dateRun = (tx: Db, runId: string, day: string) => tx.execute(sql`update runs set created_at = ${`${day}T05:00:00Z`}::timestamptz where id = ${runId}`);

/** „Lauf 1“: a text run over the recorded versions, consolidated on `day`. */
async function firstRun(tx: Db, archive: ReturnType<typeof memoryArchive>, fx: RevisitFixture, day: string) {
  const rec = recordingBoss();
  const versionIds = Object.values(fx.documents).map((d) => d.versionId);
  const { id } = await startTextRun(tx, rec.boss, { documentVersionIds: versionIds, triggeredBy: "test" }, config);
  await dateRun(tx, id, day);
  expect(await drive(tx, archive, rec, createRevisitFakeModel(), id, day)).toBe("finished");
  return id;
}

/** One simulated revisit on `day`: started like `sim:revisit` does, driven to its end. */
async function revisit(tx: Db, archive: ReturnType<typeof memoryArchive>, day: string, seen: { extract: string[] } = { extract: [] }) {
  const rec = recordingBoss();
  const { id } = await startRevisitRun(tx, rec.boss, { areaKey: REVISIT_AREA_KEY, triggeredBy: "sim:revisit" }, config);
  await dateRun(tx, id, day);
  expect(await drive(tx, archive, rec, createRevisitFakeModel(seen), id, day)).toBe("finished");
  return { id, queues: rec.inserted.filter((j) => j.data.runId === id).map((j) => j.queue) };
}

async function maxSeq(tx: Db): Promise<number> {
  const { rows } = await tx.execute<{ seq: string | null }>(sql`select max(seq)::text as seq from change_events`);
  return Number(rows[0]?.seq ?? 0);
}

/** Seeds the area, runs „Lauf 1“ on 2026-05-01 and builds the package of that state. */
async function recordedState(tx: Db) {
  const archive = memoryArchive();
  const fx = await seedRevisitArea(tx, archive);
  await firstRun(tx, archive, fx, "2026-05-01");
  const first = await buildDelivery(tx, archive, fx.areaId, { now: new Date("2026-05-01T08:00:00Z"), inCallerTransaction: true });
  expect(first).toMatchObject({ status: "valid", dataVersion: 1 });
  return { archive, fx, fromSeq: await maxSeq(tx) };
}

beforeEach(() => setSimulationMode(undefined));
afterEach(() => setSimulationMode(undefined));

describe("simulated revisit on the fixture area", () => {
  it(
    "the simulated revisit shows exactly the scenario's changes and the old spot stays readable",
    () =>
      withRollback(async (tx) => {
        const { archive, fx, fromSeq } = await recordedState(tx);
        // the call rows that exist before the revisits (visible to this transaction): the rest is the test window's
        const callsBefore = new Set((await tx.select({ id: externalCalls.id }).from(externalCalls)).map((c) => c.id));
        setSimulationMode(true);
        const revisits: Array<Awaited<ReturnType<typeof revisit>>> = [];
        for (const day of ["2026-06-01", "2026-06-08"]) revisits.push(await revisit(tx, archive, day));
        setSimulationMode(undefined);

        const v = await verifyRevisit(tx, scenario, { fromSeq, areaKey: fx.areaKey });
        expect(v.unexpected).toEqual([]);
        expect(v.entries.map((e) => [e.id, e.ok])).toEqual([
          ["e1", true],
          ["e2", true],
          ["e3", true],
          ["e4", true],
          ["e5", true],
        ]);
        expect(v.correct).toBe(5);
        expect(v.passes).toBe(true);

        // the gone page turned gone at its second miss, and its object was judged again (ruling M7-P7)
        const [d3] = await tx.select().from(documents).where(eq(documents.id, fx.documents.d3.id));
        expect(d3).toMatchObject({ status: "gone", consecutiveGone: 2 });
        const [second] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, revisits[1]!.id));
        expect((second!.params as { goneGeoObjectIds: string[] }).goneGeoObjectIds).toEqual([fx.places.A.geoObjectId]);

        // the runs: kind revisit, no follow-up stage, no geocoding or follow-up job (ruling M7-P8)
        for (const r of revisits) {
          const [row] = await tx.select().from(runs).where(eq(runs.id, r.id));
          expect(row).toMatchObject({ kind: "revisit", scopeType: "area", scopeId: fx.areaKey, status: "finished" });
          expect(row!.stages).toEqual(REVISIT_STAGES.filter((s) => s !== "consolidation.followup"));
          expect(r.queues.filter((q) => ["mentions.geocode", "consolidation.followup", "discovery.place", "discovery.tile"].includes(q))).toEqual([]);
        }
        // nothing reached a blocked service (ruling M7-P8): every call row written during the revisits — with or
        // without a run id — is the simulated robots.txt (answered in process), a fake embedding or a MockModel batch,
        // the two services a simulation may use, and nothing cost anything
        const calls = (await tx.select().from(externalCalls)).filter((c) => !callsBefore.has(c.id));
        expect(calls.length).toBeGreaterThan(0);
        expect([...new Set(calls.filter((c) => !["robots", "voyage", "anthropic"].includes(c.service)).map((c) => c.service))]).toEqual([]);
        expect([...new Set(calls.filter((c) => c.service === "robots").map((c) => c.operation))]).toEqual(["robots.txt"]);
        expect(calls.reduce((sum, c) => sum + Number(c.costEur), 0)).toBe(0);
        // the simulated versions carry the first revisit run
        const simulated = await tx.select({ runId: documentVersions.runId }).from(documentVersions).where(eq(documentVersions.simulated, true));
        expect(new Set(simulated.filter((s) => s.runId !== null && revisits.some((r) => r.id === s.runId)).map((s) => s.runId))).toEqual(new Set([revisits[0]!.id]));

        const after = await buildDelivery(tx, archive, fx.areaId, { now: new Date("2026-06-08T08:00:00Z"), inCallerTransaction: true });
        expect(after).toMatchObject({ status: "valid", dataVersion: 2 });
        // the old version is the old value: the taverna open before the revisit, closed after it
        const old = (await spotAsOf(tx, archive, fx.publicIds.A, "2026-05-15"))!;
        const now = (await spotAsOf(tx, archive, fx.publicIds.A, "2026-06-09"))!;
        expect([old.dataVersion, now.dataVersion]).toEqual([1, 2]);
        expect([old.spot.services?.taverna, now.spot.services?.taverna]).toEqual(["yes", "no"]);
      }),
    TIMEOUT,
  );

  it(
    "a second revisit without further changes adds no change event",
    () =>
      withRollback(async (tx) => {
        const { archive, fx } = await recordedState(tx);
        setSimulationMode(true);
        for (const day of ["2026-06-01", "2026-06-08"]) await revisit(tx, archive, day);
        const before = await maxSeq(tx);
        const seen = { extract: [] as string[] };
        await revisit(tx, archive, "2026-06-15", seen);
        setSimulationMode(undefined);
        // nothing new to extract, and not one event for an object of the area
        expect(seen.extract).toEqual([]);
        const objects = [fx.areaId, fx.islandId, ...Object.values(fx.places).map((p) => p.geoObjectId)];
        const { rows } = await tx.execute(sql`
          select seq from change_events
          where seq > ${before} and geo_object_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(objects)}::jsonb))`);
        expect(rows).toEqual([]);
      }),
    TIMEOUT,
  );

  it(
    "a scenario expecting a wrong type fails verification with one missing and one unexpected",
    () =>
      withRollback(async (tx) => {
        const { archive, fx, fromSeq } = await recordedState(tx);
        setSimulationMode(true);
        for (const day of ["2026-06-01", "2026-06-08"]) await revisit(tx, archive, day);
        setSimulationMode(undefined);
        // e2 expects the depth change as uncertain: the scenario is wrong, the pipeline right
        const wrong: RevisitScenario = {
          ...scenario,
          entries: scenario.entries.map((e) => (e.id === "e2" ? { ...e, expect: { ...e.expect, events: [{ ...e.expect.events[0]!, type: "uncertain" as const }] } } : e)),
        };
        const v = await verifyRevisit(tx, wrong, { fromSeq, areaKey: fx.areaKey });
        expect(v.entries.find((e) => e.id === "e2")).toMatchObject({ events: { expected: 1, matched: 0 }, ok: false });
        expect(v.correct).toBe(4);
        expect(v.unexpected.map((u) => [u.subject, u.attribute, u.type, u.severity])).toEqual([[fx.publicIds.B, "depth.min", "changed", "safety"]]);
        expect(v.passes).toBe(false);
      }),
    TIMEOUT,
  );
});
