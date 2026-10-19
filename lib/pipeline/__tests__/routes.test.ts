import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { quietDay } from "@/test/external-calls";
import { memoryArchive } from "@/test/s3";
import { insertNamedObject, insertTestTile, insertTestVersion } from "@/test/text";
import { buildParams } from "@/lib/ai/anthropic";
import { MockBatchError, MockModel } from "@/lib/ai/mock";
import { extractRouteTask, type ExtractRouteInput, type ExtractRouteOutput } from "@/lib/ai/tasks/extract-route";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiBatchItems, documentVersions, extractionRuns, mentions, routes, routeStops } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun } from "@/lib/domain/runs";
import { tileIdFor } from "@/lib/domain/tiles";
import { pollBatch, type BatchHandlerEntry } from "@/lib/pipeline/batches";
import { checkExtractionRun } from "@/lib/pipeline/text/check";
import { extractRoutes, planRoutes, ROUTE_STAGE, routeSectionBatchEntry, type RouteJob } from "@/lib/pipeline/text/routes";

/*
 * Stage extraction.route end to end inside withRollback: plan → job (message batch via MockModel) → poll (handler) →
 * check. Reports are cut into sections by a small `routeSectionWords`.
 */

const base = loadConfig("config");
const config: AppConfig = {
  ...base,
  budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } },
  extraction: { ...base.extraction, routeSectionWords: 20 },
};
const HANDLERS: Record<string, BatchHandlerEntry> = { "extract-route": routeSectionBatchEntry };

const CHUNKS = [
  "# Day 1\n\nWe left Ermioni early and anchored in Kolona Bay for the night.",
  "# Day 2\n\nNext morning we sailed 12 nm to Vathy with a NE 4 and moored at the quay.",
];

const ANSWERS: Record<number, ExtractRouteOutput> = {
  1: { stops: [{ name: "Kolona Bay", date: null, mooring: "anchor", quote: "anchored in Kolona Bay for the night", leg: null }] },
  2: {
    stops: [
      {
        name: "Vathy",
        date: null,
        mooring: "quay",
        quote: "Next morning we sailed 12 nm to Vathy",
        leg: { distance_nm: 12, duration_h: null, wind_direction: "NE", wind_beaufort: 4, quote: "we sailed 12 nm to Vathy with a NE 4" },
      },
    ],
  },
};

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

/** A trip report in the archive (two sections at 20 words), Kolona and Vathy mentioned, and a pilot guide. */
async function scene(tx: Db) {
  const archive = memoryArchive();
  const tile = await insertTestTile(tx, tileIdFor(21.0, 35.2));
  const kolona = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.0, lat: 35.2, tiles: [tile] });
  const vathy = await insertNamedObject(tx, { type: "bay", names: [{ name: "Vathy" }], lon: 21.02, lat: 35.2, tiles: [tile] });
  const report = await insertTestVersion(tx, CHUNKS);
  const guide = await insertTestVersion(tx, CHUNKS);
  await tx.update(documentVersions).set({ classifiedDocType: "pilot_guide" }).where(eq(documentVersions.id, guide.versionId));
  for (const v of [report, guide]) {
    const [row] = await tx.select({ mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, v.versionId));
    await archive.put(row!.mdKey, CHUNKS.join("\n\n"), "text/markdown");
  }
  for (const [chunk, surface, geoObjectId] of [
    [0, "Kolona Bay", kolona],
    [1, "Vathy", vathy],
  ] as const) {
    const at = CHUNKS[chunk]!.indexOf(surface);
    await tx.insert(mentions).values({
      documentVersionId: report.versionId,
      chunkId: report.chunkIds[chunk]!,
      geoObjectId,
      surface,
      charStart: at,
      charEnd: at + surface.length,
      observedAt: "2026-10-19",
      confidence: 1,
      matchKind: "deterministic",
    });
  }
  const params = { documentVersionIds: [report.versionId, guide.versionId] };
  const { id: runId } = await createRun(tx, { kind: "stage", scope: { type: "system", id: `route-test-${newId()}` }, stages: [ROUTE_STAGE], params, triggeredBy: "test" });
  return { archive, report, guide, kolona, vathy, params, runId };
}

const asJob = (runId: string, data: Record<string, unknown>): RouteJob => ({ runId, stage: ROUTE_STAGE, ...(data as Omit<RouteJob, "runId" | "stage">) });

describe("stage extraction.route", () => {
  it("a long report's sections go out one item each; its route is stored once every section is answered, also across batches", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      const seen: ExtractRouteInput[] = [];
      const model = new MockModel({
        "extract-route": (input) => {
          seen.push(input as ExtractRouteInput);
          return ANSWERS[(input as ExtractRouteInput).section]!;
        },
      });
      const jobs = await planRoutes(tx, { id: s.runId, params: s.params }, config);
      // only the trip report; the pilot guide has no route
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ key: "route:0", versionIds: [s.report.versionId] });
      const [extractionRun] = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, s.runId));
      expect(extractionRun).toMatchObject({ task: "extract-route", model: "claude-sonnet-5-5", promptVersion: 1, purpose: "regular", status: "running" });

      await beginStage(tx, s.runId, ROUTE_STAGE, jobs.length);
      const { boss, inserted } = recordingBoss();
      // one request per batch: the second section goes to a follow-on job and its own batch
      const oneEach: AppConfig = { ...config, models: { ...config.models, batch: { ...config.models.batch, maxRequests: 1 } } };
      const deps = { model, boss, archive: s.archive, config: oneEach, now: () => now, reservationScope: { runIds: [s.runId] } };
      expect(await extractRoutes(tx, deps, asJob(s.runId, jobs[0]!))).toEqual({ submitted: 1, remainder: 1, reused: false });
      const followOn = inserted.filter((j) => j.queue === "extraction.route");
      expect(followOn.map((j) => j.data)).toEqual([expect.objectContaining({ key: "route:0+", sectionIds: [`${s.report.versionId}:2`] })]);
      await extractRoutes(tx, deps, asJob(s.runId, followOn[0]!.data));

      const batches = await tx.select().from(aiBatches).where(eq(aiBatches.runId, s.runId)).orderBy(aiBatches.id);
      expect(batches).toHaveLength(2);
      expect(await pollBatch(tx, { ...deps, handlers: HANDLERS }, batches[0]!.id)).toBe("distributed");
      // one section answered: no route yet
      expect(await tx.select().from(routes).where(eq(routes.documentVersionId, s.report.versionId))).toHaveLength(0);
      expect(await pollBatch(tx, { ...deps, handlers: HANDLERS }, batches[1]!.id)).toBe("distributed");

      expect(seen.map((i) => [i.section, i.sections, i.observedAt, i.maxStops, i.text.split("\n")[0]])).toEqual([
        [1, 2, "2026-10-19", 60, "# Day 1"],
        [2, 2, "2026-10-19", 60, "# Day 2"],
      ]);
      // the limits of the prompt come from the config
      expect(seen[0]).toMatchObject({ quoteMinChars: 12, quoteMaxChars: 300, stopNameMaxChars: 80, maxBeaufort: 12 });
      const stops = await tx
        .select({ ordinal: routeStops.ordinal, name: routeStops.name, geoObjectId: routeStops.geoObjectId })
        .from(routeStops)
        .innerJoin(routes, eq(routes.id, routeStops.routeId))
        .where(eq(routes.extractionRunId, extractionRun!.id))
        .orderBy(routeStops.ordinal);
      expect(stops).toEqual([
        { ordinal: 0, name: "Kolona Bay", geoObjectId: s.kolona },
        { ordinal: 1, name: "Vathy", geoObjectId: s.vathy },
      ]);

      // the check finishes the extraction run with its route counters
      expect(await checkExtractionRun(tx, extractionRun!.id, config)).toMatchObject({ facts: 2, verified: 2, ratio: 1 });
      const [checked] = await tx.select().from(extractionRuns).where(eq(extractionRuns.id, extractionRun!.id));
      expect(checked).toMatchObject({
        status: "finished",
        stats: { versions: 1, sections: 2, sectionsFailed: 0, routes: 1, versionsWithoutRoute: 0, stops: 2, assigned: 2, droppedStops: 0 },
      });
      // planned again, the report with its route is not sent again
      expect(await planRoutes(tx, { id: s.runId, params: s.params }, config)).toEqual([]);
    }));

  it("a section that fails for good leaves its report without a route, and the run's stats say so", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      const model = new MockModel({
        "extract-route": (input) => {
          const { section } = input as ExtractRouteInput;
          if (section === 2) throw new MockBatchError("refused", false);
          return ANSWERS[section]!;
        },
      });
      const jobs = await planRoutes(tx, { id: s.runId, params: s.params }, config);
      await beginStage(tx, s.runId, ROUTE_STAGE, jobs.length);
      const deps = { model, boss: recordingBoss().boss, archive: s.archive, config, now: () => now, reservationScope: { runIds: [s.runId] } };
      expect(await extractRoutes(tx, deps, asJob(s.runId, jobs[0]!))).toMatchObject({ submitted: 2, remainder: 0 });
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, s.runId));
      await pollBatch(tx, { ...deps, handlers: HANDLERS }, batch!.id);
      expect(await tx.select().from(routes).where(eq(routes.documentVersionId, s.report.versionId))).toHaveLength(0);
      const [run] = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, s.runId));
      await checkExtractionRun(tx, run!.id, config);
      const [checked] = await tx.select().from(extractionRuns).where(eq(extractionRuns.id, run!.id));
      expect(checked).toMatchObject({
        status: "finished",
        stats: { versions: 1, sections: 2, sectionsFailed: 1, routes: 0, versionsWithoutRoute: 1, stops: 0 },
        quoteCheck: { facts: 0, ratio: 1 },
      });
    }));
  it("sections never sent and reports never sent count as failed in the run's stats", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const s = await scene(tx);
      // a second trip report whose archived Markdown is missing: none of its sections can be sent
      const missing = await insertTestVersion(tx, CHUNKS);
      const params = { documentVersionIds: [s.report.versionId, missing.versionId] };
      const { id: runId } = await createRun(tx, { kind: "stage", scope: { type: "system", id: `route-test-${newId()}` }, stages: [ROUTE_STAGE], params, triggeredBy: "test" });
      const model = new MockModel({ "extract-route": (input) => ANSWERS[(input as ExtractRouteInput).section]! });
      const jobs = await planRoutes(tx, { id: runId, params }, config);
      await beginStage(tx, runId, ROUTE_STAGE, jobs.length);
      // one request per batch: the report's second section goes to a follow-on job that never runs
      const oneEach: AppConfig = { ...config, models: { ...config.models, batch: { ...config.models.batch, maxRequests: 1 } } };
      const deps = { model, boss: recordingBoss().boss, archive: s.archive, config: oneEach, now: () => now, reservationScope: { runIds: [runId] } };
      expect(await extractRoutes(tx, deps, asJob(runId, jobs[0]!))).toMatchObject({ submitted: 1, remainder: 1 });
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      await pollBatch(tx, { ...deps, handlers: HANDLERS }, batch!.id);
      const [run] = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, runId));
      await checkExtractionRun(tx, run!.id, config);
      const [checked] = await tx.select().from(extractionRuns).where(eq(extractionRuns.id, run!.id));
      expect(checked!.stats).toMatchObject({ versions: 2, sections: 2, sectionsFailed: 1, versionsNotSent: 1, routes: 0, versionsWithoutRoute: 2 });
    }));

  it("of two answers to a section the latest by creation counts, not the higher id", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      await planRoutes(tx, { id: s.runId, params: s.params }, config);
      const [run] = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, s.runId));
      const subjectId = `${s.report.versionId}:1`;
      const input: ExtractRouteInput = { section: 1, sections: 1, observedAt: "2026-10-19", maxStops: 60, quoteMinChars: 12, quoteMaxChars: 300, stopNameMaxChars: 80, maxBeaufort: 12, text: CHUNKS.join("\n\n") };
      const answer = async (id: string, createdAt: Date, output: ExtractRouteOutput) => {
        const [batch] = await tx
          .insert(aiBatches)
          .values({ task: "extract-route", model: run!.model, promptVersion: 1, status: "distributed", runId: s.runId, stage: ROUTE_STAGE, outcomeKey: `route:${id}`, requestCount: 1 })
          .returning();
        await tx.insert(aiBatchItems).values({ id, batchId: batch!.id, subjectType: "route_section", subjectId, input, status: "succeeded", output, createdAt });
        return batch!;
      };
      // the older answer has the higher uuid
      await answer("ffffffff-ffff-4fff-8fff-ffffffffffff", new Date("2026-10-19T08:00:00Z"), ANSWERS[1]!);
      const newer = await answer("00000000-0000-4000-8000-000000000001", new Date("2026-10-19T09:00:00Z"), ANSWERS[2]!);
      await routeSectionBatchEntry.handle(
        tx,
        {
          id: "00000000-0000-4000-8000-000000000001",
          subjectType: "route_section",
          subjectId,
          input,
          output: ANSWERS[2],
          usage: { inputTokens: 0, outputTokens: 0 },
          costEur: 0,
          batch: { id: newer.id, model: newer.model, promptVersion: newer.promptVersion, runId: s.runId, stage: ROUTE_STAGE },
        },
        { config },
      );
      const stops = await tx
        .select({ name: routeStops.name })
        .from(routeStops)
        .innerJoin(routes, eq(routes.id, routeStops.routeId))
        .where(eq(routes.extractionRunId, run!.id));
      expect(stops).toEqual([{ name: "Vathy" }]);
    }));

  it("the prompt states the rules and the configured limits and carries the section", () => {
    const input: ExtractRouteInput = {
      section: 2,
      sections: 3,
      observedAt: "2024-05-15",
      maxStops: 7,
      quoteMinChars: 11,
      quoteMaxChars: 299,
      stopNameMaxChars: 79,
      maxBeaufort: 13,
      text: "## Day 2\n\nWe anchored in Kolona.",
    };
    const params = buildParams(extractRouteTask, input, config.models.tasks["extract-route"]!, "claude-sonnet-5-5");
    const system = JSON.stringify(params.system);
    expect(system).toContain("At most 7 stops.");
    expect(system).toContain("at least 11 and at most 299 characters");
    expect(system).toContain("at most 79 characters");
    expect(system).toContain("Beaufort (0 to 13)");
    expect(system).not.toContain("{{");
    expect(system).toContain("anchor, buoy, quay, marina, unknown");
    expect(system).toContain("N, NE, E, SE, S, SW, W, NW");
    expect(system).toContain("verbatim quote");
    const user = JSON.stringify(params.messages);
    expect(user).toContain("Section 2 of 3. Observed: 2024-05-15");
    expect(user).toContain("We anchored in Kolona.");
  });
});
