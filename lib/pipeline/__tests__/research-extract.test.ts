import { eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { MockModel } from "@/lib/ai/mock";
import type { ExtractBerthInput, ExtractBerthOutput } from "@/lib/ai/tasks/extract-berth";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, berthSignals, documents, documentVersions, pageAssessments, researchHits, researchUnits, serpQueries, serpResults } from "@/lib/db/schema";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun } from "@/lib/domain/runs";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { pollBatch } from "@/lib/pipeline/batches";
import { extractBerthBatchEntry, extractUnits, planResearchExtract, RESEARCH_EXTRACT_STAGE } from "@/lib/pipeline/research/extract";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertTestRun, insertTestVersion } from "@/test/text";

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const boss = { insert: async (_q: string, jobs: Array<{ id?: string }>) => jobs.map((j) => j.id ?? newId()) } as unknown as PgBoss;

const PAGE = [
  "# From Vathi to Agios Georgios",
  "We anchored in Vathi in June 2024, good holding on sand.",
  "Next day we sailed across to Agios Georgios and picked up one of the buoys off the village.",
].join("\n\n");

async function hit(tx: Db, placeId: string, geoObjectId: string, url: string) {
  const [q] = await tx
    .insert(serpQueries)
    .values({ keyword: "k", languageCode: "en", locationCode: 2300, depth: 10, level: "place", scopeId: geoObjectId, rawKey: `serp/x/${url}.json`, fetchedAt: new Date() })
    .returning({ id: serpQueries.id });
  const [r] = await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url, urlNormalized: url, domain: "test.invalid", title: "t", snippet: "s" }).returning({ id: serpResults.id });
  await tx.insert(researchHits).values({ placeId, geoObjectId, serpQueryId: q!.id, serpResultId: r!.id, urlNormalized: url, domain: "test.invalid", rank: 1, purpose: "positive" });
}

/** Two candidates 4.5 km apart; one page, a hit of the first, that treats both. */
async function seed(tx: Db, opts: { generated?: boolean } = {}) {
  // outside the pilot box, see test/db.ts
  const vathi = await insertPlace(tx, { name: "Vathi", lon: 30.0, lat: 40.2, status: "candidate" });
  const agios = await insertPlace(tx, { name: "Agios Georgios", lon: 30.055, lat: 40.2, status: "candidate" });
  const v = await insertTestVersion(tx, ["x"]);
  const [doc] = await tx.select().from(documents).where(eq(documents.id, v.documentId));
  await hit(tx, vathi.placeId, vathi.objectId, doc!.urlNormalized);
  const { model, promptVersion } = activeAssessor(config);
  await tx.insert(pageAssessments).values({
    documentVersionId: v.versionId, model, promptVersion, pageKind: "trip_report", firstHand: true, generated: opts.generated ?? false,
    observedAt: "2024-06-15", observedAtBasis: "explicit",
    berths: [{ name: "Vathi", island: null, kind: "anchorage" }, { name: "Agios Georgios", island: null, kind: "mooring_field" }],
    runId: await insertTestRun(tx),
  });
  const archive = memoryArchive();
  const [row] = await tx.select({ mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, v.versionId));
  await archive.put(row!.mdKey, new TextEncoder().encode(PAGE), "text/markdown");
  return { vathi: vathi.placeId, agios: agios.placeId, versionId: v.versionId, archive };
}

/** The model answers per berth: a first-hand signal of the berth named in the input. */
function reply(input: unknown): ExtractBerthOutput {
  const { berth } = input as ExtractBerthInput;
  const empty: ExtractBerthOutput = { core: [], facts: [], signals: [], landing: [] };
  if (berth.name === "Vathi") {
    return { ...empty, signals: [{ kind: "anchored", first_hand: true, confidence: 0.9, quote: "We anchored in Vathi in June 2024", observed_at: "2024-06" }] };
  }
  return { ...empty, signals: [{ kind: "moored_buoy", first_hand: true, confidence: 0.85, quote: "picked up one of the buoys off the village", observed_at: null }] };
}

async function runWithStage(tx: Db, placeIds: string[]): Promise<string> {
  const { id } = await createRun(tx, {
    kind: "reprocess",
    scope: { type: "system", id: `extract-${newId()}` },
    stages: [RESEARCH_EXTRACT_STAGE, "test.next"],
    params: { placeIds },
    triggeredBy: "test",
  });
  await beginStage(tx, id, RESEARCH_EXTRACT_STAGE, 1);
  return id;
}

describe("research.extract", () => {
  it("extracts one unit per berth of a page, each signal at its own berth", () =>
    withRollback(async (tx) => {
      const { vathi, agios, versionId, archive } = await seed(tx);
      const runId = await runWithStage(tx, [vathi]);
      const plan = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config);
      expect(plan).toHaveLength(1);
      const unitIds = plan[0]!.unitIds as string[];
      expect(unitIds).toHaveLength(2);
      const units = await tx.select().from(researchUnits).where(inArray(researchUnits.id, unitIds));
      expect(units.map((u) => u.placeId).sort()).toEqual([vathi, agios].sort());
      expect(units.every((u) => u.status === "pending" && u.documentVersionId === versionId && u.runId === runId)).toBe(true);

      const model = new MockModel({ "extract-berth": reply });
      const result = await extractUnits(tx, { model, boss, config, archive }, { runId, stage: RESEARCH_EXTRACT_STAGE, key: plan[0]!.key as string, unitIds });
      expect(result).toMatchObject({ submitted: 2, remainder: 0, reused: false });

      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      const requests = model.batchRequests(batch!.providerBatchId!)!;
      expect(requests).toHaveLength(2);
      const inputs = requests.map((r) => r.input as ExtractBerthInput);
      const forVathi = inputs.find((i) => i.berth.name === "Vathi")!;
      expect(forVathi).toMatchObject({ otherBerths: ["Agios Georgios"], pageKind: "trip_report", observedAt: "2024-06-15", text: PAGE });
      expect(forVathi.attributes.some((a) => a.key === "holding")).toBe(true);
      expect(inputs.find((i) => i.berth.name === "Agios Georgios")!.otherBerths).toEqual(["Vathi"]);

      expect(BATCH_HANDLERS["extract-berth"]).toBe(extractBerthBatchEntry);
      expect(await pollBatch(tx, { model, boss, config, handlers: BATCH_HANDLERS }, batch!.id)).toBe("distributed");

      const signals = await tx.select().from(berthSignals).where(eq(berthSignals.documentVersionId, versionId));
      expect(signals.map((s) => [s.placeId === vathi ? "vathi" : s.placeId === agios ? "agios" : "?", s.kind]).sort()).toEqual([
        ["agios", "moored_buoy"],
        ["vathi", "anchored"],
      ]);
      const agiosSignal = signals.find((s) => s.placeId === agios)!;
      expect(agiosSignal).toMatchObject({ observedAt: "2024-06-15", observedAtBasis: "explicit" });
      const done = await tx.select().from(researchUnits).where(inArray(researchUnits.id, unitIds));
      expect(done.every((u) => u.status === "done")).toBe(true);
    }));

  it("plans no unit twice", () =>
    withRollback(async (tx) => {
      const { vathi } = await seed(tx);
      const runId = await insertTestRun(tx);
      const first = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config);
      const again = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config);
      expect(again).toEqual(first);
      const ids = first.flatMap((j) => j.unitIds as string[]);
      const [{ versionId }] = await tx.select({ versionId: researchUnits.documentVersionId }).from(researchUnits).where(eq(researchUnits.id, ids[0]!));
      expect(await tx.select().from(researchUnits).where(eq(researchUnits.documentVersionId, versionId))).toHaveLength(2);

      await tx.update(researchUnits).set({ status: "done" }).where(inArray(researchUnits.id, ids));
      expect(await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config)).toEqual([]);
    }));

  it("marks a unit failed when its item fails for good", () =>
    withRollback(async (tx) => {
      const { vathi } = await seed(tx);
      const runId = await insertTestRun(tx);
      const [job] = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config);
      const unitId = (job!.unitIds as string[])[0]!;
      await extractBerthBatchEntry.fail!(tx, {
        id: newId(), subjectType: "research_unit", subjectId: unitId, error: "stop_reason max_tokens", usage: { inputTokens: 0, outputTokens: 0 }, costEur: 0,
        batch: { id: newId(), model: "claude-sonnet-5-5", promptVersion: 1, runId, stage: RESEARCH_EXTRACT_STAGE },
      });
      const [row] = await tx.select().from(researchUnits).where(eq(researchUnits.id, unitId));
      expect(row).toMatchObject({ status: "failed", reason: "stop_reason max_tokens" });
      const again = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config);
      expect(again.flatMap((j) => j.unitIds as string[])).not.toContain(unitId);
    }));

  it("plans nothing for a generated page", () =>
    withRollback(async (tx) => {
      const { vathi, versionId } = await seed(tx, { generated: true });
      const runId = await insertTestRun(tx);
      expect(await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config)).toEqual([]);
      expect(await tx.select().from(researchUnits).where(eq(researchUnits.documentVersionId, versionId))).toHaveLength(0);
    }));
});
