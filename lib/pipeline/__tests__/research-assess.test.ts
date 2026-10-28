import { eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { makeResponse, type Transport } from "@/lib/adapters/http";
import { MockModel } from "@/lib/ai/mock";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { documents, documentVersions, pageAssessments, places } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun } from "@/lib/domain/runs";
import { ensureResearchSource } from "@/lib/domain/research/sources";
import { registrableDomain } from "@/lib/domain/sources/urls";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { pollBatch } from "@/lib/pipeline/batches";
import { assessPageBatchEntry, assessPages, planResearchAssess, RESEARCH_ASSESS_STAGE } from "@/lib/pipeline/research/assess";
import { searchCandidate } from "@/lib/pipeline/research/search";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertNamedObject, insertTestCountry, insertTestRun, insertTestSubdivision, insertTestTile, insertTestVersion } from "@/test/text";

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const boss = { insert: async (_q: string, jobs: Array<{ id?: string }>) => jobs.map((j) => j.id ?? newId()) } as unknown as PgBoss;

const answer = (urls: string[]) =>
  new TextEncoder().encode(
    JSON.stringify({
      status_code: 20000,
      status_message: "Ok.",
      tasks: [{ status_code: 20000, status_message: "Ok.", cost: 0.002, result: [{ items: urls.map((url, i) => ({ type: "organic", rank_group: i + 1, rank_absolute: i + 1, url, title: `T${i}`, description: `S${i}` })) }] }],
    }),
  );

/** Two candidates which both hit every URL; a document (with archived Markdown) per URL. */
async function seed(tx: Db, urls: string[], markdown: (url: string) => string = () => "# Vathi\n\nWe anchored in Vathi in June 2024.") {
  const sub = await insertTestSubdivision(tx, "GR-XR1", [21.0, 35.0, 21.5, 35.5], { country: "GR" });
  await insertTestCountry(tx);
  await insertTestTile(tx, "q025:84:140", null, sub.id);
  const placeIds: string[] = [];
  for (const [i, name] of ["Vathi", "Kalo"].entries()) {
    const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name, language: "en" }], lon: 21.1 + i / 100, lat: 35.2, subdivisionId: sub.id });
    const [place] = await tx
      .insert(places)
      .values({ geoObjectId: objectId, kind: "anchorage", status: "candidate", position: geomFromGeoJson({ type: "Point", coordinates: [21.1 + i / 100, 35.2] }) })
      .returning({ id: places.id });
    placeIds.push(place!.id);
  }
  const runId = await insertTestRun(tx);
  const transport: Transport = async () => makeResponse(200, answer(urls));
  for (const id of placeIds) await searchCandidate(tx, id, { transport, archive: memoryArchive() }, { db: tx, runId });
  const archive = memoryArchive();
  const versions: Record<string, string> = {};
  for (const url of urls) {
    const sourceId = (await ensureResearchSource(tx, registrableDomain(url))).id;
    const [doc] = await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "other" }).returning({ id: documents.id });
    const v = await insertTestVersion(tx, ["text"], { sourceId, documentId: doc!.id });
    const [row] = await tx.select({ mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, v.versionId));
    await archive.put(row!.mdKey, new TextEncoder().encode(markdown(url)), "text/markdown");
    versions[url] = v.versionId;
  }
  return { placeIds, versions, archive };
}

const reply = (kind = "trip_report") => () => ({
  page_kind: kind,
  first_hand: true,
  generated: false,
  language: "en",
  observed_at: "2024-06",
  observed_at_explicit: true,
  observed_at_reason: "We anchored in Vathi in June 2024.",
  berths: [{ name: "Vathi", island: null, kind: "anchorage" }],
});

async function runWithStage(tx: Db): Promise<string> {
  const { id } = await createRun(tx, { kind: "reprocess", scope: { type: "system", id: `assess-${newId()}` }, stages: [RESEARCH_ASSESS_STAGE, "test.next"], triggeredBy: "test" });
  await beginStage(tx, id, RESEARCH_ASSESS_STAGE, 1);
  return id;
}

describe("research.assess", () => {
  it("plans only unassessed current versions, a shared hit once", () =>
    withRollback(async (tx) => {
      const urls = ["https://a.example/one", "https://b.example/two"];
      const { placeIds, versions } = await seed(tx, urls);
      const runId = await insertTestRun(tx);
      const plan = await planResearchAssess(tx, { id: runId, params: { placeIds } }, config);
      expect(plan).toHaveLength(1);
      expect(plan[0]!.key).toBe("assess:0");
      expect([...(plan[0]!.documentVersionIds as string[])].sort()).toEqual(Object.values(versions).sort());

      await tx.insert(pageAssessments).values({
        documentVersionId: versions[urls[0]!]!, model: "claude-sonnet-5-5", promptVersion: 1, pageKind: "other", firstHand: false, generated: false,
        observedAt: "2026-10-23", observedAtBasis: "fetched", berths: [],
      });
      const again = await planResearchAssess(tx, { id: runId, params: { placeIds } }, config);
      expect(again[0]!.documentVersionIds).toEqual([versions[urls[1]!]]);
    }));

  it("ignores superseded versions", () =>
    withRollback(async (tx) => {
      const { placeIds, versions } = await seed(tx, ["https://a.example/one"]);
      const [doc] = await tx.select({ id: documents.id }).from(documents).where(eq(documents.urlNormalized, "https://a.example/one"));
      const newer = await insertTestVersion(tx, ["newer"], { documentId: doc!.id });
      const plan = await planResearchAssess(tx, { id: await insertTestRun(tx), params: { placeIds } }, config);
      expect(plan[0]!.documentVersionIds).toEqual([newer.versionId]);
      expect(Object.values(versions)).not.toContain(newer.versionId);
    }));

  it("submits one batch and the poll stores one assessment per version (a PDF's Markdown like HTML)", () =>
    withRollback(async (tx) => {
      const urls = ["https://a.example/one", "https://b.example/guide.pdf"];
      const { placeIds, versions, archive } = await seed(tx, urls, (u) => (u.endsWith(".pdf") ? "# Cruising guide\n\nVathi: good holding." : "# Vathi\n\nWe anchored."));
      const runId = await runWithStage(tx);
      const model = new MockModel({ "assess-page": reply() });
      const [job] = await planResearchAssess(tx, { id: runId, params: { placeIds } }, config);
      const result = await assessPages(tx, { model, boss, config, archive }, { runId, stage: RESEARCH_ASSESS_STAGE, key: job!.key as string, documentVersionIds: job!.documentVersionIds as string[] });
      expect(result).toMatchObject({ submitted: 2, remainder: 0, reused: false });

      const { aiBatches } = await import("@/lib/db/schema");
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      expect(BATCH_HANDLERS["assess-page"]).toBe(assessPageBatchEntry);
      const handlers = BATCH_HANDLERS;
      expect(await pollBatch(tx, { model, boss, config, handlers }, batch!.id)).toBe("distributed");

      const rows = await tx.select().from(pageAssessments).where(inArray(pageAssessments.documentVersionId, Object.values(versions)));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ model: "claude-sonnet-5-5", promptVersion: 1, pageKind: "trip_report", berths: [{ name: "Vathi", island: null, kind: "anchorage" }] });
      expect(await planResearchAssess(tx, { id: runId, params: { placeIds } }, config)).toEqual([]);
    }));

  it("drops a result of a model that is no longer the active one", () =>
    withRollback(async (tx) => {
      const { placeIds, versions, archive } = await seed(tx, ["https://a.example/one"]);
      const runId = await runWithStage(tx);
      const model = new MockModel({ "assess-page": reply() });
      const [job] = await planResearchAssess(tx, { id: runId, params: { placeIds } }, config);
      await assessPages(tx, { model, boss, config, archive }, { runId, stage: RESEARCH_ASSESS_STAGE, key: "assess:0", documentVersionIds: job!.documentVersionIds as string[] });
      const { aiBatches } = await import("@/lib/db/schema");
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      const changed: AppConfig = { ...config, models: { ...config.models, tasks: { ...config.models.tasks, "assess-page": { ...config.models.tasks["assess-page"]!, promptVersion: 2 } } } };
      await pollBatch(tx, { model, boss, config: changed, handlers: { "assess-page": assessPageBatchEntry } }, batch!.id);
      expect(await tx.select().from(pageAssessments).where(inArray(pageAssessments.documentVersionId, Object.values(versions)))).toHaveLength(0);
    }));
});
