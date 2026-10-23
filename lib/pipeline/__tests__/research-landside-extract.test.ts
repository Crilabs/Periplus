import { and, eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { MockModel } from "@/lib/ai/mock";
import type { ExtractLandsideInput, ExtractLandsideOutput } from "@/lib/ai/tasks/extract-landside";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import {
  aiBatches,
  berthFacts,
  berthSignals,
  documents,
  documentVersions,
  landingHints,
  pageAssessments,
  places,
  researchHits,
  researchUnits,
  serpQueries,
  serpResults,
} from "@/lib/db/schema";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { loadEvidence } from "@/lib/domain/research/confirmation";
import { newId } from "@/lib/domain/ids";
import { standingFacts } from "@/lib/domain/research/state-facts";
import { beginStage, createRun } from "@/lib/domain/runs";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { pollBatch } from "@/lib/pipeline/batches";
import { planResearchExtract } from "@/lib/pipeline/research/extract";
import {
  extractLandsideBatchEntry,
  extractLandsideUnits,
  planLandsideExtract,
  RESEARCH_LANDSIDE_EXTRACT_STAGE,
} from "@/lib/pipeline/research/landside-extract";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertNamedObject, insertTestRun, insertTestVersion } from "@/test/text";

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const boss = { insert: async (_q: string, jobs: Array<{ id?: string }>) => jobs.map((j) => j.id ?? newId()) } as unknown as PgBoss;

const FIRST_PAGE = [
  "# Kato Limani for sailors",
  "We anchored in the bay below the village for two nights, the holding was good on sand.",
  "In Kato Limani, Taverna Kyma is open from May to October and serves fresh fish at the harbour.",
  "The little grocery next to it shuts at two in the afternoon.",
].join("\n\n");
const OTHER_PAGE = "# Somewhere else\n\nWe anchored off a bay far away and the beach was lovely, with a taverna on it.";

async function hit(tx: Db, placeId: string, geoObjectId: string, url: string, purpose: "landside" | "positive") {
  const [q] = await tx
    .insert(serpQueries)
    .values({ keyword: "k", languageCode: "en", locationCode: 2300, depth: 10, level: "place", scopeId: geoObjectId, rawKey: `serp/x/${newId()}.json`, fetchedAt: new Date() })
    .returning({ id: serpQueries.id });
  const [r] = await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url, urlNormalized: url, domain: "test.invalid", title: "t", snippet: "s" }).returning({ id: serpResults.id });
  await tx.insert(researchHits).values({ placeId, geoObjectId, serpQueryId: q!.id, serpResultId: r!.id, urlNormalized: url, domain: "test.invalid", rank: 1, purpose });
}

async function page(tx: Db, archive: ReturnType<typeof memoryArchive>, placeId: string, geoObjectId: string, md: string, o: { generated?: boolean; purpose?: "landside" | "positive" } = {}) {
  const v = await insertTestVersion(tx, ["x"]);
  const [doc] = await tx.select().from(documents).where(eq(documents.id, v.documentId));
  await hit(tx, placeId, geoObjectId, doc!.urlNormalized, o.purpose ?? "landside");
  const { model, promptVersion } = activeAssessor(config);
  await tx.insert(pageAssessments).values({
    documentVersionId: v.versionId, model, promptVersion, pageKind: "trip_report", firstHand: true, generated: o.generated ?? false,
    observedAt: "2024-06-15", observedAtBasis: "explicit", berths: [], runId: await insertTestRun(tx),
  });
  const [row] = await tx.select({ mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, v.versionId));
  await archive.put(row!.mdKey, new TextEncoder().encode(md), "text/markdown");
  return v.versionId;
}

/** A confirmed berth with a named settlement 100 m away (its nearest settlement is a landside subject). */
async function seed(tx: Db, opts: { status?: "confirmed" | "candidate" } = {}) {
  const berth = await insertPlace(tx, { name: "Bay Alpha", lon: 30.0, lat: 40.2, status: opts.status ?? "confirmed" });
  await insertNamedObject(tx, { type: "settlement", names: [{ name: "Kato Limani", language: "en" }], lon: 30.001, lat: 40.2 });
  return berth;
}

async function runWithStage(tx: Db, placeIds: string[]): Promise<string> {
  const { id } = await createRun(tx, {
    kind: "reprocess",
    scope: { type: "system", id: `landside-extract-${newId()}` },
    stages: [RESEARCH_LANDSIDE_EXTRACT_STAGE, "test.next"],
    params: { placeIds },
    triggeredBy: "test",
  });
  await beginStage(tx, id, RESEARCH_LANDSIDE_EXTRACT_STAGE, 1);
  return id;
}

const plan = (tx: Db, runId: string, placeId: string, archive: ReturnType<typeof memoryArchive>) =>
  planLandsideExtract(tx, { id: runId, params: { placeIds: [placeId] } }, config, archive);

describe("research.landside_extract", () => {
  it("plans a landside unit only for a current, assessed, not generated landside hit page that names a subject of a confirmed place", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx);
      const archive = memoryArchive();
      const named = await page(tx, archive, placeId, objectId, FIRST_PAGE);
      const unnamed = await page(tx, archive, placeId, objectId, OTHER_PAGE);
      const generated = await page(tx, archive, placeId, objectId, FIRST_PAGE, { generated: true });
      const berthHit = await page(tx, archive, placeId, objectId, FIRST_PAGE, { purpose: "positive" });
      const runId = await insertTestRun(tx);

      const jobs = await plan(tx, runId, placeId, archive);
      const units = await tx.select().from(researchUnits).where(inArray(researchUnits.documentVersionId, [named, unnamed, generated, berthHit]));
      expect(units).toHaveLength(1);
      expect(units[0]).toMatchObject({ documentVersionId: named, placeId, kind: "landside", status: "pending", runId });
      expect(jobs.flatMap((j) => j.unitIds as string[])).toEqual([units[0]!.id]);

      // planning again adds nothing
      expect((await plan(tx, runId, placeId, archive)).flatMap((j) => j.unitIds as string[])).toEqual([units[0]!.id]);
      expect(await tx.select().from(researchUnits).where(eq(researchUnits.documentVersionId, named))).toHaveLength(1);
    }));

  it("plans nothing for a place that is not confirmed", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx, { status: "candidate" });
      const archive = memoryArchive();
      const v = await page(tx, archive, placeId, objectId, FIRST_PAGE);
      expect(await plan(tx, await insertTestRun(tx), placeId, archive)).toEqual([]);
      expect(await tx.select().from(researchUnits).where(eq(researchUnits.documentVersionId, v))).toHaveLength(0);
    }));

  it("the berth extraction neither plans nor counts a landside unit; a berth hit page of the same version keeps its own unit", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx);
      const archive = memoryArchive();
      const v = await page(tx, archive, placeId, objectId, FIRST_PAGE);
      const runId = await insertTestRun(tx);
      await plan(tx, runId, placeId, archive);
      expect(await planResearchExtract(tx, { id: runId, params: { placeIds: [placeId] } }, config, archive)).toEqual([]);
      expect((await tx.select().from(researchUnits).where(eq(researchUnits.documentVersionId, v))).map((u) => u.kind)).toEqual(["landside"]);
    }));

  it("stores the landside facts, never a signal or hint: a landside page saying we anchored confirms nothing", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx);
      const archive = memoryArchive();
      const v = await page(tx, archive, placeId, objectId, FIRST_PAGE);
      const runId = await runWithStage(tx, [placeId]);
      const [job] = await plan(tx, runId, placeId, archive);

      const model = new MockModel({
        "extract-landside": (): ExtractLandsideOutput => ({
          facts: [
            { subject_name: "Taverna Kyma", subject_category: "restaurant", statement: "A fish taverna at the harbour open in summer.", quote: "Taverna Kyma is open from May to October and serves fresh fish", observed_at: null, tone: "positive", safety: false },
            { subject_name: null, subject_category: "  ", statement: "The village grocery closes in the early afternoon.", quote: "The little grocery next to it shuts at two in the afternoon", observed_at: null, tone: "neutral", safety: false },
            // the model strays: this is about the berth; it can only become a fact, never evidence
            { subject_name: null, subject_category: "other", statement: "The crew stayed in the bay for two nights.", quote: "We anchored in the bay below the village for two nights", observed_at: null, tone: "positive", safety: false },
            { subject_name: "Taverna Nikos", subject_category: "restaurant", statement: "Not in the text.", quote: "this quote is not on the page at all", observed_at: null, tone: "neutral", safety: false },
          ],
        }),
      });
      const unitIds = job!.unitIds as string[];
      const result = await extractLandsideUnits(tx, { model, boss, config, archive }, { runId, stage: RESEARCH_LANDSIDE_EXTRACT_STAGE, key: job!.key as string, unitIds });
      expect(result).toMatchObject({ submitted: 1, remainder: 0, reused: false });
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      const requests = model.batchRequests(batch!.providerBatchId!)!;
      const input = requests[0]!.input as ExtractLandsideInput;
      expect(input).toMatchObject({ place: "Bay Alpha", subjects: ["Kato Limani"], pageKind: "trip_report", observedAt: "2024-06-15" });
      expect(input.text).toContain("Kato Limani");

      expect(BATCH_HANDLERS["extract-landside"]).toBe(extractLandsideBatchEntry);
      expect(await pollBatch(tx, { model, boss, config, handlers: BATCH_HANDLERS }, batch!.id)).toBe("distributed");

      const facts = await tx.select().from(berthFacts).where(eq(berthFacts.documentVersionId, v));
      // a blank category becomes "other"; the fact whose quote is not on the page is dropped
      expect(facts.map((f) => `${f.subjectName ?? "-"}:${f.subjectCategory}:${f.attribute ?? "-"}`).sort()).toEqual(["-:other:-", "-:other:-", "Taverna Kyma:restaurant:-"]);
      const [unit] = await tx.select().from(researchUnits).where(eq(researchUnits.id, unitIds[0]!));
      expect(unit).toMatchObject({ status: "done", dropped: { quote: 1, value: 0, verbatim: 0, attribution: 0 } });

      expect(await tx.select().from(berthSignals).where(eq(berthSignals.placeId, placeId))).toHaveLength(0);
      expect(await tx.select().from(landingHints).where(eq(landingHints.placeId, placeId))).toHaveLength(0);
      expect((await loadEvidence(tx, [placeId], config)).get(placeId) ?? []).toEqual([]);
      // the facts reach the berth state, with their names
      expect((await standingFacts(tx, placeId, config)).map((f) => f.subjectName ?? "-").sort()).toEqual(["-", "-", "Taverna Kyma"]);
    }));

  it("sends a unit once: a second job with the same unit finds it in an open batch", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx);
      const archive = memoryArchive();
      await page(tx, archive, placeId, objectId, FIRST_PAGE);
      const runId = await runWithStage(tx, [placeId]);
      const [job] = await plan(tx, runId, placeId, archive);
      const model = new MockModel({ "extract-landside": (): ExtractLandsideOutput => ({ facts: [] }) });
      const unitIds = job!.unitIds as string[];
      await extractLandsideUnits(tx, { model, boss, config, archive }, { runId, stage: RESEARCH_LANDSIDE_EXTRACT_STAGE, key: "landside-extract:0", unitIds });
      const again = await extractLandsideUnits(tx, { model, boss, config, archive }, { runId, stage: RESEARCH_LANDSIDE_EXTRACT_STAGE, key: "landside-extract:other", unitIds });
      expect(again.submitted).toBe(0);
      expect(await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId))).toHaveLength(1);
    }));

  it("drops the result of a stale model or prompt version and fails a unit whose answer does not fit", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx);
      const archive = memoryArchive();
      await page(tx, archive, placeId, objectId, FIRST_PAGE);
      const runId = await insertTestRun(tx);
      const [job] = await plan(tx, runId, placeId, archive);
      const unitId = (job!.unitIds as string[])[0]!;
      const item = (output: unknown, promptVersion: number) => ({
        id: newId(), subjectType: "research_unit", subjectId: unitId, input: { text: "x", offsetRuns: null, observedAt: "2024-06-15", observedAtBasis: "explicit", fetchedAt: new Date().toISOString() },
        output, usage: { inputTokens: 0, outputTokens: 0 }, costEur: 0,
        batch: { id: newId(), model: "claude-sonnet-5-5", promptVersion, runId, stage: RESEARCH_LANDSIDE_EXTRACT_STAGE },
      });
      const ctx = { config } as never;
      await extractLandsideBatchEntry.handle(tx, item({ facts: [] }, 99) as never, ctx);
      expect((await tx.select().from(researchUnits).where(eq(researchUnits.id, unitId)))[0]!.status).toBe("pending");
      const active = config.models.tasks["extract-landside"]!.promptVersion;
      await extractLandsideBatchEntry.handle(tx, item({ facts: "nope" }, active) as never, ctx);
      expect((await tx.select().from(researchUnits).where(eq(researchUnits.id, unitId)))[0]).toMatchObject({ status: "failed", attempts: 1 });
    }));

  it("a place's unit of the berth kind and of the landside kind of one version coexist", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await seed(tx);
      const archive = memoryArchive();
      const v = await page(tx, archive, placeId, objectId, FIRST_PAGE);
      await plan(tx, await insertTestRun(tx), placeId, archive);
      const [{ id: landsideId }] = await tx.select({ id: researchUnits.id }).from(researchUnits).where(eq(researchUnits.documentVersionId, v));
      await tx.insert(researchUnits).values({ documentVersionId: v, placeId, kind: "berth", model: "claude-sonnet-5-5", promptVersion: 2, status: "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 0 } });
      // the landside plan neither sees the berth unit nor changes the landside one
      const again = await plan(tx, await insertTestRun(tx), placeId, archive);
      expect(again.flatMap((j) => j.unitIds as string[])).toEqual([landsideId]);
      expect(await tx.select().from(places).where(and(eq(places.id, placeId), eq(places.status, "confirmed")))).toHaveLength(1);
    }));
});
