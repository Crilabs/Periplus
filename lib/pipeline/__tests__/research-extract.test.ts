import { and, eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { MockModel } from "@/lib/ai/mock";
import type { ExtractBerthInput, ExtractBerthOutput } from "@/lib/ai/tasks/extract-berth";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, berthSignals, documents, documentVersions, pageAssessments, researchHits, researchUnits, serpQueries, serpResults } from "@/lib/db/schema";
import { activeAssessor } from "@/lib/domain/research/assessment";
import { noDrops } from "@/lib/domain/research/extraction";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun } from "@/lib/domain/runs";
import { BATCH_HANDLERS } from "@/lib/jobs/batch-handlers";
import { pollBatch } from "@/lib/pipeline/batches";
import { activeExtractor, extractBerthBatchEntry, extractUnits, planResearchExtract, RESEARCH_EXTRACT_STAGE } from "@/lib/pipeline/research/extract";
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
      const plan = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive());
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
      const first = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive());
      const again = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive());
      expect(again).toEqual(first);
      const ids = first.flatMap((j) => j.unitIds as string[]);
      const [{ versionId }] = await tx.select({ versionId: researchUnits.documentVersionId }).from(researchUnits).where(eq(researchUnits.id, ids[0]!));
      expect(await tx.select().from(researchUnits).where(eq(researchUnits.documentVersionId, versionId))).toHaveLength(2);

      await tx.update(researchUnits).set({ status: "done" }).where(inArray(researchUnits.id, ids));
      expect(await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive())).toEqual([]);
    }));

  it("marks a unit failed when its item fails for good", () =>
    withRollback(async (tx) => {
      const { vathi } = await seed(tx);
      const runId = await insertTestRun(tx);
      const [job] = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive());
      const unitId = (job!.unitIds as string[])[0]!;
      await extractBerthBatchEntry.fail!(tx, {
        id: newId(), subjectType: "research_unit", subjectId: unitId, error: "stop_reason max_tokens", usage: { inputTokens: 0, outputTokens: 0 }, costEur: 0,
        batch: { id: newId(), model: "claude-sonnet-5-5", promptVersion: 1, runId, stage: RESEARCH_EXTRACT_STAGE },
      });
      const [row] = await tx.select().from(researchUnits).where(eq(researchUnits.id, unitId));
      expect(row).toMatchObject({ status: "failed", reason: "stop_reason max_tokens", attempts: 1 });
    }));

  it("plans a failed unit again until it failed research.extraction.maxAttempts times (final review 2)", () =>
    withRollback(async (tx) => {
      const { vathi } = await seed(tx);
      const runId = await insertTestRun(tx);
      const [job] = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive());
      const unitId = (job!.unitIds as string[])[0]!;
      const fail = () =>
        extractBerthBatchEntry.fail!(tx, {
          id: newId(), subjectType: "research_unit", subjectId: unitId, error: "stop_reason max_tokens", usage: { inputTokens: 0, outputTokens: 0 }, costEur: 0,
          batch: { id: newId(), model: "claude-sonnet-5-5", promptVersion: 1, runId, stage: RESEARCH_EXTRACT_STAGE },
        });
      expect(config.research.extraction.maxAttempts).toBe(3);
      for (let attempt = 1; attempt < 3; attempt++) {
        await fail();
        const again = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive());
        expect(again.flatMap((j) => j.unitIds as string[])).toContain(unitId);
        expect((await tx.select().from(researchUnits).where(eq(researchUnits.id, unitId)))[0]).toMatchObject({ status: "pending", reason: null, attempts: attempt });
      }
      await fail();
      const last = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive());
      expect(last.flatMap((j) => j.unitIds as string[])).not.toContain(unitId);
      expect((await tx.select().from(researchUnits).where(eq(researchUnits.id, unitId)))[0]).toMatchObject({ status: "failed", attempts: 3 });
    }));

  it("plans a unit skipped for missing markdown or assessment again, one skipped as generated not (final review 2)", () =>
    withRollback(async (tx) => {
      const { vathi } = await seed(tx);
      const runId = await insertTestRun(tx);
      const [job] = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive());
      const [a, b] = job!.unitIds as string[];
      await tx.update(researchUnits).set({ status: "skipped", reason: "archived markdown missing (k)" }).where(eq(researchUnits.id, a!));
      await tx.update(researchUnits).set({ status: "skipped", reason: "page is generated text" }).where(eq(researchUnits.id, b!));
      const again = (await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive())).flatMap((j) => j.unitIds as string[]);
      expect(again).toEqual([a]);
      await tx.update(researchUnits).set({ status: "skipped", reason: "page has no active assessment" }).where(eq(researchUnits.id, a!));
      expect((await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive())).flatMap((j) => j.unitIds as string[])).toEqual([a]);
    }));

  it("plans nothing for a generated page", () =>
    withRollback(async (tx) => {
      const { vathi, versionId } = await seed(tx, { generated: true });
      const runId = await insertTestRun(tx);
      expect(await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive())).toEqual([]);
      expect(await tx.select().from(researchUnits).where(eq(researchUnits.documentVersionId, versionId))).toHaveLength(0);
    }));

  it("never stores a signal at a berth whose quote names only the other berth (Review Focus)", () =>
    withRollback(async (tx) => {
      const { vathi, agios, archive } = await seed(tx);
      const runId = await runWithStage(tx, [vathi]);
      const [job] = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive());
      // for Vathi the model wrongly reports the buoy at Agios Georgios
      const model = new MockModel({
        "extract-berth": (input) => {
          const { berth } = input as ExtractBerthInput;
          const quote = "Next day we sailed across to Agios Georgios and picked up one of the buoys";
          const signals = berth.name === "Vathi" ? [{ kind: "moored_buoy", first_hand: true, confidence: 0.9, quote, observed_at: null }] : [];
          return { core: [], facts: [], signals, landing: [] };
        },
      });
      await extractUnits(tx, { model, boss, config, archive }, { runId, stage: RESEARCH_EXTRACT_STAGE, key: job!.key as string, unitIds: job!.unitIds as string[] });
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      expect(await pollBatch(tx, { model, boss, config, handlers: BATCH_HANDLERS }, batch!.id)).toBe("distributed");
      expect(await tx.select().from(berthSignals).where(inArray(berthSignals.placeId, [vathi, agios]))).toHaveLength(0);
      const [unit] = await tx.select().from(researchUnits).where(and(inArray(researchUnits.id, job!.unitIds as string[]), eq(researchUnits.placeId, vathi)));
      expect(unit).toMatchObject({ status: "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 1 } });
    }));

  it("treats a berth the page's assessment names (no candidate of it) as another berth: its quote is dropped (final review 1)", () =>
    withRollback(async (tx) => {
      // a hit page of Ypsilon whose assessment names only Xyla; Xyla is no candidate, so no sibling unit exists
      const ypsilon = await insertPlace(tx, { name: "Ypsilon", lon: 30.5, lat: 40.6, status: "candidate" });
      const v = await insertTestVersion(tx, ["x"]);
      const [doc] = await tx.select().from(documents).where(eq(documents.id, v.documentId));
      await hit(tx, ypsilon.placeId, ypsilon.objectId, doc!.urlNormalized);
      const { model: assessor, promptVersion } = activeAssessor(config);
      await tx.insert(pageAssessments).values({
        documentVersionId: v.versionId, model: assessor, promptVersion, pageKind: "trip_report", firstHand: true, generated: false,
        observedAt: "2024-06-15", observedAtBasis: "explicit", berths: [{ name: "Xyla Bay", island: null, kind: "anchorage" }], runId: await insertTestRun(tx),
      });
      const archive = memoryArchive();
      const [row] = await tx.select({ mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, v.versionId));
      const text = "# Ypsilon and beyond\n\nWe passed Ypsilon in the morning.\n\nWe anchored in Xyla Bay for the night, good holding in sand.";
      await archive.put(row!.mdKey, new TextEncoder().encode(text), "text/markdown");

      const runId = await runWithStage(tx, [ypsilon.placeId]);
      // the assessment does not name Ypsilon; the text does, so the page is its unit
      const [job] = await planResearchExtract(tx, { id: runId, params: { placeIds: [ypsilon.placeId] } }, config, archive);
      expect(job!.unitIds).toHaveLength(1);
      const model = new MockModel({
        "extract-berth": () => ({ core: [], facts: [], landing: [], signals: [{ kind: "anchored", first_hand: true, confidence: 0.9, quote: "We anchored in Xyla Bay for the night", observed_at: null }] }),
      });
      await extractUnits(tx, { model, boss, config, archive }, { runId, stage: RESEARCH_EXTRACT_STAGE, key: job!.key as string, unitIds: job!.unitIds as string[] });
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      expect((model.batchRequests(batch!.providerBatchId!)![0]!.input as ExtractBerthInput).otherBerths).toEqual(["Xyla Bay"]);
      expect(await pollBatch(tx, { model, boss, config, handlers: BATCH_HANDLERS }, batch!.id)).toBe("distributed");
      expect(await tx.select().from(berthSignals).where(eq(berthSignals.placeId, ypsilon.placeId))).toHaveLength(0);
      const [unit] = await tx.select().from(researchUnits).where(eq(researchUnits.placeId, ypsilon.placeId));
      expect(unit).toMatchObject({ status: "done", dropped: { quote: 0, value: 0, verbatim: 0, attribution: 1 } });
    }));

  it("skips a pending unit of a searched place whose page does not name it in the text either", () =>
    withRollback(async (tx) => {
      const ypsilon = await insertPlace(tx, { name: "Ypsilon", lon: 30.5, lat: 40.6, status: "candidate" });
      const v = await insertTestVersion(tx, ["x"]);
      const [doc] = await tx.select().from(documents).where(eq(documents.id, v.documentId));
      await hit(tx, ypsilon.placeId, ypsilon.objectId, doc!.urlNormalized);
      const { model: assessor, promptVersion } = activeAssessor(config);
      await tx.insert(pageAssessments).values({
        documentVersionId: v.versionId, model: assessor, promptVersion, pageKind: "trip_report", firstHand: true, generated: false,
        observedAt: "2024-06-15", observedAtBasis: "explicit", berths: [{ name: "Xyla Bay", island: null, kind: "anchorage" }], runId: await insertTestRun(tx),
      });
      const archive = memoryArchive();
      const [row] = await tx.select({ mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, v.versionId));
      await archive.put(row!.mdKey, new TextEncoder().encode("We anchored in Xyla Bay for the night."), "text/markdown");
      const { model, promptVersion: extractVersion } = activeExtractor(config);
      await tx.insert(researchUnits).values({ documentVersionId: v.versionId, placeId: ypsilon.placeId, model, promptVersion: extractVersion, status: "pending", dropped: noDrops(), runId: await insertTestRun(tx) });
      const runId = await runWithStage(tx, [ypsilon.placeId]);
      expect(await planResearchExtract(tx, { id: runId, params: { placeIds: [ypsilon.placeId] } }, config, archive)).toEqual([]);
      const [unit] = await tx.select().from(researchUnits).where(eq(researchUnits.placeId, ypsilon.placeId));
      expect(unit).toMatchObject({ status: "skipped", reason: "Liegeplatz auf der Seite nicht genannt" });
    }));

  /** A hit page of Ypsilon whose assessment names only Xyla Bay; `text` is its archived Markdown. */
  async function xylaPage(tx: Db, text: string) {
    const ypsilon = await insertPlace(tx, { name: "Ypsilon", lon: 30.5, lat: 40.6, status: "candidate" });
    const v = await insertTestVersion(tx, ["x"]);
    const [doc] = await tx.select().from(documents).where(eq(documents.id, v.documentId));
    await hit(tx, ypsilon.placeId, ypsilon.objectId, doc!.urlNormalized);
    const { model: assessor, promptVersion } = activeAssessor(config);
    await tx.insert(pageAssessments).values({
      documentVersionId: v.versionId, model: assessor, promptVersion, pageKind: "trip_report", firstHand: true, generated: false,
      observedAt: "2024-06-15", observedAtBasis: "explicit", berths: [{ name: "Xyla Bay", island: null, kind: "anchorage" }], runId: await insertTestRun(tx),
    });
    const [row] = await tx.select({ mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, v.versionId));
    const archiveWith = (body: string) => ({ get: async (key: string) => (key === row!.mdKey ? new TextEncoder().encode(body) : null) });
    return { ypsilon, versionId: v.versionId, archiveWith, archive: archiveWith(text) };
  }

  it("does not read the Markdown again for a version whose unit is done or skipped as not named: the unit stays", () =>
    withRollback(async (tx) => {
      const { model, promptVersion } = activeExtractor(config);
      for (const status of ["done", "skipped"] as const) {
        const { ypsilon, versionId, archiveWith } = await xylaPage(tx, "We anchored in Xyla Bay for the night.");
        const [unit] = await tx
          .insert(researchUnits)
          .values({ documentVersionId: versionId, placeId: ypsilon.placeId, model, promptVersion, status, reason: status === "skipped" ? "Liegeplatz auf der Seite nicht genannt" : null, dropped: noDrops(), runId: await insertTestRun(tx) })
          .returning({ id: researchUnits.id });
        const reads: string[] = [];
        const archive = { get: async (key: string) => { reads.push(key); return archiveWith("We anchored off Ypsilon.").get(key); } };
        const runId = await runWithStage(tx, [ypsilon.placeId]);
        expect(await planResearchExtract(tx, { id: runId, params: { placeIds: [ypsilon.placeId] } }, config, archive), status).toEqual([]);
        expect(reads, status).toEqual([]);
        const [after] = await tx.select().from(researchUnits).where(eq(researchUnits.id, unit!.id));
        expect(after!.status, status).toBe(status);
      }
    }));

  it("reads the Markdown of many versions in parallel, at most 8 at a time", () =>
    withRollback(async (tx) => {
      const ypsilon = await insertPlace(tx, { name: "Ypsilon", lon: 30.5, lat: 40.6, status: "candidate" });
      const { model: assessor, promptVersion } = activeAssessor(config);
      const runRef = await insertTestRun(tx);
      for (let i = 0; i < 12; i++) {
        const v = await insertTestVersion(tx, ["x"]);
        const [doc] = await tx.select().from(documents).where(eq(documents.id, v.documentId));
        await hit(tx, ypsilon.placeId, ypsilon.objectId, doc!.urlNormalized);
        await tx.insert(pageAssessments).values({
          documentVersionId: v.versionId, model: assessor, promptVersion, pageKind: "trip_report", firstHand: true, generated: false,
          observedAt: "2024-06-15", observedAtBasis: "explicit", berths: [{ name: "Xyla Bay", island: null, kind: "anchorage" }], runId: runRef,
        });
      }
      let inFlight = 0;
      let peak = 0;
      const archive = {
        get: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return new TextEncoder().encode("We anchored off Ypsilon.");
        },
      };
      const runId = await runWithStage(tx, [ypsilon.placeId]);
      const jobs = await planResearchExtract(tx, { id: runId, params: { placeIds: [ypsilon.placeId] } }, config, archive);
      expect(jobs.flatMap((j) => j.unitIds as string[])).toHaveLength(12);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(8);
    }));

  it("does not sweep a unit of a place that is no searched place of the judged page (a nearby match of another run)", () =>
    withRollback(async (tx) => {
      const { vathi, versionId, archive } = await seed(tx);
      // in this run's scope, but neither searched on the page nor near Vathi: its unit came from another run's nearby matching
      const zeta = await insertPlace(tx, { name: "Zeta", lon: 31.0, lat: 40.2, status: "candidate" });
      const { model, promptVersion } = activeExtractor(config);
      const [unit] = await tx
        .insert(researchUnits)
        .values({ documentVersionId: versionId, placeId: zeta.placeId, model, promptVersion, status: "done", dropped: noDrops(), runId: await insertTestRun(tx) })
        .returning({ id: researchUnits.id });
      const runId = await runWithStage(tx, [vathi, zeta.placeId]);
      await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi, zeta.placeId] } }, config, archive);
      const [after] = await tx.select().from(researchUnits).where(eq(researchUnits.id, unit!.id));
      expect(after!.status).toBe("done");
    }));

  it("drops a batch answer that arrives for a unit swept to skipped", () =>
    withRollback(async (tx) => {
      const { ypsilon, archiveWith } = await xylaPage(tx, "We anchored off Ypsilon, holding was fine.");
      const runId = await runWithStage(tx, [ypsilon.placeId]);
      const [job] = await planResearchExtract(tx, { id: runId, params: { placeIds: [ypsilon.placeId] } }, config, archiveWith("We anchored off Ypsilon, holding was fine."));
      const model = new MockModel({
        "extract-berth": () => ({ core: [], facts: [], landing: [], signals: [{ kind: "anchored", first_hand: true, confidence: 0.9, quote: "We anchored off Ypsilon", observed_at: null }] }),
      });
      await extractUnits(tx, { model, boss, config, archive: archiveWith("We anchored off Ypsilon, holding was fine.") }, { runId, stage: RESEARCH_EXTRACT_STAGE, key: job!.key as string, unitIds: job!.unitIds as string[] });
      // the page now reads differently: a new plan sweeps the pending unit while its batch is out
      expect(await planResearchExtract(tx, { id: runId, params: { placeIds: [ypsilon.placeId] } }, config, archiveWith("Nothing about the place here."))).toEqual([]);
      const [batch] = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      await pollBatch(tx, { model, boss, config, handlers: BATCH_HANDLERS }, batch!.id);
      const [unit] = await tx.select().from(researchUnits).where(eq(researchUnits.placeId, ypsilon.placeId));
      expect(unit).toMatchObject({ status: "skipped", reason: "Liegeplatz auf der Seite nicht genannt" });
      expect(await tx.select().from(berthSignals).where(eq(berthSignals.placeId, ypsilon.placeId))).toHaveLength(0);
    }));

  it("marks a unit whose markdown is missing skipped with the reason", () =>
    withRollback(async (tx) => {
      const { vathi } = await seed(tx);
      const runId = await runWithStage(tx, [vathi]);
      const [job] = await planResearchExtract(tx, { id: runId, params: { placeIds: [vathi] } }, config, memoryArchive());
      const model = new MockModel({ "extract-berth": reply });
      const result = await extractUnits(tx, { model, boss, config, archive: memoryArchive() }, { runId, stage: RESEARCH_EXTRACT_STAGE, key: job!.key as string, unitIds: job!.unitIds as string[] });
      expect(result.submitted).toBe(0);
      const units = await tx.select().from(researchUnits).where(inArray(researchUnits.id, job!.unitIds as string[]));
      expect(units.every((u) => u.status === "skipped" && u.reason?.startsWith("archived markdown missing"))).toBe(true);
    }));

  it("does not send a unit a second time while another run's batch holds it", () =>
    withRollback(async (tx) => {
      const { vathi, archive } = await seed(tx);
      const model = new MockModel({ "extract-berth": reply });
      const first = await runWithStage(tx, [vathi]);
      const [job] = await planResearchExtract(tx, { id: first, params: { placeIds: [vathi] } }, config, memoryArchive());
      expect((await extractUnits(tx, { model, boss, config, archive }, { runId: first, stage: RESEARCH_EXTRACT_STAGE, key: job!.key as string, unitIds: job!.unitIds as string[] })).submitted).toBe(2);

      const second = await runWithStage(tx, [vathi]);
      const [again] = await planResearchExtract(tx, { id: second, params: { placeIds: [vathi] } }, config, memoryArchive());
      expect(again!.unitIds).toEqual(job!.unitIds);
      expect((await extractUnits(tx, { model, boss, config, archive }, { runId: second, stage: RESEARCH_EXTRACT_STAGE, key: again!.key as string, unitIds: again!.unitIds as string[] })).submitted).toBe(0);
    }));
});
