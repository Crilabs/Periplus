import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { expect } from "vitest";
import { createSimulatedFetcher, simulatedTransport } from "@/lib/adapters/fetch/simulated";
import type { HttpResponse, Transport } from "@/lib/adapters/http";
import type { MockModel } from "@/lib/ai/mock";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { newId } from "@/lib/domain/ids";
import type { RevisitScenario } from "@/lib/domain/revisit/scenario";
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
import { startRevisitRun } from "@/lib/pipeline/revisit-run";
import { freezeRevisitRun } from "@/lib/pipeline/revisit-stages";
import { enqueueStage } from "@/lib/pipeline/runs";
import { CHECK_QUEUE, checkExtractionRun } from "@/lib/pipeline/text/check";
import { CLASSIFY_QUEUE, classifyVersions } from "@/lib/pipeline/text/classify";
import { DISAMBIGUATE_QUEUE, disambiguateMatches } from "@/lib/pipeline/text/disambiguate";
import { EXTRACT_QUEUE, extractUnits } from "@/lib/pipeline/text/extract";
import { MENTIONS_QUEUE, matchVersions } from "@/lib/pipeline/text/mentions";
import { ROUTE_QUEUE, extractRoutes } from "@/lib/pipeline/text/routes";
import { startTextRun } from "@/lib/pipeline/text/run";
import { memoryArchive } from "@/test/s3";
import { addRevisitDocument, REVISIT_SUBDIVISION_KEY, seedRevisitArea, type RevisitFixture } from "./area";
import { createRevisitFakeModel } from "./fake-model";

/*
 * The run harness of the revisit fixture area (plan Task 14), shared by the integration test
 * (`lib/pipeline/__tests__/revisit-run.test.ts`) and the scenario draft test (Task 15): „Lauf 1“ over the recorded
 * versions, the package of that state, and simulated revisits driven job by job like the worker would, inside the
 * caller's `withRollback` transaction. Nothing reaches the network (simulated transport, MockModel, fake Voyage).
 */

/** The scenario a run with a simulated fetch needs; a crawl job without one is a harness misuse. */
function requireScenario(scenario: RevisitScenario | undefined, runId: string): RevisitScenario {
  if (!scenario) throw new Error(`run ${runId} fetches pages but the harness got no scenario`);
  return scenario;
}

const base = loadConfig("config");
/** The repository configuration with a large Anthropic budget (MockModel batches cost nothing). */
export const revisitTestConfig: AppConfig = {
  ...base,
  budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } },
};

export function recordingBoss() {
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
export const fakeVoyage: Transport = async (req) => {
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
export async function drive(
  tx: Db,
  archive: ReturnType<typeof memoryArchive>,
  rec: ReturnType<typeof recordingBoss>,
  model: MockModel,
  runId: string,
  day: string,
  scenario?: RevisitScenario,
) {
  const config = revisitTestConfig;
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
          ...simulatedFetchDeps(createSimulatedFetcher(requireScenario(scenario, runId)), cfg),
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
export const dateRun = (tx: Db, runId: string, day: string) => tx.execute(sql`update runs set created_at = ${`${day}T05:00:00Z`}::timestamptz where id = ${runId}`);

/** „Lauf 1“: a text run over the recorded versions, consolidated on `day`. */
export async function firstRun(tx: Db, archive: ReturnType<typeof memoryArchive>, fx: RevisitFixture, day: string, extraVersionIds: string[] = []) {
  const rec = recordingBoss();
  const versionIds = [...Object.values(fx.documents).map((d) => d.versionId), ...extraVersionIds];
  const { id } = await startTextRun(tx, rec.boss, { documentVersionIds: versionIds, triggeredBy: "test" }, revisitTestConfig);
  await dateRun(tx, id, day);
  expect(await drive(tx, archive, rec, createRevisitFakeModel(), id, day)).toBe("finished");
  return id;
}

/** One simulated revisit on `day`: started like `sim:revisit` does, driven to its end. */
export async function revisit(tx: Db, archive: ReturnType<typeof memoryArchive>, day: string, scenario: RevisitScenario, seen: { extract: string[] } = { extract: [] }) {
  const rec = recordingBoss();
  const { id } = await startRevisitRun(tx, rec.boss, { subdivisionKey: REVISIT_SUBDIVISION_KEY, triggeredBy: "sim:revisit" });
  await dateRun(tx, id, day);
  expect(await drive(tx, archive, rec, createRevisitFakeModel(seen), id, day, scenario)).toBe("finished");
  return { id, queues: rec.inserted.filter((j) => j.data.runId === id).map((j) => j.queue) };
}

export async function maxSeq(tx: Db): Promise<number> {
  const { rows } = await tx.execute<{ seq: string | null }>(sql`select max(seq)::text as seq from change_events`);
  return Number(rows[0]?.seq ?? 0);
}

/**
 * Seeds the subdivision (with `extraPages` beside d1 … d5), runs „Lauf 1“ on 2026-05-01 and builds the package of that state.
 */
export async function recordedState(tx: Db, extraPages: Array<Parameters<typeof addRevisitDocument>[3]> = []) {
  const archive = memoryArchive();
  const fx = await seedRevisitArea(tx, archive);
  const extras = [];
  for (const page of extraPages) extras.push(await addRevisitDocument(tx, archive, fx.sourceIds, page));
  await firstRun(tx, archive, fx, "2026-05-01", extras.map((e) => e.versionId));
  const first = await buildDelivery(tx, archive, fx.subdivisionId, { now: new Date("2026-05-01T08:00:00Z"), inCallerTransaction: true });
  expect(first).toMatchObject({ status: "valid", dataVersion: 1 });
  return { archive, fx, extras, fromSeq: await maxSeq(tx) };
}
