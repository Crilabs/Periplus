import { and, eq, inArray, ne } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConverters } from "@/lib/adapters/fetch";
import { createGuardedAgent, createGuardedTransport } from "@/lib/adapters/fetch/guarded";
import { makeResponse, type Transport } from "@/lib/adapters/http";
import { MockModel } from "@/lib/ai/mock";
import { getConfig, loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { aiBatches, documents, pageAssessments, places, researchHits, researchRouteStops, researchUnits, reviewDecisions, runs, runStages } from "@/lib/db/schema";
import type { ExtractBerthInput, ExtractBerthOutput } from "@/lib/ai/tasks/extract-berth";
import type { ExtractRouteInput, ExtractRouteOutput } from "@/lib/ai/tasks/extract-route";
import { confirmAndFollowUp } from "@/lib/jobs/handlers/research-confirm";
import { createLogger } from "@/lib/logger";
import { researchChanges } from "@/lib/pipeline/research/confirm";
import { extractUnits } from "@/lib/pipeline/research/extract";
import { discoverStops, extractResearchRoutes } from "@/lib/pipeline/research/routes";
import { newId } from "@/lib/domain/ids";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { HANDLERS } from "@/lib/jobs/registry";
import { QUEUES } from "@/lib/jobs/queues";
import { STAGES } from "@/lib/jobs/stages";
import { pollBatch } from "@/lib/pipeline/batches";
import type { FetchUrlDeps } from "@/lib/pipeline/fetch/url";
import { RESEARCH_ASSESS_STAGE, assessPages } from "@/lib/pipeline/research/assess";
import { RESEARCH_CONFIRM_STAGE } from "@/lib/pipeline/research/confirm";
import { RESEARCH_EXTRACT_STAGE } from "@/lib/pipeline/research/extract";
import { RESEARCH_DISCOVER_STAGE, RESEARCH_ROUTES_STAGE } from "@/lib/pipeline/research/routes";
import { RESEARCH_FETCH_STAGE, fetchResearchPage } from "@/lib/pipeline/research/fetch";
import { RESEARCH_SEARCH_STAGE, searchCandidate } from "@/lib/pipeline/research/search";
import { RUN_SCOPE_REASON_LABELS } from "@/app/(admin)/_components/labels";
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

/** The research config with the reference gate released: starts of any subdivision are allowed. */
const openGate = { research: { ...config.research, gate: { ...config.research.gate, released: true, chosenThreshold: 2 } } };
const closedGate = (subdivision: string) => ({ research: { ...config.research, gate: { ...config.research.gate, subdivision, released: false, chosenThreshold: null } } });

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
  it("registers the eight stages and queues, in order", () => {
    expect(RESEARCH_STAGES).toEqual([
      RESEARCH_SEARCH_STAGE,
      RESEARCH_FETCH_STAGE,
      RESEARCH_ASSESS_STAGE,
      RESEARCH_EXTRACT_STAGE,
      RESEARCH_ROUTES_STAGE,
      RESEARCH_DISCOVER_STAGE,
      RESEARCH_CONFIRM_STAGE,
      "research.state",
    ]);
    expect([...RESEARCH_STAGES]).toEqual(["research.search", "research.fetch", "research.assess", "research.extract", "research.routes", "research.discover", "research.confirm", "research.state"]);
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
      const { id: runId } = await startResearchRun(tx, boss, { subdivisionKey: "GR-XR2" }, "test", openGate);

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
      expect(await tx.select().from(researchHits).where(eq(researchHits.urlNormalized, url))).toHaveLength(4); // per candidate and purpose

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
      const { id } = await startResearchRun(tx, boss, { placeIds: [placeId!] }, "test", openGate);
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ kind: "stage", scopeType: "system", scopeId: "places", params: { placeIds: [placeId] } });
      expect(inserted).toHaveLength(1);
    }));

  it("refuses a subdivision or place list without candidates, and an unknown subdivision", () =>
    withRollback(async (tx) => {
      await insertTestSubdivision(tx, "GR-XR4", [21.0, 35.0, 21.5, 35.5], { country: "GR" });
      const { boss, inserted } = recordingBoss();
      await expect(startResearchRun(tx, boss, { subdivisionKey: "GR-XR4" }, "test", openGate)).rejects.toMatchObject({ reason: "no_research_candidates" });
      await expect(startResearchRun(tx, boss, { placeIds: [newId()] }, "test", openGate)).rejects.toMatchObject({ reason: "no_research_candidates" });
      await expect(startResearchRun(tx, boss, { subdivisionKey: "XD-NOPE" }, "test", openGate)).rejects.toThrow("Unbekannter Landesteil XD-NOPE");
      expect(inserted).toEqual([]);
    }));

  it("refuses a second run of the same scope while one is queued or running, but not another scope or after its end", () =>
    withRollback(async (tx) => {
      const [a, b] = await seedCandidates(tx, "GR-XR5");
      const { boss, inserted } = recordingBoss();
      const first = await startResearchRun(tx, boss, { subdivisionKey: "GR-XR5" }, "test", openGate);
      const count = inserted.length;
      const refused = startResearchRun(tx, boss, { subdivisionKey: "GR-XR5" }, "test", openGate);
      await expect(refused).rejects.toBeInstanceOf(RunScopeNotReady);
      await expect(refused).rejects.toMatchObject({ reason: "research_run_active" });
      expect(inserted).toHaveLength(count);
      // a place list is another scope; a second list sharing a place is refused, a disjoint one is not
      const list = await startResearchRun(tx, boss, { placeIds: [a!] }, "test", openGate);
      await expect(startResearchRun(tx, boss, { placeIds: [a!, b!] }, "test", openGate)).rejects.toMatchObject({ reason: "research_run_active" });
      await expect(startResearchRun(tx, boss, { placeIds: [b!] }, "test", openGate)).resolves.toBeDefined();
      // once the run ended a new one starts
      await tx.update(runs).set({ status: "finished", finishedAt: new Date() }).where(eq(runs.id, first.id));
      await expect(startResearchRun(tx, boss, { subdivisionKey: "GR-XR5" }, "test", openGate)).resolves.toBeDefined();
      expect(list.id).not.toBe(first.id);
    }));

  it("the gate switch: while closed only the gate subdivision (or its places) may be researched, once released any (N3)", () =>
    withRollback(async (tx) => {
      const [inGate] = await seedCandidates(tx, "GR-XG1", ["Vathi"]);
      const [outside] = await seedCandidates(tx, "GR-XG2", ["Kalo"]);
      const { boss, inserted } = recordingBoss();
      const closed = closedGate("GR-XG1");
      const refused = startResearchRun(tx, boss, { subdivisionKey: "GR-XG2" }, "test", closed);
      await expect(refused).rejects.toBeInstanceOf(RunScopeNotReady);
      await expect(refused).rejects.toMatchObject({ reason: "research_gate_closed" });
      await expect(startResearchRun(tx, boss, { placeIds: [outside!] }, "test", closed)).rejects.toMatchObject({ reason: "research_gate_closed" });
      await expect(startResearchRun(tx, boss, { placeIds: [inGate!, outside!] }, "test", closed)).rejects.toMatchObject({ reason: "research_gate_closed" });
      expect(inserted).toEqual([]);
      await expect(startResearchRun(tx, boss, { subdivisionKey: "GR-XG1" }, "test", closed)).resolves.toBeDefined();
      await expect(startResearchRun(tx, boss, { placeIds: [inGate!] }, "test", closed)).resolves.toBeDefined();
      await expect(startResearchRun(tx, boss, { subdivisionKey: "GR-XG2" }, "test", openGate)).resolves.toBeDefined();
      await expect(startResearchRun(tx, boss, { placeIds: [outside!] }, "test", openGate)).resolves.toBeDefined();
    }));

  it("with the committed config the gate is closed: another subdivision is refused before any lookup (N3)", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      expect(config.research.gate).toMatchObject({ subdivision: "GR-I", released: false });
      await expect(startResearchRun(tx, boss, { subdivisionKey: "GR-J" }, "test")).rejects.toMatchObject({ reason: "research_gate_closed" });
    }));

  it("while the gate is closed a place list with a place that has no subdivision is refused", () =>
    withRollback(async (tx) => {
      const [inGate] = await seedCandidates(tx, "GR-XG3", ["Vathi"]);
      const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name: "Loose" }], lon: 21.2, lat: 35.2 });
      const [loose] = await tx
        .insert(places)
        .values({ geoObjectId: objectId, kind: "anchorage", status: "candidate", position: geomFromGeoJson({ type: "Point", coordinates: [21.2, 35.2] }) })
        .returning({ id: places.id });
      const { boss } = recordingBoss();
      const closed = closedGate("GR-XG3");
      await expect(startResearchRun(tx, boss, { placeIds: [inGate!, loose!.id] }, "test", closed)).rejects.toMatchObject({ reason: "research_gate_closed" });
      await expect(startResearchRun(tx, boss, { placeIds: [inGate!] }, "test", closed)).resolves.toBeDefined();
    }));

  it("the gate switch's German label exists", () => {
    expect(RUN_SCOPE_REASON_LABELS.research_gate_closed).toBe("Recherche erst nach bestandenem Navily-Test für weitere Landesteile");
  });

  it("runs all seven stages; a second run extracts only the pages discovery linked and changes nothing more (final review 4)", () =>
    withRollback(async (tx) => {
      const [vathi, kalo] = await seedCandidates(tx, "GR-XR6");
      const port = new URL(site.origin).port;
      const host = () => `${newId()}.invalid`;
      // two trip reports of Vathi on two domains, in their own words; only the first sails on to Kalo
      const pageA = { host: host(), text: "We anchored in Vathi in June 2024, good holding in sand. Next day we sailed to Kalo and anchored there for lunch." };
      const pageB = { host: host(), text: "Spent two nights at anchor in Vathi in July 2024, the holding was superb and the water clear." };
      const urlOf = (p: { host: string }) => `http://${p.host}:${port}/trip`;
      for (const p of [pageA, pageB]) {
        site.set("/trip", { body: `<!doctype html><html><head><title>Trip</title></head><body><article><h1>Trip</h1>${`<p>${p.text}</p>`.repeat(3)}</article></body></html>`, headers: { "content-type": "text/html; charset=utf-8" } }, p.host);
      }
      // the SERP finds both pages for Vathi's searches, nothing for Kalo's
      const transport: Transport = async (req) => {
        const keyword = (JSON.parse(String(req.body)) as Array<{ keyword: string }>)[0]!.keyword;
        return makeResponse(200, serp(keyword.includes("Vathi") ? [urlOf(pageA), urlOf(pageB)] : []));
      };
      const archive = memoryArchive();
      const model = new MockModel({
        "assess-page": () => ({
          page_kind: "trip_report", first_hand: true, generated: false, language: "en", observed_at: "2024-06", observed_at_explicit: true,
          observed_at_reason: "in June 2024", berths: [{ name: "Vathi", island: null, kind: "anchorage" }],
        }),
        "extract-route": (input): ExtractRouteOutput => {
          const { text } = input as ExtractRouteInput;
          const stops: ExtractRouteOutput["stops"] = [];
          if (text.includes("We anchored in Vathi")) stops.push({ name: "Vathi", date: "2024-06-15", mooring: "anchor", quote: "We anchored in Vathi in June 2024", leg: null });
          if (text.includes("at anchor in Vathi")) stops.push({ name: "Vathi", date: "2024-07-15", mooring: "anchor", quote: "Spent two nights at anchor in Vathi", leg: null });
          if (text.includes("sailed to Kalo")) stops.push({ name: "Kalo", date: null, mooring: "anchor", quote: "Next day we sailed to Kalo and anchored there", leg: null });
          return { stops };
        },
        "extract-berth": (input): ExtractBerthOutput => {
          const { berth, text } = input as ExtractBerthInput;
          const signal = (quote: string) => ({ core: [], facts: [], landing: [], signals: [{ kind: "anchored" as const, first_hand: true, confidence: 0.9, quote, observed_at: null }] });
          if (berth.name === "Kalo") return signal("we sailed to Kalo and anchored there");
          return signal(text.includes("We anchored in Vathi") ? "We anchored in Vathi in June 2024" : "Spent two nights at anchor in Vathi");
        },
      });
      const fetchDeps: FetchUrlDeps = {
        transport: siteTransport,
        archive,
        converters: createConverters({ transport: noNetwork, cfg: getConfig().fetch }),
        pdf: { pdftotext: async () => "" },
        isAllowed: async () => true,
        enqueue: async () => 0,
      };
      const deps = { model, boss: recordingBoss().boss, config, archive };
      const pollAll = async (runId: string) => {
        for (const b of await tx.select().from(aiBatches).where(and(eq(aiBatches.runId, runId), ne(aiBatches.status, "distributed")))) {
          expect(await pollBatch(tx, { model, boss: deps.boss, config, handlers: BATCH_HANDLERS }, b.id)).toBe("distributed");
        }
      };

      /** One research run through its seven stages; returns its id and the units its extraction planned. */
      async function researchRun(searchTransport: Transport) {
        const { boss, inserted } = recordingBoss();
        const { id: runId } = await startResearchRun(tx, boss, { subdivisionKey: "GR-XR6" }, "test", openGate);
        const jobs = async (stage: string) => {
          inserted.length = 0;
          await enqueueStage(tx, boss, runId, stage);
          return inserted.filter((j) => j.queue === stage).map((j) => j.data);
        };
        for (const job of inserted.filter((j) => j.queue === RESEARCH_SEARCH_STAGE)) {
          await searchCandidate(tx, job.data.placeId as string, { transport: searchTransport, archive }, { db: tx, runId, stage: RESEARCH_SEARCH_STAGE });
        }
        for (const job of await jobs(RESEARCH_FETCH_STAGE)) {
          await fetchResearchPage(tx, job.url as string, fetchDeps, { db: tx, runId, stage: RESEARCH_FETCH_STAGE });
        }
        for (const job of await jobs(RESEARCH_ASSESS_STAGE)) {
          await assessPages(tx, { ...deps, boss }, { runId, stage: RESEARCH_ASSESS_STAGE, key: job.key as string, documentVersionIds: job.documentVersionIds as string[] });
        }
        await pollAll(runId);
        const extractJobs = await jobs(RESEARCH_EXTRACT_STAGE);
        for (const job of extractJobs) {
          await extractUnits(tx, { ...deps, boss }, { runId, stage: RESEARCH_EXTRACT_STAGE, key: job.key as string, unitIds: job.unitIds as string[] });
        }
        await pollAll(runId);
        for (const job of await jobs(RESEARCH_ROUTES_STAGE)) {
          await extractResearchRoutes(tx, { ...deps, boss }, { runId, stage: RESEARCH_ROUTES_STAGE, key: job.key as string, versionIds: job.versionIds as string[] });
        }
        await pollAll(runId);
        for (const job of await jobs(RESEARCH_DISCOVER_STAGE)) {
          await discoverStops(tx, { runId, stage: RESEARCH_DISCOVER_STAGE, key: job.key as string, documentVersionId: job.documentVersionId as string }, config);
        }
        const [confirmJob] = await jobs(RESEARCH_CONFIRM_STAGE);
        await confirmAndFollowUp({ runId, stage: RESEARCH_CONFIRM_STAGE, key: confirmJob!.key as string }, { db: tx, boss, log: createLogger("test"), jobId: newId() });
        await tx.update(runs).set({ status: "finished", finishedAt: new Date() }).where(eq(runs.id, runId));
        return { runId, unitIds: extractJobs.flatMap((j) => j.unitIds as string[]) };
      }
      const placeOfUnits = async (ids: string[]) =>
        ids.length === 0 ? [] : (await tx.select({ placeId: researchUnits.placeId }).from(researchUnits).where(inArray(researchUnits.id, ids))).map((u) => u.placeId).sort();

      // run 1: Vathi's two pages are extracted for Vathi only, the route links page A to Kalo, Vathi is confirmed
      const first = await researchRun(transport);
      expect(await placeOfUnits(first.unitIds)).toEqual([vathi, vathi]);
      const kaloStops = await tx.select().from(researchRouteStops).where(eq(researchRouteStops.placeId, kalo!));
      expect(kaloStops.map((s) => [s.name, s.match])).toEqual([["Kalo", "name"]]);
      const statusOf = async (id: string) => (await tx.select({ status: places.status }).from(places).where(eq(places.id, id)))[0]!.status;
      expect([await statusOf(vathi!), await statusOf(kalo!)]).toEqual(["confirmed", "candidate"]);
      expect(await researchChanges(tx, first.runId)).toMatchObject({ confirmed: [vathi] });
      const decisions = (await tx.select().from(reviewDecisions)).length;

      // run 2: the SERP is reused (no network), nothing is fetched or assessed again, only Kalo's unit on page A is
      // extracted (one source, still a candidate), and confirm changes nothing
      const second = await researchRun(noNetwork);
      const [pageAVersion] = await tx.select({ id: documents.currentVersionId }).from(documents).where(eq(documents.urlNormalized, urlOf(pageA)));
      const units = await tx.select().from(researchUnits).where(inArray(researchUnits.id, second.unitIds));
      expect(units.map((u) => [u.placeId, u.documentVersionId, u.status])).toEqual([[kalo, pageAVersion!.id, "done"]]);
      expect([await statusOf(vathi!), await statusOf(kalo!)]).toEqual(["confirmed", "candidate"]);
      expect(await researchChanges(tx, second.runId)).toEqual({ changed: [], confirmed: [] });
      expect((await tx.select().from(reviewDecisions)).length).toBe(decisions);
      expect((await tx.select({ statusReason: places.statusReason }).from(places).where(eq(places.id, kalo!)))[0]!.statusReason).toBe("1 von 2 unabhängigen Quellen");
    }));
});
