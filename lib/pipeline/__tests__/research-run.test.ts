import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConverters } from "@/lib/adapters/fetch";
import { createGuardedAgent, createGuardedTransport } from "@/lib/adapters/fetch/guarded";
import { makeResponse, type Transport } from "@/lib/adapters/http";
import { MockModel } from "@/lib/ai/mock";
import { getConfig, loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { aiBatches, documents, pageAssessments, places, researchHits, runs, runStages } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { HANDLERS } from "@/lib/jobs/registry";
import { QUEUES } from "@/lib/jobs/queues";
import { STAGES } from "@/lib/jobs/stages";
import { pollBatch } from "@/lib/pipeline/batches";
import type { FetchUrlDeps } from "@/lib/pipeline/fetch/url";
import { RESEARCH_ASSESS_STAGE, assessPages } from "@/lib/pipeline/research/assess";
import { RESEARCH_FETCH_STAGE, fetchResearchPage } from "@/lib/pipeline/research/fetch";
import { RESEARCH_SEARCH_STAGE, searchCandidate } from "@/lib/pipeline/research/search";
import { RESEARCH_STAGES, startResearchRun } from "@/lib/pipeline/research-run";
import { enqueueStage } from "@/lib/pipeline/runs";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { startSiteServer, type SiteServer } from "@/test/site-server";
import { insertNamedObject, insertTestSubdivision, insertTestTile } from "@/test/text";

let site: SiteServer;
const agent = createGuardedAgent({ resolveAll: async () => [{ address: "127.0.0.1", family: 4 }], isAllowedAddress: () => true });
const siteTransport = createGuardedTransport(agent);
beforeAll(async () => {
  site = await startSiteServer();
});
afterAll(async () => {
  await site.close();
  await agent.close();
});

const noNetwork: Transport = async (req) => {
  throw new Error(`unexpected request ${req.url}`);
};
const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };

function recordingBoss() {
  const inserted: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const boss = {
    insert: async (queue: string, jobs: Array<{ id?: string; data: Record<string, unknown> }>) => {
      inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
      return jobs.map((j) => j.id ?? newId());
    },
  } as unknown as PgBoss;
  return { boss, inserted };
}

const serp = (urls: string[]) =>
  new TextEncoder().encode(
    JSON.stringify({
      status_code: 20000,
      status_message: "Ok.",
      tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.002, result: [{ items: urls.map((url, i) => ({ type: "organic", rank_group: i + 1, rank_absolute: i + 1, url, title: `T${i}`, description: `S${i}` })) }] }],
    }),
  );

async function seedCandidates(tx: Db, key: string, names: string[] = ["Vathi", "Kalo"]): Promise<string[]> {
  const sub = await insertTestSubdivision(tx, key, [21.0, 35.0, 21.5, 35.5], { country: "GR" });
  await insertTestTile(tx, "q025:84:140", null, sub.id);
  const ids: string[] = [];
  for (const [i, name] of names.entries()) {
    const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name, language: "en" }], lon: 21.1 + i / 100, lat: 35.2, subdivisionId: sub.id });
    const [place] = await tx
      .insert(places)
      .values({ geoObjectId: objectId, kind: "anchorage", status: "candidate", position: geomFromGeoJson({ type: "Point", coordinates: [21.1 + i / 100, 35.2] }) })
      .returning({ id: places.id });
    ids.push(place!.id);
  }
  return ids;
}

const PAGE = {
  body: `<!doctype html><html><head><title>Vathi</title></head><body><article><h1>Vathi</h1>${"<p>We anchored in Vathi in June 2024, good holding in sand.</p>".repeat(20)}</article></body></html>`,
  headers: { "content-type": "text/html; charset=utf-8" },
};

describe("research run", () => {
  it("registers the three stages and queues", () => {
    expect(RESEARCH_STAGES).toEqual([RESEARCH_SEARCH_STAGE, RESEARCH_FETCH_STAGE, RESEARCH_ASSESS_STAGE]);
    for (const name of RESEARCH_STAGES) {
      expect(STAGES[name]?.queue).toBe(name);
      expect(QUEUES).toContain(name);
      expect(HANDLERS[name as keyof typeof HANDLERS]).toBeTypeOf("function");
      expect(getConfig().queues[name]).toBeDefined();
    }
  });

  it("starts the run for a subdivision and carries it through search, fetch and assess", () =>
    withRollback(async (tx) => {
      const placeIds = await seedCandidates(tx, "GR-XR2");
      const { boss, inserted } = recordingBoss();
      const { id: runId } = await startResearchRun(tx, boss, { subdivisionKey: "GR-XR2" }, "test");

      const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
      expect(run).toMatchObject({ kind: "stage", scopeType: "subdivision", scopeId: "GR-XR2", params: { subdivisionKey: "GR-XR2" } });
      const stages = await tx.select().from(runStages).where(eq(runStages.runId, runId));
      expect(stages.sort((a, b) => a.ordinal - b.ordinal).map((s) => s.stage)).toEqual([...RESEARCH_STAGES]);
      expect(inserted.map((j) => j.queue)).toEqual(["research.search", "research.search"]);
      expect(inserted.map((j) => j.data.placeId).sort()).toEqual([...placeIds].sort());

      // search
      const s = (p: string) => `http://${newId()}.invalid:${new URL(site.origin).port}${p}`;
      const url = s("/vathi");
      site.set(new URL(url).pathname, PAGE, new URL(url).host.split(":")[0]);
      const transport: Transport = async () => makeResponse(200, serp([url]));
      const archive = memoryArchive();
      for (const job of inserted) {
        await searchCandidate(tx, job.data.placeId as string, { transport, archive }, { db: tx, runId, stage: RESEARCH_SEARCH_STAGE });
      }
      expect(await tx.select().from(researchHits).where(eq(researchHits.urlNormalized, url))).toHaveLength(4) // per candidate and purpose;

      // fetch
      inserted.length = 0;
      await enqueueStage(tx, boss, runId, RESEARCH_FETCH_STAGE);
      expect(inserted.map((j) => j.queue)).toEqual(["research.fetch"]);
      const fetchDeps: FetchUrlDeps = {
        transport: siteTransport,
        archive,
        converters: createConverters({ transport: noNetwork, cfg: getConfig().fetch }),
        pdf: { pdftotext: async () => "" },
        isAllowed: async () => true,
        enqueue: async () => 0,
      };
      expect((await fetchResearchPage(tx, inserted[0]!.data.url as string, fetchDeps, { db: tx, runId, stage: RESEARCH_FETCH_STAGE })).outcome).toBe("stored");
      expect(await tx.select().from(documents).where(eq(documents.url, url))).toHaveLength(1);

      // assess
      inserted.length = 0;
      await enqueueStage(tx, boss, runId, RESEARCH_ASSESS_STAGE);
      expect(inserted.map((j) => j.queue)).toEqual(["research.assess"]);
      const model = new MockModel({
        "assess-page": () => ({
          page_kind: "trip_report", first_hand: true, generated: false, language: "en", observed_at: "2024-06",
          observed_at_explicit: true, observed_at_reason: "We anchored in Vathi in June 2024.",
          berths: [{ name: "Vathi", island: null, kind: "anchorage" }],
        }),
      });
      const job = inserted[0]!.data as { key: string; documentVersionIds: string[] };
      await assessPages(tx, { model, boss, config, archive }, { runId, stage: RESEARCH_ASSESS_STAGE, key: job.key, documentVersionIds: job.documentVersionIds });
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      await pollBatch(tx, { model, boss, config, handlers: BATCH_HANDLERS }, batch!.id);
      expect(await tx.select().from(pageAssessments).where(eq(pageAssessments.documentVersionId, job.documentVersionIds[0]!))).toHaveLength(1);
    }));

  it("starts a run for a place list in the system scope `places`", () =>
    withRollback(async (tx) => {
      const [placeId] = await seedCandidates(tx, "GR-XR3", ["Vathi"]);
      const { boss, inserted } = recordingBoss();
      const { id } = await startResearchRun(tx, boss, { placeIds: [placeId!] }, "test");
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ kind: "stage", scopeType: "system", scopeId: "places", params: { placeIds: [placeId] } });
      expect(inserted).toHaveLength(1);
    }));

  it("refuses a subdivision or place list without candidates, and an unknown subdivision", () =>
    withRollback(async (tx) => {
      await insertTestSubdivision(tx, "GR-XR4", [21.0, 35.0, 21.5, 35.5], { country: "GR" });
      const { boss, inserted } = recordingBoss();
      await expect(startResearchRun(tx, boss, { subdivisionKey: "GR-XR4" }, "test")).rejects.toBeInstanceOf(RunScopeNotReady);
      await expect(startResearchRun(tx, boss, { placeIds: [newId()] }, "test")).rejects.toBeInstanceOf(RunScopeNotReady);
      await expect(startResearchRun(tx, boss, { subdivisionKey: "XD-NOPE" }, "test")).rejects.toThrow("Unbekannter Landesteil XD-NOPE");
      expect(inserted).toEqual([]);
    }));
});
