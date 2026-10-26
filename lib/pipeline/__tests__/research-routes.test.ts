import { asc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { MockModel } from "@/lib/ai/mock";
import type { ExtractRouteInput, ExtractRouteOutput } from "@/lib/ai/tasks/extract-route";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, documents, documentVersions, pageAssessments, researchHits, researchRouteStops, serpQueries, serpResults } from "@/lib/db/schema";
import type { PageKind } from "@/lib/db/schema/research";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { activeRouteExtractor } from "@/lib/domain/research/assign";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun } from "@/lib/domain/runs";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { pollBatch } from "@/lib/pipeline/batches";
import { discoverStops, extractResearchRoutes, extractRouteBatchEntry, planResearchDiscover, planResearchRoutes, RESEARCH_DISCOVER_STAGE, RESEARCH_ROUTES_STAGE } from "@/lib/pipeline/research/routes";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertTestRun, insertTestVersion } from "@/test/text";

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const boss = { insert: async (_q: string, jobs: Array<{ id?: string }>) => jobs.map((j) => j.id ?? newId()) } as unknown as PgBoss;

const PAGE = [
  "# Two weeks around the Saronic",
  "We left Hydra on 3 June 2024 and motored to Poros.",
  "After a night at the town quay we anchored in Ormos Russian Bay, good holding in sand.",
].join("\n\n");

async function hit(tx: Db, placeId: string, geoObjectId: string, url: string) {
  const [q] = await tx
    .insert(serpQueries)
    .values({ keyword: "k", languageCode: "en", locationCode: 2300, depth: 10, level: "place", scopeId: geoObjectId, rawKey: `serp/x/${url}.json`, fetchedAt: new Date() })
    .returning({ id: serpQueries.id });
  const [r] = await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url, urlNormalized: url, domain: "test.invalid", title: "t", snippet: "s" }).returning({ id: serpResults.id });
  await tx.insert(researchHits).values({ placeId, geoObjectId, serpQueryId: q!.id, serpResultId: r!.id, urlNormalized: url, domain: "test.invalid", rank: 1, purpose: "positive" });
}

async function seed(tx: Db, pageKind: PageKind = "trip_report") {
  const poros = await insertPlace(tx, { name: "Poros", lon: 33.4, lat: 42.6, status: "candidate" });
  const v = await insertTestVersion(tx, ["x"]);
  const [doc] = await tx.select().from(documents).where(eq(documents.id, v.documentId));
  await hit(tx, poros.placeId, poros.objectId, doc!.urlNormalized);
  const { model, promptVersion } = activeAssessor(config);
  await tx.insert(pageAssessments).values({
    documentVersionId: v.versionId, model, promptVersion, pageKind, firstHand: true, generated: false,
    observedAt: "2024-06-15", observedAtBasis: "explicit", berths: [{ name: "Poros", island: null, kind: "port" }], runId: await insertTestRun(tx),
  });
  const archive = memoryArchive();
  const [row] = await tx.select({ mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, v.versionId));
  await archive.put(row!.mdKey, new TextEncoder().encode(PAGE), "text/markdown");
  return { poros: poros.placeId, versionId: v.versionId, archive };
}

function reply(): ExtractRouteOutput {
  return {
    stops: [
      { name: "Hydra", date: "2024-06-03", mooring: "unknown", quote: "We left Hydra on 3 June 2024", leg: null },
      { name: "Poros", date: null, mooring: "quay", quote: "After a night at the town quay", leg: null },
      // not in the text: dropped
      { name: "Aegina", date: null, mooring: "marina", quote: "We then sailed on to Aegina marina", leg: null },
      { name: "Russian Bay", date: null, mooring: "anchor", quote: "we anchored in Ormos Russian Bay", leg: null },
    ],
  };
}

async function runWithStage(tx: Db, placeIds: string[]): Promise<string> {
  const { id } = await createRun(tx, {
    kind: "reprocess",
    scope: { type: "system", id: `routes-${newId()}` },
    stages: [RESEARCH_ROUTES_STAGE, "test.next"],
    params: { placeIds },
    triggeredBy: "test",
  });
  await beginStage(tx, id, RESEARCH_ROUTES_STAGE, 1);
  return id;
}

describe("research.routes", () => {
  it("stores the stops of a trip report with verified quotes, in order", () =>
    withRollback(async (tx) => {
      const { poros, versionId, archive } = await seed(tx);
      const runId = await runWithStage(tx, [poros]);
      const plan = await planResearchRoutes(tx, { id: runId, params: { placeIds: [poros] } }, config);
      expect(plan).toEqual([{ key: "routes:0", versionIds: [versionId] }]);

      const model = new MockModel({ "extract-route": reply });
      const result = await extractResearchRoutes(tx, { model, boss, config, archive }, { runId, stage: RESEARCH_ROUTES_STAGE, key: "routes:0", versionIds: [versionId] });
      expect(result).toMatchObject({ submitted: 1, remainder: 0, reused: false });
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      const [request] = model.batchRequests(batch!.providerBatchId!)!;
      expect(request!.input as ExtractRouteInput).toMatchObject({ section: 1, sections: 1, observedAt: "2024-06-15", maxStops: config.research.extraction.routeMaxStops, text: PAGE });

      expect(await pollBatch(tx, { model, boss, config, handlers: BATCH_HANDLERS }, batch!.id)).toBe("distributed");
      const stops = await tx.select().from(researchRouteStops).where(eq(researchRouteStops.documentVersionId, versionId)).orderBy(asc(researchRouteStops.seq));
      const { model: routeModel, promptVersion } = activeRouteExtractor(config);
      expect(stops.map((s) => [s.seq, s.name, s.mooringKind, s.observedAt, s.placeId, s.model, s.promptVersion])).toEqual([
        [0, "Hydra", "unknown", "2024-06-03", null, routeModel, promptVersion],
        [1, "Poros", "quay", "2024-06-15", null, routeModel, promptVersion],
        [2, "Russian Bay", "anchor", "2024-06-15", null, routeModel, promptVersion],
      ]);

      // routed: not planned again
      expect(await planResearchRoutes(tx, { id: runId, params: { placeIds: [poros] } }, config)).toEqual([]);
      expect(BATCH_HANDLERS["extract-route"]!.task).toBe(extractRouteBatchEntry.task);

      // discovery: one job for the page, Poros found by name, the other stops stay open
      const discover = await planResearchDiscover(tx, { id: runId, params: { placeIds: [poros] } }, config);
      expect(discover).toEqual([{ key: versionId, documentVersionId: versionId }]);
      expect(await discoverStops(tx, { runId, stage: RESEARCH_DISCOVER_STAGE, key: versionId, documentVersionId: versionId }, config)).toEqual({ byName: 1, byCorridor: 0, open: 2 });
      const [assigned] = await tx.select().from(researchRouteStops).where(eq(researchRouteStops.placeId, poros));
      expect(assigned).toMatchObject({ name: "Poros", match: "name" });
    }));

  it("does not plan a page again whose answer had no verifiable stop", () =>
    withRollback(async (tx) => {
      const { poros, versionId, archive } = await seed(tx);
      const runId = await runWithStage(tx, [poros]);
      const model = new MockModel({ "extract-route": () => ({ stops: [] }) });
      await extractResearchRoutes(tx, { model, boss, config, archive }, { runId, stage: RESEARCH_ROUTES_STAGE, key: "routes:0", versionIds: [versionId] });
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      // while the batch is open the page is not planned (another run must not send it twice)
      expect(await planResearchRoutes(tx, { id: runId, params: { placeIds: [poros] } }, config)).toEqual([]);
      expect(await pollBatch(tx, { model, boss, config, handlers: BATCH_HANDLERS }, batch!.id)).toBe("distributed");
      expect(await tx.select().from(researchRouteStops).where(eq(researchRouteStops.documentVersionId, versionId))).toEqual([]);
      expect(await planResearchRoutes(tx, { id: runId, params: { placeIds: [poros] } }, config)).toEqual([]);
    }));

  it("plans nothing for a forum page", () =>
    withRollback(async (tx) => {
      const { poros } = await seed(tx, "forum");
      const runId = await insertTestRun(tx);
      expect(await planResearchRoutes(tx, { id: runId, params: { placeIds: [poros] } }, config)).toEqual([]);
    }));
});
