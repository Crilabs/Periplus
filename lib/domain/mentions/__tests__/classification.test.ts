import { and, eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { quietDay } from "@/test/external-calls";
import { insertTestChunk } from "@/test/text";
import { estimateBatchItemCostsEur } from "@/lib/ai/cost";
import { MockModel } from "@/lib/ai/mock";
import { classifyDocumentTask, type ClassifyDocumentOutput } from "@/lib/ai/tasks/classify-document";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiBatchItems, documents, documentVersions, pipelinePasses, runStages } from "@/lib/db/schema";
import { BudgetExceeded } from "@/lib/domain/costs";
import { newId } from "@/lib/domain/ids";
import { beginStage, createRun } from "@/lib/domain/runs";
import { effectiveVersionMeta, firstWords, resolveObservedAt, storeClassification } from "../classification";
import { pollBatch } from "@/lib/pipeline/batches";
import { CLASSIFY_STAGE, classificationBatchEntry, classifyVersions, planClassify } from "@/lib/pipeline/text/classify";
import { textRunVersions } from "@/lib/pipeline/text/versions";

const base = loadConfig("config");
const config: AppConfig = { ...base, budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } } };
const EARLIEST = config.extraction.earliestDate;
const FETCHED = new Date("2026-10-19T10:00:00Z");

const answer = (o: Partial<ClassifyDocumentOutput> = {}): ClassifyDocumentOutput => ({
  doc_type: "trip_report",
  languages: ["de"],
  published_at: null,
  observed_at: null,
  observed_at_explicit: false,
  observed_at_reason: null,
  areas: [],
  ...o,
});

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

/** An in-memory archive holding the Markdown of the given versions. */
async function archiveOf(tx: Db, md: Record<string, string>) {
  const rows = await tx
    .select({ id: documentVersions.id, mdKey: documentVersions.mdKey })
    .from(documentVersions)
    .where(inArray(documentVersions.id, Object.keys(md)));
  const byKey = new Map(rows.map((r) => [r.mdKey, new TextEncoder().encode(md[r.id])]));
  return { get: async (key: string) => byKey.get(key) ?? null };
}

async function classifyRun(tx: Db, params: Record<string, unknown>): Promise<string> {
  const { id } = await createRun(tx, {
    kind: "reprocess",
    scope: { type: "system", id: `classify-test-${newId()}` },
    stages: [CLASSIFY_STAGE],
    params,
    triggeredBy: "test",
  });
  return id;
}

async function versionRow(tx: Db, id: string) {
  const [row] = await tx.select().from(documentVersions).where(eq(documentVersions.id, id));
  return row!;
}

describe("observed date", () => {
  it("'Wir waren im Mai 2024' gives 2024-05-15 explicit", () => {
    const out = answer({ observed_at: "2024-05", observed_at_explicit: true, observed_at_reason: "Wir waren im Mai 2024" });
    expect(resolveObservedAt(out, FETCHED, EARLIEST)).toEqual({ observedAt: "2024-05-15", basis: "explicit", publishedAt: null });
  });

  it("without an explicit date the published date wins, else the fetch date", () => {
    expect(resolveObservedAt(answer({ published_at: "2025-03-02" }), FETCHED, EARLIEST)).toEqual({
      observedAt: "2025-03-02",
      basis: "published",
      publishedAt: "2025-03-02",
    });
    // a date the model did not mark explicit does not count as observed
    expect(resolveObservedAt(answer({ observed_at: "2024-05-01", published_at: "2025-03-02" }), FETCHED, EARLIEST).basis).toBe("published");
    expect(resolveObservedAt(answer(), FETCHED, EARLIEST)).toEqual({ observedAt: "2026-10-19", basis: "fetched", publishedAt: null });
  });

  it("a future or pre-1990 date is ignored", () => {
    for (const bad of ["2027-01-01", "1989-12-31", "2024-02-30", "Mai 2024", "2024-13"]) {
      expect(resolveObservedAt(answer({ observed_at: bad, observed_at_explicit: true, published_at: bad }), FETCHED, EARLIEST)).toEqual({
        observedAt: "2026-10-19",
        basis: "fetched",
        publishedAt: null,
      });
    }
    // a publication date is a day, never a month
    expect(resolveObservedAt(answer({ published_at: "2024-05" }), FETCHED, EARLIEST).publishedAt).toBeNull();
  });

  it("a month-only date in the fetch month is clamped to the fetch date (ruling M4-D-R3)", () => {
    const early = new Date("2026-10-05T08:00:00Z");
    const out = answer({ observed_at: "2026-10", observed_at_explicit: true });
    expect(resolveObservedAt(out, early, EARLIEST)).toEqual({ observedAt: "2026-10-05", basis: "explicit", publishedAt: null });
    // after the 15th the month stays on the 15th; a later month is still dropped
    expect(resolveObservedAt(out, FETCHED, EARLIEST).observedAt).toBe("2026-10-15");
    expect(resolveObservedAt(answer({ observed_at: "2026-11", observed_at_explicit: true }), early, EARLIEST).basis).toBe("fetched");
    // a full day after the fetch date is not clamped
    expect(resolveObservedAt(answer({ observed_at: "2026-10-07", observed_at_explicit: true }), early, EARLIEST).basis).toBe("fetched");
  });

  it("firstWords keeps the text up to the n-th word", () => {
    expect(firstWords("# Poros\n\nWir  ankerten vor Kolona.", 3)).toBe("# Poros\n\nWir");
    expect(firstWords("kurz", 1500)).toBe("kurz");
  });
});

describe("classification storage", () => {
  it("the effective meta prefers the classification over the fetch columns", () =>
    withRollback(async (tx) => {
      const { versionId, sourceId } = await insertTestChunk(tx);
      expect(await effectiveVersionMeta(tx, versionId)).toEqual({
        docType: "trip_report",
        languages: [],
        observedAt: "2026-10-19",
        basis: "fetched",
        areaHints: [],
        sourceId,
        fetchedAt: FETCHED,
      });
      const runId = await classifyRun(tx, {});
      await storeClassification(
        tx,
        versionId,
        answer({
          doc_type: "pilot_guide",
          languages: ["EN", "el", "english", "en", "fr", "it", "es", "pt"],
          observed_at: "2024-05",
          observed_at_explicit: true,
          observed_at_reason: "x".repeat(400),
          areas: Array.from({ length: 12 }, (_, i) => `Area ${i}`),
        }),
        { model: "claude-haiku-5-5", promptVersion: 1, runId, fetchedAt: FETCHED },
        EARLIEST,
      );
      const meta = await effectiveVersionMeta(tx, versionId);
      expect(meta).toMatchObject({ docType: "pilot_guide", languages: ["en", "el", "fr", "it", "es"], observedAt: "2024-05-15", basis: "explicit" });
      expect(meta.areaHints).toHaveLength(10);
      const row = await versionRow(tx, versionId);
      expect(row.observedAtReason).toHaveLength(300);
      // the fetch-time columns never change
      expect(row).toMatchObject({ docType: "trip_report", observedAt: "2026-10-19", observedAtBasis: "fetched", classifiedRunId: runId });

      // the same model and prompt version again: nothing changes
      await storeClassification(tx, versionId, answer({ doc_type: "forum" }), { model: "claude-haiku-5-5", promptVersion: 1, runId, fetchedAt: FETCHED }, EARLIEST);
      expect((await versionRow(tx, versionId)).classifiedDocType).toBe("pilot_guide");
      // a new prompt version overwrites once it is the active one (ruling M4-P11)
      const v2 = { model: "claude-haiku-5-5", promptVersion: 2 };
      expect(await storeClassification(tx, versionId, answer({ doc_type: "forum" }), { ...v2, runId, fetchedAt: FETCHED }, EARLIEST)).toBe(false);
      expect((await versionRow(tx, versionId)).classifiedDocType).toBe("pilot_guide");
      expect(await storeClassification(tx, versionId, answer({ doc_type: "forum" }), { ...v2, runId, fetchedAt: FETCHED }, EARLIEST, v2)).toBe(true);
      expect(await versionRow(tx, versionId)).toMatchObject({ classifiedDocType: "forum", classifiedPromptVersion: 2, classifiedObservedAtBasis: "fetched" });
    }));

  it("a late result of an older prompt version or another model never overwrites a newer classification", () =>
    withRollback(async (tx) => {
      const { versionId } = await insertTestChunk(tx);
      const runId = await classifyRun(tx, {});
      const active = { model: "claude-haiku-5-5", promptVersion: 2 };
      await storeClassification(tx, versionId, answer({ doc_type: "forum" }), { ...active, runId, fetchedAt: FETCHED }, EARLIEST, active);
      const stale = [
        { model: "claude-haiku-5-5", promptVersion: 1 },
        { model: "claude-sonnet-5-5", promptVersion: 2 },
      ];
      for (const old of stale) {
        expect(await storeClassification(tx, versionId, answer({ doc_type: "marina" }), { ...old, runId, fetchedAt: FETCHED }, EARLIEST, active)).toBe(false);
      }
      expect(await versionRow(tx, versionId)).toMatchObject({ classifiedDocType: "forum", classifiedPromptVersion: 2, classifiedModel: "claude-haiku-5-5" });
    }));
});

describe("stage classify.document_version", () => {
  it("the stage plans only unclassified versions and stores one row per version", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const a = await insertTestChunk(tx);
      const b = await insertTestChunk(tx);
      const archive = await archiveOf(tx, {
        [a.versionId]: "# Poros Logbuch\n\nWir waren im Mai 2024 vor Poros.",
        [b.versionId]: "Marina Zea, prices 2026.",
      });
      const seen: unknown[] = [];
      const model = new MockModel({
        "classify-document": (input) => {
          seen.push(input);
          const { text } = input as { text: string };
          return text.includes("Mai 2024")
            ? answer({ observed_at: "2024-05", observed_at_explicit: true, observed_at_reason: "Wir waren im Mai 2024", areas: ["Poros"] })
            : answer({ doc_type: "marina", languages: ["en"] });
        },
      });
      const { boss } = recordingBoss();
      const runId = await classifyRun(tx, { documentVersionIds: [a.versionId, b.versionId] });
      const deps = { model, boss, config, archive, now: () => now, reservationScope: { runIds: [runId] } };

      const jobs = await planClassify(tx, { id: runId, params: { documentVersionIds: [a.versionId, b.versionId] } }, config);
      expect(jobs).toEqual([{ key: "classify:0", documentVersionIds: [a.versionId, b.versionId].sort() }]);
      await beginStage(tx, runId, CLASSIFY_STAGE, jobs.length);
      const job = { runId, stage: CLASSIFY_STAGE, key: jobs[0]!.key, documentVersionIds: jobs[0]!.documentVersionIds as string[] };

      expect(await classifyVersions(tx, deps, job)).toEqual({ submitted: 2, remainder: 0, reused: false });
      // a retried job reuses its batch
      expect(await classifyVersions(tx, deps, job)).toMatchObject({ reused: true, remainder: 0 });
      const batches = await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId));
      expect(batches).toHaveLength(1);

      const handlers = { "classify-document": classificationBatchEntry };
      expect(await pollBatch(tx, { ...deps, handlers }, batches[0]!.id)).toBe("distributed");
      expect(seen).toContainEqual(expect.objectContaining({ title: "Poros Logbuch", fetchedAt: "2026-10-19" }));
      expect(seen).toContainEqual(expect.objectContaining({ title: null, text: "Marina Zea, prices 2026." }));
      expect(await versionRow(tx, a.versionId)).toMatchObject({
        classifiedDocType: "trip_report",
        classifiedObservedAt: "2024-05-15",
        classifiedObservedAtBasis: "explicit",
        observedAtReason: "Wir waren im Mai 2024",
        areaHints: ["Poros"],
        classifiedModel: "claude-haiku-5-5",
        classifiedPromptVersion: 1,
        classifiedRunId: runId,
      });
      expect(await versionRow(tx, b.versionId)).toMatchObject({ classifiedDocType: "marina", classifiedLanguages: ["en"] });
      const classifiedAt = (await versionRow(tx, a.versionId)).classifiedAt;

      // a second distribution of the same items changes nothing, a second plan finds nothing
      expect(await pollBatch(tx, { ...deps, handlers }, batches[0]!.id)).toBe("distributed");
      expect((await versionRow(tx, a.versionId)).classifiedAt).toEqual(classifiedAt);
      expect(await planClassify(tx, { id: runId, params: { documentVersionIds: [a.versionId, b.versionId] } }, config)).toEqual([]);
      const [stage] = await tx.select().from(runStages).where(and(eq(runStages.runId, runId), eq(runStages.stage, CLASSIFY_STAGE)));
      expect(stage).toMatchObject({ total: 2, done: 1 });
    }));

  it("a batch is sized to the budget headroom; the rest goes to one follow-on job, no room defers the job", () =>
    withRollback(async (tx) => {
      const now = new Date((await quietDay(tx)).getTime() + 12 * 3_600_000);
      const versions = [await insertTestChunk(tx), await insertTestChunk(tx), await insertTestChunk(tx)].map((v) => v.versionId).sort();
      const archive = await archiveOf(tx, Object.fromEntries(versions.map((id) => [id, "Kurzer Text über Poros."])));
      const model = new MockModel({ "classify-document": () => answer() });
      const { boss, inserted } = recordingBoss();
      const runId = await classifyRun(tx, { documentVersionIds: versions });
      await beginStage(tx, runId, CLASSIFY_STAGE, 1);
      const job = { runId, stage: CLASSIFY_STAGE, key: "classify:0", documentVersionIds: versions };

      // room for exactly two items
      const [cost] = estimateBatchItemCostsEur(config, classifyDocumentTask, [
        { title: null, url: "https://x.test.invalid/page", fetchedAt: "2026-10-19", text: "Kurzer Text über Poros." },
      ]);
      const tight: AppConfig = { ...config, budgets: { ...config.budgets, anthropic: { dailyEur: cost! * 2.5 } } };
      const deps = { model, boss, config: tight, archive, now: () => now, reservationScope: { runIds: [runId] } };

      expect(await classifyVersions(tx, deps, job)).toEqual({ submitted: 2, remainder: 1, reused: false });
      const followOn = inserted.filter((j) => j.queue === "classify.document_version");
      expect(followOn).toHaveLength(1);
      expect(followOn[0]!.data).toMatchObject({ key: "classify:0+", documentVersionIds: [versions[2]], runId, stage: CLASSIFY_STAGE });
      const stageTotal = async () =>
        (await tx.select().from(runStages).where(and(eq(runStages.runId, runId), eq(runStages.stage, CLASSIFY_STAGE))))[0]!.total;
      // 1 planned job + its batch + the follow-on job
      expect(await stageTotal()).toBe(3);

      // the retried job reuses its batch and hands on nothing twice
      expect(await classifyVersions(tx, deps, job)).toMatchObject({ reused: true, remainder: 1 });
      expect(inserted.filter((j) => j.queue === "classify.document_version")).toHaveLength(1);
      expect(await stageTotal()).toBe(3);

      // the follow-on job finds no room while the first batch is reserved: deferred, nothing stored
      const next = { ...job, key: "classify:0+", documentVersionIds: [versions[2]!] };
      await expect(classifyVersions(tx, deps, next)).rejects.toBeInstanceOf(BudgetExceeded);
      expect(await tx.select().from(aiBatches).where(eq(aiBatches.runId, runId))).toHaveLength(1);
      expect(await stageTotal()).toBe(3);
      const items = await tx.select().from(aiBatchItems).innerJoin(aiBatches, eq(aiBatches.id, aiBatchItems.batchId)).where(eq(aiBatches.runId, runId));
      expect(items.map((i) => i.ai_batch_items.subjectId).sort()).toEqual(versions.slice(0, 2));
    }));

  it("textRunVersions takes the given versions and the pending current versions of active documents", () =>
    withRollback(async (tx) => {
      const fresh = await insertTestChunk(tx);
      const passed = await insertTestChunk(tx);
      const notCurrent = await insertTestChunk(tx);
      for (const v of [fresh, passed]) {
        const [row] = await tx.select({ documentId: documentVersions.documentId }).from(documentVersions).where(eq(documentVersions.id, v.versionId));
        await tx.update(documents).set({ currentVersionId: v.versionId }).where(eq(documents.id, row!.documentId));
      }
      await tx.insert(pipelinePasses).values({ documentVersionId: passed.versionId, stage: "mentions.batch", configKey: "test" });

      const pending = await textRunVersions(tx, { pending: true }, config);
      expect(pending).toContain(fresh.versionId);
      expect(pending).not.toContain(passed.versionId);
      expect(pending).not.toContain(notCurrent.versionId);
      const missing = newId();
      expect(await textRunVersions(tx, { documentVersionIds: [passed.versionId, missing] }, config)).toEqual([passed.versionId]);
    }));
});
