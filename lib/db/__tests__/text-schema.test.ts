import { eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  aiBatches,
  ambiguousMatches,
  documentVersions,
  facts,
  mentions,
  routes,
  routeStops,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import { withRollback } from "@/test/db";
import {
  insertTestChunk,
  insertTestExtractionRun,
  insertTestMention,
  insertTestRun,
  type TestMention,
} from "@/test/text";

/** drizzle wraps driver errors ("Failed query"); the Postgres message lives on `cause`. */
async function rejectionMessage(tx: Db, run: (tx: Db) => Promise<unknown>): Promise<string> {
  try {
    // savepoint, so the surrounding transaction survives the expected failure
    await tx.transaction(async (sp) => {
      await run(sp);
    });
  } catch (e) {
    const err = e as Error;
    return `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
  }
  throw new Error("expected promise to reject");
}

function textFact(
  m: TestMention,
  extractionRunId: string,
  values: Partial<PgInsertValue<typeof facts>> = {},
): PgInsertValue<typeof facts> {
  return {
    geoObjectId: m.geoObjectId,
    attribute: "holding",
    value: "good",
    mentionId: m.mentionId,
    extractionRunId,
    quote: "Good holding in sand",
    quoteVerified: true,
    quoteChunkId: m.chunkId,
    quoteStart: 0,
    quoteEnd: 20,
    observedAt: "2026-10-19",
    confidence: 0.8,
    factSchemaVersion: "v2",
    ...values,
  };
}

async function insertRoute(tx: Db, m: TestMention): Promise<string> {
  const extractionRunId = await insertTestExtractionRun(tx, { task: "extract-route" });
  const [row] = await tx
    .insert(routes)
    .values({ documentVersionId: m.versionId, extractionRunId, stopsCount: 1 })
    .returning({ id: routes.id });
  return row!.id;
}

function stopValues(routeId: string, m: TestMention, values: Partial<PgInsertValue<typeof routeStops>> = {}) {
  return {
    routeId,
    ordinal: 0,
    name: "Good",
    geoObjectId: m.geoObjectId,
    mentionId: m.mentionId,
    mooring: "anchor" as const,
    quote: "Good holding",
    quoteVerified: true,
    quoteChunkId: m.chunkId,
    ...values,
  };
}

/** One row of the given append-only table; returns its id. */
async function insertRow(tx: Db, table: string): Promise<string> {
  const m = await insertTestMention(tx);
  if (table === "mentions") return m.mentionId;
  if (table === "facts") {
    const [row] = await tx
      .insert(facts)
      .values(textFact(m, await insertTestExtractionRun(tx)))
      .returning({ id: facts.id });
    return row!.id;
  }
  const routeId = await insertRoute(tx, m);
  if (table === "routes") return routeId;
  const [stop] = await tx.insert(routeStops).values(stopValues(routeId, m)).returning({ id: routeStops.id });
  return stop!.id;
}

describe("text schema", () => {
  it.each(["mentions", "facts", "routes", "route_stops"])("%s rejects UPDATE and DELETE", async (table) => {
    await withRollback(async (tx) => {
      const id = await insertRow(tx, table);
      const update = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`update ${sql.identifier(table)} set created_at = now() - interval '1 day' where id = ${id}`),
      );
      expect(update).toMatch(new RegExp(`${table} is append-only`));
      const del = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`delete from ${sql.identifier(table)} where id = ${id}`),
      );
      expect(del).toMatch(new RegExp(`${table} is append-only`));
    });
  });

  it("mentions allow only extraction_status to change", async () => {
    await withRollback(async (tx) => {
      const { mentionId } = await insertTestMention(tx);
      const [row] = await tx
        .update(mentions)
        .set({ extractionStatus: "done" })
        .where(eq(mentions.id, mentionId))
        .returning({ status: mentions.extractionStatus });
      expect(row).toEqual({ status: "done" });

      const message = await rejectionMessage(tx, (sp) =>
        sp.update(mentions).set({ confidence: 0.5 }).where(eq(mentions.id, mentionId)),
      );
      expect(message).toMatch(/mentions is append-only/);
    });
  });

  it("a mention confidence outside 0..1 is rejected", async () => {
    await withRollback(async (tx) => {
      const message = await rejectionMessage(tx, (sp) => insertTestMention(sp, { confidence: 1.2 }));
      expect(message).toMatch(/mentions_confidence_range/);
    });
  });

  it("(chunk_id, geo_object_id, char_start) is unique for mentions", async () => {
    await withRollback(async (tx) => {
      const m = await insertTestMention(tx);
      const again = {
        documentVersionId: m.versionId,
        chunkId: m.chunkId,
        geoObjectId: m.geoObjectId,
        surface: "Good",
        charStart: 0,
        charEnd: 4,
        observedAt: "2026-10-19",
        confidence: 0.9,
        matchKind: "model" as const,
      };
      const message = await rejectionMessage(tx, (sp) => sp.insert(mentions).values(again));
      expect(message).toMatch(/mentions_chunk_geo_object_char_start_unique/);
      await expect(tx.insert(mentions).values({ ...again, charStart: 5, charEnd: 12 })).resolves.toBeTruthy();
    });
  });

  it("a text fact without a verified quote is impossible", async () => {
    await withRollback(async (tx) => {
      const m = await insertTestMention(tx);
      const runId = await insertTestExtractionRun(tx);

      const unverified = await rejectionMessage(tx, (sp) =>
        sp.insert(facts).values(textFact(m, runId, { quote: "x", quoteVerified: false })),
      );
      expect(unverified).toMatch(/facts_text_quote_verified/);

      const noChunk = await rejectionMessage(tx, (sp) =>
        sp.insert(facts).values(textFact(m, runId, { quoteChunkId: null })),
      );
      expect(noChunk).toMatch(/facts_text_quote_verified/);

      await expect(tx.insert(facts).values(textFact(m, runId))).resolves.toBeTruthy();
    });
  });

  it("a text fact needs an extraction run", async () => {
    await withRollback(async (tx) => {
      const m = await insertTestMention(tx);
      const runId = await insertTestExtractionRun(tx);
      const message = await rejectionMessage(tx, (sp) =>
        sp.insert(facts).values(textFact(m, runId, { extractionRunId: null })),
      );
      expect(message).toMatch(/facts_text_extraction_run/);
    });
  });

  it("a text fact needs a non-empty quote span from 0 on", async () => {
    await withRollback(async (tx) => {
      const m = await insertTestMention(tx);
      const runId = await insertTestExtractionRun(tx);
      for (const span of [
        { quoteStart: null },
        { quoteEnd: null },
        { quoteStart: -1 },
        { quoteStart: 20, quoteEnd: 20 },
        { quoteStart: 21, quoteEnd: 20 },
      ]) {
        const message = await rejectionMessage(tx, (sp) => sp.insert(facts).values(textFact(m, runId, span)));
        expect(message, JSON.stringify(span)).toMatch(/facts_text_quote_span/);
      }
      await expect(tx.insert(facts).values(textFact(m, runId, { quoteStart: 0, quoteEnd: 1 }))).resolves.toBeTruthy();
    });
  });

  it("a text fact points at an existing mention and extraction run", async () => {
    await withRollback(async (tx) => {
      const m = await insertTestMention(tx);
      const runId = await insertTestExtractionRun(tx);
      const unknownMention = await rejectionMessage(tx, (sp) =>
        sp.insert(facts).values(textFact(m, runId, { mentionId: "0199f0a4-1b2c-7d3e-8f40-123456789abc" })),
      );
      expect(unknownMention).toMatch(/facts_mention_id_mentions_id_fk/);
      const unknownRun = await rejectionMessage(tx, (sp) =>
        sp.insert(facts).values(textFact(m, "0199f0a4-1b2c-7d3e-8f40-123456789abc")),
      );
      expect(unknownRun).toMatch(/facts_extraction_run_id_extraction_runs_id_fk/);
    });
  });

  it("(mention_id, attribute, extraction_run_id) is unique for facts", async () => {
    await withRollback(async (tx) => {
      const m = await insertTestMention(tx);
      const runId = await insertTestExtractionRun(tx);
      await tx.insert(facts).values(textFact(m, runId));

      const message = await rejectionMessage(tx, (sp) => sp.insert(facts).values(textFact(m, runId)));
      expect(message).toMatch(/facts_mention_attribute_run_unique/);
      // another run may state the same attribute again
      const otherRun = await insertTestExtractionRun(tx, { model: "claude-opus-5-5" });
      await expect(tx.insert(facts).values(textFact(m, otherRun))).resolves.toBeTruthy();
    });
  });

  it("a route stop with quote_verified false is rejected", async () => {
    await withRollback(async (tx) => {
      const m = await insertTestMention(tx);
      const routeId = await insertRoute(tx, m);
      const message = await rejectionMessage(tx, (sp) =>
        sp.insert(routeStops).values(stopValues(routeId, m, { quoteVerified: false })),
      );
      expect(message).toMatch(/route_stops_quote_verified/);
      await expect(tx.insert(routeStops).values(stopValues(routeId, m))).resolves.toBeTruthy();
    });
  });

  it("at most one open batch per run, stage and outcome key", async () => {
    await withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const batch = {
        task: "classify-document",
        model: "claude-haiku-5-5",
        promptVersion: 1,
        runId,
        stage: "classify.batch",
        outcomeKey: "batch:1",
        requestCount: 1,
      };
      const [first] = await tx.insert(aiBatches).values(batch).returning({ id: aiBatches.id });
      const message = await rejectionMessage(tx, (sp) => sp.insert(aiBatches).values(batch));
      expect(message).toMatch(/ai_batches_open_outcome_unique/);

      await tx.update(aiBatches).set({ status: "distributed" }).where(eq(aiBatches.id, first!.id));
      await expect(tx.insert(aiBatches).values(batch)).resolves.toBeTruthy();
    });
  });

  it("working-state rows keep updated_at current", async () => {
    await withRollback(async (tx) => {
      const { versionId, chunkId } = await insertTestChunk(tx);
      const [row] = await tx
        .insert(ambiguousMatches)
        .values({
          documentVersionId: versionId,
          chunkId,
          surface: "Good",
          charStart: 0,
          charEnd: 4,
          candidates: [],
          updatedAt: new Date("2020-01-01T00:00:00Z"),
        })
        .returning({ id: ambiguousMatches.id });
      const [updated] = await tx
        .update(ambiguousMatches)
        .set({ status: "resolved" })
        .where(eq(ambiguousMatches.id, row!.id))
        .returning({ updatedAt: ambiguousMatches.updatedAt });
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(new Date("2025-01-01").getTime());
    });
  });

  it("document_versions release only the classification columns", async () => {
    await withRollback(async (tx) => {
      const { versionId } = await insertTestChunk(tx);
      const runId = await insertTestRun(tx);
      const [row] = await tx
        .update(documentVersions)
        .set({
          classifiedDocType: "pilot_guide",
          classifiedLanguages: ["en", "de"],
          classifiedPublishedAt: "2024-05-15",
          classifiedObservedAt: "2024-05-15",
          classifiedObservedAtBasis: "explicit",
          observedAtReason: "Trip in May 2024",
          areaHints: ["Saronic"],
          classifiedModel: "claude-haiku-5-5",
          classifiedPromptVersion: 1,
          classifiedRunId: runId,
          classifiedAt: new Date(),
        })
        .where(eq(documentVersions.id, versionId))
        .returning({ docType: documentVersions.docType, classified: documentVersions.classifiedDocType });
      expect(row).toEqual({ docType: "trip_report", classified: "pilot_guide" });

      const message = await rejectionMessage(tx, (sp) =>
        sp.update(documentVersions).set({ observedAt: "2020-01-01" }).where(eq(documentVersions.id, versionId)),
      );
      expect(message).toMatch(/document_versions is append-only/);
      const del = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`delete from document_versions where id = ${versionId}`),
      );
      expect(del).toMatch(/document_versions is append-only/);
    });
  });
});
