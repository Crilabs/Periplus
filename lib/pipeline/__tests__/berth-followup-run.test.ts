import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { MockModel } from "@/lib/ai/mock";
import type { ExtractBerthOutput } from "@/lib/ai/tasks/extract-berth";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, documents, documentVersions, pageAssessments, places, researchHits, runs, runStages, serpQueries, serpResults } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { researchView } from "@/lib/domain/research/view";
import { beginStage, createRun } from "@/lib/domain/runs";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { researchConfirmHandler } from "@/lib/jobs/handlers/research";
import type { JobContext } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import { BERTH_FOLLOWUP_SCOPE, BERTH_FOLLOWUP_STAGES, startBerthFollowupRun } from "@/lib/pipeline/berth-followup-run";
import { pollBatch } from "@/lib/pipeline/batches";
import { RESEARCH_CONFIRM_STAGE } from "@/lib/pipeline/research/confirm";
import { extractUnits, planResearchExtract, RESEARCH_EXTRACT_STAGE } from "@/lib/pipeline/research/extract";
import { RESEARCH_STAGES } from "@/lib/pipeline/research-run";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertTestRun, insertTestSource } from "@/test/text";

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

const ctxFor = (db: Db, boss: PgBoss): JobContext => ({ db, boss, log: createLogger("test"), jobId: newId() });

describe("startBerthFollowupRun", () => {
  it("starts an event run of scope system/berth-followup with the images stage for the places' objects", () =>
    withRollback(async (tx) => {
      const a = await insertPlace(tx, { name: "Vathi", status: "confirmed" });
      const b = await insertPlace(tx, { name: "Kalo", lon: 21.1, status: "confirmed" });
      const { boss } = recordingBoss();
      const started = await startBerthFollowupRun(tx, boss, [b.placeId, a.placeId, a.placeId], "test");
      expect(started).not.toBeNull();
      const [run] = await tx.select().from(runs).where(eq(runs.id, started!.id));
      expect(run).toMatchObject({ kind: "event", scopeType: "system", scopeId: BERTH_FOLLOWUP_SCOPE });
      expect(run!.params).toEqual({ placeIds: [a.placeId, b.placeId].sort(), images: { geoObjectIds: [a.objectId, b.objectId].sort() } });
      const stages = await tx.select().from(runStages).where(eq(runStages.runId, started!.id));
      expect(stages.map((s) => s.stage)).toEqual([...BERTH_FOLLOWUP_STAGES]);
    }));

  it("returns null without places, unknown places or ended places", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      expect(await startBerthFollowupRun(tx, boss, [], "test")).toBeNull();
      expect(await startBerthFollowupRun(tx, boss, [newId()], "test")).toBeNull();
      const ended = await insertPlace(tx, { status: "confirmed" });
      await tx.update(places).set({ validTo: "2020-01-01" }).where(eq(places.id, ended.placeId));
      expect(await startBerthFollowupRun(tx, boss, [ended.placeId], "test")).toBeNull();
    }));
});

const PAGE = "# Vathi\n\nWe anchored in Vathi in June 2024, good holding on sand.";

/** A page of `domain` that treats the place: document, version with archived markdown, active assessment and a search hit. */
async function page(tx: Db, place: { placeId: string; objectId: string }, domain: string, archive: ReturnType<typeof memoryArchive>) {
  const sourceId = await insertTestSource(tx);
  const url = `https://www.${domain}/vathi`;
  const [doc] = await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "trip_report" }).returning({ id: documents.id });
  const mdKey = `archive/${doc!.id}/${newId()}.md`;
  const [version] = await tx
    .insert(documentVersions)
    .values({
      documentId: doc!.id, fetchedAt: new Date("2026-10-19T10:00:00Z"), contentHash: newId(), rawHash: "r", rawKey: `archive/${doc!.id}/r.html`, mdKey,
      observedAt: "2024-06-15", observedAtBasis: "explicit", docType: "trip_report", converter: "local", language: "en", charCount: PAGE.length,
    })
    .returning({ id: documentVersions.id });
  await tx.update(documents).set({ currentVersionId: version!.id }).where(eq(documents.id, doc!.id));
  await archive.put(mdKey, new TextEncoder().encode(PAGE), "text/markdown");
  const { model, promptVersion } = activeAssessor(config);
  await tx.insert(pageAssessments).values({
    documentVersionId: version!.id, model, promptVersion, pageKind: "trip_report", firstHand: true, generated: false, observedAt: "2024-06-15", observedAtBasis: "explicit",
    berths: [{ name: "Vathi", island: null, kind: "anchorage" }], runId: await insertTestRun(tx),
  });
  const [q] = await tx
    .insert(serpQueries)
    .values({ keyword: "k", languageCode: "en", locationCode: 2300, depth: 10, level: "place", scopeId: place.objectId, rawKey: `serp/x/${url}.json`, fetchedAt: new Date() })
    .returning({ id: serpQueries.id });
  const [r] = await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url, urlNormalized: url, domain, title: "t", snippet: "s" }).returning({ id: serpResults.id });
  await tx.insert(researchHits).values({ placeId: place.placeId, geoObjectId: place.objectId, serpQueryId: q!.id, serpResultId: r!.id, urlNormalized: url, domain, rank: 1, purpose: "positive" });
}

describe("research.confirm handler", () => {
  it("extracts two independent sources, confirms the berth, starts the follow-up run and a consolidation, and the tab says why", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx, { name: "Vathi", lon: 30.0, lat: 40.2, status: "candidate" });
      const archive = memoryArchive();
      await page(tx, place, "sail-a.example", archive);
      await page(tx, place, "sail-b.example", archive);
      const { boss, inserted } = recordingBoss();

      const { id: runId } = await createRun(tx, {
        kind: "stage",
        scope: { type: "system", id: "places" },
        stages: [...RESEARCH_STAGES],
        params: { placeIds: [place.placeId] },
        triggeredBy: "test",
      });
      await beginStage(tx, runId, RESEARCH_EXTRACT_STAGE, 1);
      // before extraction there is no evidence
      expect((await researchView(tx, place.placeId)).verdict.status).toBe("candidate");

      const jobs = await planResearchExtract(tx, { id: runId, params: { placeIds: [place.placeId] } }, config);
      const model = new MockModel({
        "extract-berth": (): ExtractBerthOutput => ({
          core: [], facts: [], landing: [],
          signals: [{ kind: "anchored", first_hand: true, confidence: 0.9, quote: "We anchored in Vathi in June 2024", observed_at: "2024-06" }],
        }),
      });
      for (const job of jobs) {
        await extractUnits(tx, { model, boss, config, archive }, { runId, stage: RESEARCH_EXTRACT_STAGE, key: job.key as string, unitIds: job.unitIds as string[] });
      }
      for (const b of await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId))) {
        expect(await pollBatch(tx, { model, boss, config, handlers: BATCH_HANDLERS }, b.id)).toBe("distributed");
      }

      await researchConfirmHandler({ runId, stage: RESEARCH_CONFIRM_STAGE, key: "confirm" }, ctxFor(tx, boss));

      const [row] = await tx.select().from(places).where(eq(places.id, place.placeId));
      expect(row).toMatchObject({ status: "confirmed" });
      const followups = await tx.select().from(runs).where(eq(runs.scopeId, BERTH_FOLLOWUP_SCOPE));
      expect(followups).toHaveLength(1);
      expect(followups[0]!.params).toMatchObject({ placeIds: [place.placeId], images: { geoObjectIds: [place.objectId] } });
      const consolidations = (await tx.select().from(runs)).filter((r) => (r.params as { geoObjectIds?: string[] }).geoObjectIds?.[0] === place.objectId);
      expect(consolidations).toHaveLength(1);
      expect(inserted.length).toBeGreaterThan(0);

      const view = await researchView(tx, place.placeId);
      expect(view.verdict).toMatchObject({ status: "confirmed", independentSources: ["sail-a.example", "sail-b.example"] });
      expect(view.rows.map((r) => r.signalCount)).toEqual([1, 1]);
    }));

  it("starts no follow-up run when a berth drops out of confirmed, but consolidates it", () =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx, { name: "Vathi", lon: 30.0, lat: 40.2, status: "confirmed" });
      await tx.update(places).set({ publicId: "sp_test0001" }).where(eq(places.id, place.placeId));
      const { boss } = recordingBoss();
      const { id: runId } = await createRun(tx, {
        kind: "stage",
        scope: { type: "system", id: "places" },
        stages: [...RESEARCH_STAGES],
        params: { placeIds: [place.placeId] },
        triggeredBy: "test",
      });
      await researchConfirmHandler({ runId, stage: RESEARCH_CONFIRM_STAGE, key: "confirm" }, ctxFor(tx, boss));
      expect(await tx.select().from(places).where(eq(places.id, place.placeId))).toMatchObject([{ status: "candidate" }]);
      expect(await tx.select().from(runs).where(eq(runs.scopeId, BERTH_FOLLOWUP_SCOPE))).toHaveLength(0);
      expect((await tx.select().from(runs)).filter((r) => (r.params as { geoObjectIds?: string[] }).geoObjectIds?.[0] === place.objectId)).toHaveLength(1);
    }));
});
