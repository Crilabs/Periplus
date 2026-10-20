import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterEach, describe, expect, it } from "vitest";
import { setSimulationMode } from "@/lib/adapters/simulation";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { crawlFrontier, documents, documentVersions, runs, sources, tileGeoObjects } from "@/lib/db/schema";
import { activeRulesVersion } from "@/lib/domain/consolidation/active-rules";
import { consolidationTargets } from "@/lib/domain/consolidation/targets";
import { newId } from "@/lib/domain/ids";
import { markConsolidationSkipped } from "@/lib/domain/consolidation/skipped";
import { createRun, endRun } from "@/lib/domain/runs";
import { consolidationFollowupStage } from "@/lib/jobs/handlers/consolidation";
import { revisitFreezeStage } from "@/lib/jobs/handlers/revisit";
import { QUEUES } from "@/lib/jobs/queues";
import { HANDLERS } from "@/lib/jobs/registry";
import { STAGES } from "@/lib/jobs/stages";
import { catchUpConsolidation } from "@/lib/pipeline/consolidation/run";
import { CONSOLIDATION_FOLLOWUP_STAGE } from "@/lib/pipeline/consolidation/stages";
import { FETCH_RUN_STAGES } from "@/lib/pipeline/fetch/run";
import { REVISIT_STAGES, startRevisitRun } from "@/lib/pipeline/revisit-run";
import { freezeRevisitRun, REVISIT_FREEZE_STAGE } from "@/lib/pipeline/revisit-stages";
import { planGeocode } from "@/lib/pipeline/text/geocode";
import { TEXT_RUN_STAGES } from "@/lib/pipeline/text/run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { foreignJobs, revisitPreflight, SIM_TRIGGERED_BY } from "@/lib/domain/revisit/preflight";
import { insertExtraction, insertMention, insertMentionFact, insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertQualityArea } from "@/test/quality";
import { memoryArchive } from "@/test/s3";
import { insertTestSource } from "@/test/text";

/*
 * The revisit run (plan Task 13, rulings M7-P6/P7/P8): stage list, starter, freeze stage and the simulation's stage
 * skipping, in withRollback with a recording boss (no worker); the whole run is driven in revisit-run.test.ts.
 */

const base = loadConfig("config");

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

const someone = () => `${newId()}@test.invalid`;

/** A configured synthetic area (one coast tile) and an approved source of it. */
async function revisitArea(tx: Db) {
  const area = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
  const config: AppConfig = { ...base, areas: [...base.areas, { ...base.areas[0]!, key: area.areaKey }] };
  const sourceId = await insertTestSource(tx);
  await tx.update(sources).set({ status: "approved" }).where(eq(sources.id, sourceId));
  return { ...area, config, sourceId };
}

afterEach(() => setSimulationMode(undefined));

/** A new document of the source with one current version, written by run `runId` (a crawl) or by none. */
async function crawledVersion(tx: Db, sourceId: string, runId: string | null, documentId?: string): Promise<{ versionId: string }> {
  const url = `https://${newId()}.test.invalid/page`;
  const [doc] = documentId
    ? [{ id: documentId }]
    : await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "trip_report" }).returning({ id: documents.id });
  const [version] = await tx
    .insert(documentVersions)
    .values({
      documentId: doc!.id,
      fetchedAt: new Date("2026-06-01T06:00:00Z"),
      contentHash: newId(),
      rawHash: "r",
      rawKey: `archive/${doc!.id}/${newId()}.raw.md`,
      mdKey: `archive/${doc!.id}/${newId()}.md`,
      observedAt: "2026-06-01",
      observedAtBasis: "fetched",
      docType: "trip_report",
      converter: "local",
      charCount: 10,
      runId,
    })
    .returning({ id: documentVersions.id });
  await tx.update(documents).set({ currentVersionId: version!.id }).where(eq(documents.id, doc!.id));
  return { versionId: version!.id };
}

describe("revisit stages", () => {
  it("the freeze stage plans one job on its own queue between the crawl and the text stages", async () => {
    expect(REVISIT_STAGES).toEqual([...FETCH_RUN_STAGES, REVISIT_FREEZE_STAGE, ...TEXT_RUN_STAGES]);
    expect(STAGES[REVISIT_FREEZE_STAGE]).toBe(revisitFreezeStage);
    expect(QUEUES).toContain("revisit.freeze");
    expect(HANDLERS["revisit.freeze"]).toBeTypeOf("function");
    expect(base.queues["revisit.freeze"]).toEqual({ concurrency: 1, retryLimit: 2, retryDelaySeconds: 60, retryBackoff: true });
    expect(await revisitFreezeStage.plan({} as Db, { id: newId(), params: {} })).toEqual([{ key: "freeze" }]);
  });
});

describe("startRevisitRun", () => {
  it("startRevisitRun creates a revisit run over fetch and text stages for the area", () =>
    withRollback(async (tx) => {
      setSimulationMode(false);
      const { boss, inserted } = recordingBoss();
      const a = await revisitArea(tx);
      const triggeredBy = someone();
      const { id } = await startRevisitRun(tx, boss, { areaKey: a.areaKey, triggeredBy }, a.config);
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ kind: "revisit", scopeType: "area", scopeId: a.areaKey, stages: [...REVISIT_STAGES], triggeredBy });
      expect(run!.params).toMatchObject({ areaKey: a.areaKey, rulesVersion: await activeRulesVersion(tx) });
      expect(run!.params).not.toHaveProperty("documentVersionIds");
      expect((run!.params as { sourceIds: string[] }).sourceIds).toContain(a.sourceId);
      expect(inserted.filter((j) => j.queue === "fetch.source").map((j) => j.data.sourceId)).toContain(a.sourceId);

      // a second start while the first crawls the source is refused (ruling M3-C-R6)
      await expect(startRevisitRun(tx, boss, { areaKey: a.areaKey, triggeredBy }, a.config)).rejects.toMatchObject({ reason: "source_run_active" });
    }));

  it("refuses an unknown area, an area without tiles and a bad page cap before the run exists", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      const a = await revisitArea(tx);
      const reason = (p: Promise<unknown>) => p.then(() => "started", (e: unknown) => (e instanceof RunScopeNotReady ? e.reason : String(e)));
      expect(await reason(startRevisitRun(tx, boss, { areaKey: `nope-${newId()}`, triggeredBy: "test" }, a.config))).toBe("unknown_area");
      const empty: AppConfig = { ...a.config, areas: [...a.config.areas, { ...base.areas[0]!, key: `empty-${newId()}` }] };
      expect(await reason(startRevisitRun(tx, boss, { areaKey: empty.areas.at(-1)!.key, triggeredBy: "test" }, empty))).toBe("area_without_tiles");
      expect(await reason(startRevisitRun(tx, boss, { areaKey: a.areaKey, triggeredBy: "test", maxPages: 0 }, a.config))).toMatch(/maxPages/);
      const { id } = await startRevisitRun(tx, boss, { areaKey: a.areaKey, triggeredBy: "test", maxPages: 5 }, a.config);
      expect((await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, id)))[0]!.params).toMatchObject({ maxPages: 5 });
    }));

  it("a simulated revisit has no follow-up stage, plans no geocoding and no follow-up job (ruling M7-P8)", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      const a = await revisitArea(tx);
      setSimulationMode(true);
      const { id } = await startRevisitRun(tx, boss, { areaKey: a.areaKey, triggeredBy: "test" }, a.config);
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run!.stages).toEqual(REVISIT_STAGES.filter((s) => s !== CONSOLIDATION_FOLLOWUP_STAGE));
      expect(run!.stages).toContain("mentions.geocode");
      // the simulation plans no geocoding (Nominatim) before it looks at anything; a real run reads its frozen versions
      expect(await planGeocode(tx, { id }, a.config)).toEqual([]);
      expect(await consolidationFollowupStage.plan(tx, { id, params: {} })).toEqual([]);
      setSimulationMode(false);
      await expect(planGeocode(tx, { id }, a.config)).rejects.toThrow(/frozen version set/);
      expect(await consolidationFollowupStage.plan(tx, { id, params: {} })).toEqual([{ key: "followup" }]);
    }));
});

describe("revisit.freeze", () => {
  it("freezes the pending versions and the objects of pages gone in the run's crawl, once", () =>
    withRollback(async (tx) => {
      const a = await revisitArea(tx);
      const { id: runId } = await createRun(tx, {
        kind: "revisit",
        scope: { type: "area", id: a.areaKey },
        stages: [...REVISIT_STAGES],
        params: { sourceIds: [a.sourceId], areaKey: a.areaKey },
        triggeredBy: "test",
      });
      // a page the crawl found gone: a place with a fact from it
      const { objectId: goneObject } = await insertPlace(tx, { lon: 21.02, lat: 35.21, name: "Verschwunden" });
      const m = await insertMention(tx, goneObject, { sourceId: a.sourceId });
      await insertMentionFact(tx, goneObject, m, await insertExtraction(tx, goneObject, m));
      const [doc] = await tx.select().from(documents).where(eq(documents.id, m.documentId));
      await tx.update(documents).set({ status: "gone", consecutiveGone: base.fetch.goneAfter }).where(eq(documents.id, doc!.id));
      await tx.insert(crawlFrontier).values({ sourceId: a.sourceId, url: doc!.url, urlNormalized: doc!.urlNormalized, status: "failed", reason: "HTTP 404", lastRunId: runId });
      // a page that missed once in this run is not gone yet; one gone before the run answered 404 again
      const { objectId: missedObject } = await insertPlace(tx, { lon: 21.03, lat: 35.21, name: "Verfehlt" });
      const missed = await insertMention(tx, missedObject, { sourceId: a.sourceId });
      await insertMentionFact(tx, missedObject, missed, await insertExtraction(tx, missedObject, missed));
      const [missedDoc] = await tx.update(documents).set({ consecutiveGone: 1 }).where(eq(documents.id, missed.documentId)).returning();
      await tx.insert(crawlFrontier).values({ sourceId: a.sourceId, url: missedDoc!.url, urlNormalized: missedDoc!.urlNormalized, status: "failed", reason: "HTTP 404", lastRunId: runId });
      // a version the crawl just wrote of a page that mentioned a place of the area before, and one of another run
      // (not matched either: never taken in by the database-wide pending set)
      const { geoObjectId: areaPlace } = await a.addPlace();
      await tx.insert(tileGeoObjects).values({ tileId: a.tileIds[0]!, geoObjectId: areaPlace });
      const earlier = await insertMention(tx, areaPlace, { sourceId: a.sourceId });
      const fresh = await crawledVersion(tx, a.sourceId, runId, earlier.documentId);
      const elsewhere = await crawledVersion(tx, a.sourceId, null);
      // a page of another area the same crawl wrote: neither a source of this area nor a mention of it (ruling M7-G-R4)
      const otherArea = await crawledVersion(tx, a.sourceId, runId);

      const frozen = await freezeRevisitRun(tx, runId, base);
      expect(frozen.frozenBefore).toBe(false);
      expect(frozen.documentVersionIds).toContain(fresh.versionId);
      expect(frozen.documentVersionIds).not.toContain(elsewhere.versionId);
      expect(frozen.documentVersionIds).not.toContain(otherArea.versionId);
      expect(frozen.goneGeoObjectIds).toEqual([goneObject]);
      const [run] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, runId));
      expect(run!.params).toMatchObject({ documentVersionIds: frozen.documentVersionIds, goneGeoObjectIds: [goneObject], areaKey: a.areaKey });
      // the gone page's object is a consolidation target of the run
      expect(await consolidationTargets(tx, { id: runId, params: run!.params as Record<string, unknown> })).toContain(goneObject);

      // a retried job keeps the frozen list, also when more versions arrived meanwhile
      const later = await crawledVersion(tx, a.sourceId, runId);
      const again = await freezeRevisitRun(tx, runId, base);
      expect(again).toEqual({ ...frozen, frozenBefore: true });
      expect(again.documentVersionIds).not.toContain(later.versionId);
    }));
});

describe("revisit catch-up", () => {
  it("a revisit ended before its freeze consolidates nothing of the area on catch-up (ruling M7-G-R4)", () =>
    withRollback(async (tx) => {
      setSimulationMode(false);
      const { boss, inserted } = recordingBoss();
      const a = await revisitArea(tx);
      // an object of the area's coast tile: the area-wide consolidation would take it
      const { geoObjectId } = await a.addPlace();
      await tx.insert(tileGeoObjects).values({ tileId: a.tileIds[0]!, geoObjectId });
      expect(await consolidationTargets(tx, { id: newId(), params: { areaKey: a.areaKey } }, new Date().toISOString().slice(0, 10))).toContain(geoObjectId);

      const { id } = await startRevisitRun(tx, boss, { areaKey: a.areaKey, triggeredBy: "test" }, a.config);
      // ended by the admin during the crawl: the consolidation is stored as skipped
      expect(await endRun(tx, id, "test")).toBe(true);
      expect(await markConsolidationSkipped(tx, id, "run_ended")).toBe(true);
      const [run] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, id));
      expect(await consolidationTargets(tx, { id, params: run!.params as Record<string, unknown> })).toEqual([]);
      const runCount = async () => Number((await tx.execute<{ n: number }>(sql`select count(*)::int as n from runs`)).rows[0]!.n);
      const before = await runCount();
      expect(await catchUpConsolidation(tx, boss, id, "test", { config: a.config })).toEqual({ status: "no_targets" });
      expect(await runCount()).toBe(before);
      expect(inserted.filter((j) => j.queue.startsWith("consolidation."))).toEqual([]);

      // frozen with a gone page only: just that page's object (ruling M7-P7)
      const params = { ...(run!.params as Record<string, unknown>), goneGeoObjectIds: [geoObjectId] };
      expect(await consolidationTargets(tx, { id, params })).toEqual([geoObjectId]);
    }));
});

describe("sim:revisit preflight", () => {
  it("revisit preflight fails on queued pg-boss jobs", () =>
    withRollback(
      async (tx) => {
        const a = await revisitArea(tx);
        const before = await foreignJobs(tx);
        const insertJob = (runId: string) =>
          tx.execute(sql`insert into pgboss.job (name, data, state) values ('system.ping', ${JSON.stringify({ runId, key: "x" })}::jsonb, 'created')`);
        // a job of a run this CLI started is not foreign; a waiting job of any other run is
        const sim = await createRun(tx, { kind: "revisit", scope: { type: "area", id: a.areaKey }, stages: [], params: {}, triggeredBy: SIM_TRIGGERED_BY });
        await insertJob(sim.id);
        expect(await foreignJobs(tx)).toBe(before);
        const other = await createRun(tx, { kind: "system", scope: { type: "system", id: "ping" }, stages: [], params: {}, triggeredBy: someone() });
        await insertJob(other.id);
        expect(await foreignJobs(tx)).toBe(before + 1);
        // a leftover job of an earlier sim run that failed is foreign: only a live sim run owns its jobs (ruling M7-G-R4)
        const failed = await createRun(tx, { kind: "revisit", scope: { type: "area", id: a.areaKey }, stages: [], params: {}, triggeredBy: SIM_TRIGGERED_BY });
        await insertJob(failed.id);
        expect(await foreignJobs(tx)).toBe(before + 1);
        await tx.update(runs).set({ status: "failed" }).where(eq(runs.id, failed.id));
        expect(await foreignJobs(tx)).toBe(before + 2);
        await tx.update(runs).set({ status: "running" }).where(eq(runs.id, failed.id));

        const scenario = {
          name: "t",
          entries: [{ id: "e1", url: `https://${newId()}.test.invalid/x`, edit: { op: "gone" as const }, expect: { document: "gone" as const, events: [] } }],
        };
        const problems = await revisitPreflight(tx, memoryArchive(), { areaKey: a.areaKey, scenario });
        expect(problems).toEqual([
          "keine Sim-Datenbank – scripts/sim/clone.sh",
          `${before + 1} fremde Jobs in der Warteschlange (wartend, wiederholt oder laufend) – erst abwarten oder beenden`,
          expect.stringMatching(/^Szenario-Eintrag e1: kein Dokument für /),
          `erst Paket bauen: Revier ${a.areaKey} hat keine gültige Lieferung`,
        ]);
      },
      { isolationLevel: "repeatable read" },
    ));
});
