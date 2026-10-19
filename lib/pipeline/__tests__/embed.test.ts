import { asc, eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { chunks, documents, documentVersions, runs, sources } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import { STAGES } from "@/lib/jobs/stages";
import { assertEmbeddingDimension, EMBED_STAGE, embedChunks, planEmbedChunks } from "@/lib/pipeline/embed";
import { FETCH_RUN_STAGES, startEmbedBackfillRun } from "@/lib/pipeline/fetch/run";
import { withRollback } from "@/test/db";
import { VOYAGE_RECORDING_TEXTS } from "@/scripts/fixtures-record";

const cfg = () => ({ ...getConfig().embeddings, ratePerMinute: 1_000_000 });
const embedding = (v = 0.5) => Array.from({ length: 1024 }, () => v);

async function insertSource(tx: Db): Promise<string> {
  const [row] = await tx
    .insert(sources)
    .values({ domain: `${newId()}.test.invalid`, name: "Embed test", type: "pilot_guide", weight: 0.9, crawlRules: {}, origin: "manual" })
    .returning({ id: sources.id });
  return row!.id;
}

/** A version of a new document of `sourceId`, written by `runId`. */
async function insertVersion(tx: Db, sourceId: string, runId: string | null): Promise<string> {
  const url = `https://${newId()}.test.invalid/page`;
  const [doc] = await tx
    .insert(documents)
    .values({ sourceId, url, urlNormalized: url, docType: "pilot_guide" })
    .returning({ id: documents.id });
  const [version] = await tx
    .insert(documentVersions)
    .values({
      documentId: doc!.id,
      fetchedAt: new Date("2026-10-19T10:00:00Z"),
      contentHash: newId(),
      rawHash: "r",
      rawKey: `archive/${doc!.id}/raw.html`,
      mdKey: `archive/${doc!.id}/raw.md`,
      observedAt: "2026-10-19",
      observedAtBasis: "fetched",
      docType: "pilot_guide",
      converter: "local",
      charCount: 10,
      runId,
    })
    .returning({ id: documentVersions.id });
  return version!.id;
}

async function insertChunks(
  tx: Db,
  versionId: string,
  texts: string[],
  extra: { embedding?: number[]; carriedFromChunkId?: string } = {},
): Promise<string[]> {
  const rows = await tx
    .insert(chunks)
    .values(
      texts.map((text, ordinal) => ({
        documentVersionId: versionId,
        ordinal,
        text,
        textNormalized: text,
        textHash: `h${ordinal}`,
        charStart: 0,
        charEnd: text.length,
        wordCount: text.split(" ").length,
        embedding: extra.embedding ?? null,
        embeddingModel: extra.embedding ? "voyage-3.5" : null,
        carriedFromChunkId: extra.carriedFromChunkId ?? null,
      })),
    )
    .returning({ id: chunks.id });
  return rows.map((r) => r.id);
}

const newRun = (tx: Db, params: Record<string, unknown> = {}) =>
  createRun(tx, { kind: "stage", scope: { type: "system", id: "embed-test" }, stages: [], params, triggeredBy: "embed-test" });

describe("embed.chunks plan", () => {
  it("is the last stage of a crawl run and runs on its own queue", () => {
    expect(FETCH_RUN_STAGES.at(-1)).toBe(EMBED_STAGE);
    expect(STAGES[EMBED_STAGE]?.queue).toBe("embed.chunks");
  });

  it("the plan batches 130 empty chunks into 64, 64 and 2", async () => {
    await withRollback(async (tx) => {
      const { id: runId } = await newRun(tx);
      const sourceId = await insertSource(tx);
      const versionId = await insertVersion(tx, sourceId, runId);
      const ids = await insertChunks(tx, versionId, Array.from({ length: 130 }, (_, i) => `chunk ${i}`));
      // A version of another run is not this run's work.
      const otherRun = await newRun(tx);
      await insertChunks(tx, await insertVersion(tx, sourceId, otherRun.id), ["elsewhere"]);

      const jobs = await planEmbedChunks(tx, { id: runId, params: {} }, cfg());
      expect(jobs.map((j) => (j.chunkIds as string[]).length)).toEqual([64, 64, 2]);
      const sorted = [...ids].sort();
      expect(jobs.flatMap((j) => j.chunkIds as string[])).toEqual(sorted);
      expect(jobs.map((j) => j.key)).toEqual([sorted[0], sorted[64], sorted[128]]);
      for (const job of jobs) expect(job.sourceId).toBe(sourceId);
    });
  });

  it("batches per source, so every job's cost is booked on one source", async () => {
    await withRollback(async (tx) => {
      const { id: runId } = await newRun(tx);
      const a = await insertSource(tx);
      const b = await insertSource(tx);
      const aIds = await insertChunks(tx, await insertVersion(tx, a, runId), ["a1", "a2"]);
      const bIds = await insertChunks(tx, await insertVersion(tx, b, runId), ["b1"]);

      const jobs = await planEmbedChunks(tx, { id: runId, params: {} }, cfg());
      expect(jobs).toHaveLength(2);
      expect(jobs.find((j) => j.sourceId === a)?.chunkIds).toEqual([...aIds].sort());
      expect(jobs.find((j) => j.sourceId === b)?.chunkIds).toEqual(bIds);
    });
  });

  it("carried chunks with an embedding are not planned", async () => {
    await withRollback(async (tx) => {
      const { id: runId } = await newRun(tx);
      const sourceId = await insertSource(tx);
      const [origin] = await insertChunks(tx, await insertVersion(tx, sourceId, null), ["kept"], { embedding: embedding() });
      const versionId = await insertVersion(tx, sourceId, runId);
      await insertChunks(tx, versionId, ["kept"], { embedding: embedding(), carriedFromChunkId: origin });

      expect(await planEmbedChunks(tx, { id: runId, params: {} }, cfg())).toEqual([]);
    });
  });

  it("carried chunks whose origin had no embedding are planned like new ones", async () => {
    await withRollback(async (tx) => {
      const { id: runId } = await newRun(tx);
      const sourceId = await insertSource(tx);
      const [origin] = await insertChunks(tx, await insertVersion(tx, sourceId, null), ["kept"]);
      const [carried] = await insertChunks(tx, await insertVersion(tx, sourceId, runId), ["kept"], { carriedFromChunkId: origin });

      const jobs = await planEmbedChunks(tx, { id: runId, params: {} }, cfg());
      expect(jobs.flatMap((j) => j.chunkIds as string[])).toEqual([carried]);
    });
  });

  it("a backfill run (params.all) plans empty chunks of every run", async () => {
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx);
      const older = await newRun(tx);
      // Versions without a run (uploads before M3) and of an older run: only the backfill reaches them.
      const ids = [
        ...(await insertChunks(tx, await insertVersion(tx, sourceId, null), ["n1"])),
        ...(await insertChunks(tx, await insertVersion(tx, sourceId, older.id), ["o1"])),
      ];
      const { id: runId } = await newRun(tx, { all: true });
      const run = { id: runId, params: { all: true } };
      // The backfill reads the whole table; the cap takes the newest chunks, so this test's are always planned.
      // Look only at the jobs of this test's source.
      const own = (await planEmbedChunks(tx, run, cfg())).filter((j) => j.sourceId === sourceId);
      expect(own.flatMap((j) => j.chunkIds as string[])).toEqual([...ids].sort());
      expect(await planEmbedChunks(tx, { id: runId, params: {} }, cfg())).toEqual([]);
    });
  });
});

describe("embedChunks", () => {
  it("embedChunks skips chunks embedded in the meantime", async () => {
    await withRollback(async (tx) => {
      const sourceId = await insertSource(tx);
      const versionId = await insertVersion(tx, sourceId, null);
      // The recorded Voyage answer embeds exactly these two texts; the first chunk is embedded already.
      const [done] = await insertChunks(tx, versionId, ["embedded before"], { embedding: embedding(0.25) });
      const [first, second] = await insertChunks(
        tx,
        await insertVersion(tx, sourceId, null),
        [...VOYAGE_RECORDING_TEXTS],
      );
      const stage = `embed-test-${newId()}`;
      const result = await embedChunks(tx, [done!, first!, second!], { transport: fixtureTransport() }, { db: tx, stage, sourceId }, cfg());
      expect(result).toEqual({ embedded: 2 });

      const rows = await tx
        .select({ id: chunks.id, embedding: chunks.embedding, model: chunks.embeddingModel })
        .from(chunks)
        .where(inArray(chunks.id, [done!, first!, second!]))
        .orderBy(asc(chunks.id));
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(done!)!.embedding![0]).toBe(0.25);
      for (const id of [first!, second!]) {
        expect(byId.get(id)!.embedding).toHaveLength(1024);
        expect(byId.get(id)!.model).toBe("voyage-3.5");
      }
      // Everything embedded now: no call at all.
      const again = await embedChunks(tx, [done!, first!, second!], { transport: fixtureTransport() }, { db: tx, stage, sourceId }, cfg());
      expect(again).toEqual({ embedded: 0 });
    });
  });
});

describe("assertEmbeddingDimension", () => {
  it("assertEmbeddingDimension accepts 1024 and rejects 512", async () => {
    await withRollback(async (tx) => {
      await expect(assertEmbeddingDimension(tx, cfg())).resolves.toBeUndefined();
      await expect(assertEmbeddingDimension(tx, { ...cfg(), dimension: 512 })).rejects.toThrow(/vector\(1024\).*vector\(512\)/);
    });
  });
});

describe("startEmbedBackfillRun", () => {
  it("starts a run with only embed.chunks over all chunks", async () => {
    await withRollback(async (tx) => {
      const inserted: string[] = [];
      const boss = {
        insert: async (queue: string, jobs: Array<{ id: string }>) => {
          inserted.push(queue);
          return jobs.map((j) => j.id);
        },
      } as unknown as PgBoss;
      const { id } = await startEmbedBackfillRun(tx, boss, "embed-test");
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ stages: [EMBED_STAGE], params: { all: true }, scopeType: "system", scopeId: "embeddings" });
      expect(inserted.every((q) => q === "embed.chunks" || q === "run.advance")).toBe(true);
    });
  });
});
