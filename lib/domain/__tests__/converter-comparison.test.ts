import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Converter, ConverterName, Converted } from "@/lib/adapters/fetch";
import { makeResponse, RetryableHttpError, type Transport } from "@/lib/adapters/http";
import type { Db } from "@/lib/db/client";
import { converterOutputs, converterSamples, documents, documentVersions, sources } from "@/lib/db/schema";
import {
  CONVERTER_SAMPLE,
  comparisonMdKey,
  converterSummary,
  pickConverterSample,
  rateConverterOutput,
  samplesToCompare,
} from "@/lib/domain/converter-comparison";
import { BudgetExceeded } from "@/lib/domain/costs";
import { newId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import { COMPARE_STAGE, compareSample } from "@/lib/pipeline/compare-converters";
import { COMPARISON_LOCK, startConverterComparison } from "@/lib/pipeline/compare-converters-run";
import { startWhileLocked, testDb, withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import type { PgBoss } from "pg-boss";

async function insertSource(tx: Db, status: "approved" | "paused" = "approved") {
  const domain = `${newId()}.test.invalid`;
  const [row] = await tx
    .insert(sources)
    .values({ domain, name: domain, type: "pilot_guide", weight: 0.9, status, crawlRules: { render: "never" }, origin: "manual" })
    .returning({ id: sources.id });
  return { id: row!.id, domain };
}

/** `n` active documents of the source whose current version is archived HTML (`ext` "pdf" for other formats). */
async function insertDocuments(tx: Db, source: { id: string; domain: string }, n: number, ext = "html") {
  for (let i = 0; i < n; i++) {
    const url = `https://${source.domain}/page-${i}`;
    const [doc] = await tx.insert(documents).values({ sourceId: source.id, url, urlNormalized: url, docType: "pilot_guide" }).returning({ id: documents.id });
    const [version] = await tx
      .insert(documentVersions)
      .values({
        documentId: doc!.id,
        fetchedAt: new Date(),
        contentHash: newId(),
        rawHash: newId(),
        rawKey: `archive/${doc!.id}/x.raw.${ext}`,
        mdKey: `archive/${doc!.id}/x.md`,
        observedAt: "2026-10-19",
        observedAtBasis: "fetched",
        docType: "pilot_guide",
        converter: "local",
        charCount: 100,
      })
      .returning({ id: documentVersions.id });
    await tx.update(documents).set({ currentVersionId: version!.id }).where(eq(documents.id, doc!.id));
  }
}

async function insertSample(tx: Db) {
  const source = await insertSource(tx);
  const url = `https://${source.domain}/anchorage`;
  const [sample] = await tx.insert(converterSamples).values({ sourceId: source.id, url, urlNormalized: url }).returning({ id: converterSamples.id });
  return { sampleId: sample!.id, source, url };
}

const PAGE = "<!doctype html><html><head><title>Bay</title></head><body><article><h1>Bay</h1><p>Good holding in sand.</p></article></body></html>";

/** robots.txt: 404 (all allowed); every other URL: the page. */
const siteTransport: Transport = async (req) =>
  req.url.endsWith("/robots.txt")
    ? makeResponse(404, new Uint8Array())
    : makeResponse(200, new TextEncoder().encode(PAGE), { headers: { "content-type": "text/html; charset=utf-8" } });

function fakeConverter(name: ConverterName, behave: { fail?: Error } = {}): Converter & { inputs: Array<string | null> } {
  const inputs: Array<string | null> = [];
  return {
    name,
    inputs,
    async convert(input): Promise<Converted> {
      inputs.push(input.html);
      if (behave.fail) throw behave.fail;
      return { markdown: `# Bay by ${name}\n\nGood holding in sand.`, title: "Bay", publishedHint: null, rendered: false, durationMs: 12, costEur: name === "local" ? 0 : 0.002 };
    },
  };
}

function converters(over: Partial<Record<ConverterName, Converter>> = {}): Record<ConverterName, Converter> {
  return { local: fakeConverter("local"), jina: fakeConverter("jina"), firecrawl: fakeConverter("firecrawl"), ...over };
}

async function comparisonRun(tx: Db) {
  return createRun(tx, { kind: "stage", scope: { type: "system", id: "converters" }, stages: [COMPARE_STAGE], triggeredBy: "test" });
}

const outputsOf = (tx: Db, sampleId: string) =>
  tx.select().from(converterOutputs).where(eq(converterOutputs.sampleId, sampleId)).orderBy(converterOutputs.converter);

describe("converter comparison sample", () => {
  it("the sample takes 5 pages from each of the 10 largest approved sources", () =>
    withRollback(async (tx) => {
      // 12 sources with 6..17 HTML documents: the 10 with 8..17 are the largest.
      const own: Array<{ id: string; domain: string }> = [];
      for (let i = 0; i < 12; i++) {
        const source = await insertSource(tx);
        await insertDocuments(tx, source, 6 + i);
        own.push(source);
      }
      // Neither a paused source nor PDFs nor uploads count, however many documents they have.
      const paused = await insertSource(tx, "paused");
      await insertDocuments(tx, paused, 40);
      const pdfs = await insertSource(tx);
      await insertDocuments(tx, pdfs, 40, "pdf");

      const result = await pickConverterSample(tx);
      expect(result).toEqual({ added: CONVERTER_SAMPLE.pages, sources: CONVERTER_SAMPLE.sources });
      const rows = await tx.select().from(converterSamples);
      expect(rows).toHaveLength(50);
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.sourceId, (counts.get(r.sourceId) ?? 0) + 1);
      expect([...counts.keys()].sort()).toEqual(own.slice(2).map((s) => s.id).sort());
      expect([...counts.values()]).toEqual(Array(10).fill(5));

      // The existing sample stays: a second pick adds nothing.
      expect(await pickConverterSample(tx)).toEqual({ added: 0, sources: 10 });
      expect(await tx.select().from(converterSamples)).toHaveLength(50);
    }));
});

describe("compareSample", () => {
  it("a converter error is stored and the others still run", () =>
    withRollback(async (tx) => {
      const { sampleId } = await insertSample(tx);
      const { id: runId } = await comparisonRun(tx);
      const archive = memoryArchive();
      const c = converters({ jina: fakeConverter("jina", { fail: new Error("jina is down") }) });
      await compareSample(tx, sampleId, { transport: siteTransport, archive, converters: c, isAllowed: async () => true }, { db: tx, runId, stage: COMPARE_STAGE });

      const rows = await outputsOf(tx, sampleId);
      expect(rows.map((r) => [r.converter, r.error])).toEqual([
        ["jina", "jina is down"],
        ["firecrawl", null],
        ["local", null],
      ]);
      const local = rows.find((r) => r.converter === "local")!;
      expect(local).toMatchObject({ mdKey: comparisonMdKey(sampleId, "local"), durationMs: 12, costEur: "0.000000" });
      expect(local.chars).toBe("# Bay by local\n\nGood holding in sand.".length);
      expect(rows.find((r) => r.converter === "firecrawl")!.costEur).toBe("0.002000");
      expect(archive.keys()).toEqual(
        expect.arrayContaining([comparisonMdKey(sampleId, "local"), comparisonMdKey(sampleId, "firecrawl")]),
      );
      expect(archive.keys()).not.toContain(comparisonMdKey(sampleId, "jina"));
      // The local converter gets the fetched HTML, Jina and Firecrawl only the URL.
      expect((c.local as ReturnType<typeof fakeConverter>).inputs).toEqual([PAGE]);
      expect((c.firecrawl as ReturnType<typeof fakeConverter>).inputs).toEqual([null]);
      expect(await samplesToCompare(tx)).toEqual([sampleId]);
    }));

  it("a retried sample does not duplicate outputs", () =>
    withRollback(async (tx) => {
      const { sampleId } = await insertSample(tx);
      const { id: runId } = await comparisonRun(tx);
      const archive = memoryArchive();
      const ctx = { db: tx, runId, stage: COMPARE_STAGE };
      const isAllowed = async () => true;
      await compareSample(tx, sampleId, { transport: siteTransport, archive, converters: converters({ jina: fakeConverter("jina", { fail: new Error("timeout") }) }), isAllowed }, ctx);
      await rateConverterOutput(tx, { sampleId, converter: "local", rating: { mainContent: true, boilerplateRemoved: true, tablesKept: null }, by: "admin" });

      // The retry converts only what is missing: the rated local output stays as it is.
      const second = converters();
      await compareSample(tx, sampleId, { transport: siteTransport, archive, converters: second, isAllowed }, ctx);
      await compareSample(tx, sampleId, { transport: siteTransport, archive, converters: second, isAllowed }, ctx);
      const rows = await outputsOf(tx, sampleId);
      expect(rows.map((r) => [r.converter, r.error])).toEqual([
        ["jina", null],
        ["firecrawl", null],
        ["local", null],
      ]);
      expect(rows.find((r) => r.converter === "local")!.rating).toEqual({ mainContent: true, boilerplateRemoved: true, tablesKept: null });
      expect((second.jina as ReturnType<typeof fakeConverter>).inputs).toHaveLength(1);
      expect((second.local as ReturnType<typeof fakeConverter>).inputs).toHaveLength(0);
      expect(await samplesToCompare(tx)).toEqual([]);
    }));

  it("a temporary converter failure is stored, the others still run, and the job is retried for it", () =>
    withRollback(async (tx) => {
      const { sampleId } = await insertSample(tx);
      const { id: runId } = await comparisonRun(tx);
      const ctx = { db: tx, runId, stage: COMPARE_STAGE };
      const isAllowed = async () => true;
      const archive = memoryArchive();
      const busy = converters({ jina: fakeConverter("jina", { fail: new RetryableHttpError("HTTP 503 from jina", 503) }) });
      await expect(compareSample(tx, sampleId, { transport: siteTransport, archive, converters: busy, isAllowed }, ctx)).rejects.toBeInstanceOf(
        RetryableHttpError,
      );
      expect((await outputsOf(tx, sampleId)).map((r) => [r.converter, r.error])).toEqual([
        ["jina", "HTTP 503 from jina"],
        ["firecrawl", null],
        ["local", null],
      ]);

      // The retry converts only Jina.
      const retry = converters();
      await compareSample(tx, sampleId, { transport: siteTransport, archive, converters: retry, isAllowed }, ctx);
      expect((await outputsOf(tx, sampleId)).every((r) => r.error === null)).toBe(true);
      expect((retry.local as ReturnType<typeof fakeConverter>).inputs).toHaveLength(0);
      expect((retry.jina as ReturnType<typeof fakeConverter>).inputs).toHaveLength(1);
    }));

  it("an exceeded budget is thrown, a robots ban is stored for every converter", () =>
    withRollback(async (tx) => {
      const { sampleId } = await insertSample(tx);
      const { id: runId } = await comparisonRun(tx);
      const ctx = { db: tx, runId, stage: COMPARE_STAGE };
      const isAllowed = async () => true;
      const broke = converters({ firecrawl: fakeConverter("firecrawl", { fail: new BudgetExceeded("firecrawl", 5, 5) }) });
      await expect(
        compareSample(tx, sampleId, { transport: siteTransport, archive: memoryArchive(), converters: broke, isAllowed }, ctx),
      ).rejects.toBeInstanceOf(BudgetExceeded);

      const banned: Transport = async (req) =>
        req.url.endsWith("/robots.txt") ? makeResponse(200, new TextEncoder().encode("User-agent: *\nDisallow: /\n")) : siteTransport(req);
      const { sampleId: other } = await insertSample(tx);
      const c = converters();
      await compareSample(tx, other, { transport: banned, archive: memoryArchive(), converters: c, isAllowed }, ctx);
      expect((await outputsOf(tx, other)).map((r) => r.error)).toEqual(["robots", "robots", "robots"]);
      expect((c.jina as ReturnType<typeof fakeConverter>).inputs).toEqual([]);
    }));
});

describe("ratings and summary", () => {
  it("summary percentages count only rated pages", () =>
    withRollback(async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { sampleId } = await insertSample(tx);
        ids.push(sampleId);
        await tx.insert(converterOutputs).values({ sampleId, converter: "local", mdKey: comparisonMdKey(sampleId, "local"), chars: 100 * (i + 1), durationMs: 10, costEur: "0" });
      }
      await tx.insert(converterOutputs).values({ sampleId: ids[0]!, converter: "jina", error: "HTTP 500" });
      await rateConverterOutput(tx, { sampleId: ids[0]!, converter: "local", rating: { mainContent: true, boilerplateRemoved: true, tablesKept: true }, by: "a" });
      await rateConverterOutput(tx, { sampleId: ids[1]!, converter: "local", rating: { mainContent: false, boilerplateRemoved: true, tablesKept: null }, by: "a" });
      await expect(
        rateConverterOutput(tx, { sampleId: ids[0]!, converter: "jina", rating: { mainContent: true, boilerplateRemoved: true, tablesKept: null }, by: "a" }),
      ).rejects.toThrow(/no successful jina output/);

      const summary = await converterSummary(tx);
      expect(summary.map((s) => s.converter)).toEqual(["jina", "firecrawl", "local"]);
      expect(summary.find((s) => s.converter === "local")).toEqual({
        converter: "local",
        pages: 3,
        errors: 0,
        rated: 2,
        mainContentPct: 50,
        boilerplatePct: 100,
        tablesPct: 100,
        avgCostEur: 0,
        avgDurationMs: 10,
        avgChars: 200,
      });
      expect(summary.find((s) => s.converter === "jina")).toMatchObject({ pages: 1, errors: 1, rated: 0, mainContentPct: null, tablesPct: null });
      expect(summary.find((s) => s.converter === "firecrawl")).toMatchObject({ pages: 0, rated: 0, mainContentPct: null });
    }));
});

describe("startConverterComparison", () => {
  function recordingBoss() {
    const inserted: Array<{ queue: string; data: unknown }> = [];
    const boss = {
      async insert(queue: string, jobs: Array<{ data: unknown }>) {
        for (const j of jobs) inserted.push({ queue, data: j.data });
        return jobs.map(() => newId());
      },
    } as unknown as PgBoss;
    return { boss, inserted };
  }

  it("picks the sample and queues only samples without three outputs; refuses without samples", () =>
    withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      await expect(startConverterComparison(tx, boss, "admin")).rejects.toMatchObject({ reason: "no_converter_samples" });
      expect(inserted).toEqual([]);

      const source = await insertSource(tx);
      await insertDocuments(tx, source, 6);
      const done = await insertSample(tx);
      for (const converter of ["jina", "firecrawl", "local"] as const) {
        await tx.insert(converterOutputs).values({ sampleId: done.sampleId, converter, mdKey: comparisonMdKey(done.sampleId, converter) });
      }
      const started = await startConverterComparison(tx, boss, "admin");
      expect(started.samples).toBe(5);
      const own = await tx.select({ id: converterSamples.id }).from(converterSamples).where(eq(converterSamples.sourceId, source.id));
      expect(inserted.filter((j) => j.queue === "compare.converters").map((j) => (j.data as { sampleId: string }).sampleId).sort()).toEqual(
        own.map((r) => r.id).sort(),
      );
      await expect(startConverterComparison(tx, boss, "admin")).rejects.toMatchObject({ reason: "comparison_run_active" });
      expect(await tx.select().from(converterSamples).where(inArray(converterSamples.id, [done.sampleId]))).toHaveLength(1);
    }));

  it("a start waits for another start's lock, so two concurrent starts cannot both pass the check", async () => {
    const { boss, inserted } = recordingBoss();
    await expect(startWhileLocked(testDb(), COMPARISON_LOCK, (tx) => startConverterComparison(tx, boss, "admin"))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "55P03" }),
    });
    expect(inserted).toEqual([]);
  });
});
