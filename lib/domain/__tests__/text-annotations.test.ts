import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestExtractionRun, insertTestRun, insertTestVersion } from "@/test/text";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { extractionUnits, facts, mentions } from "@/lib/db/schema";
import { quoteContext, versionAnnotations } from "@/lib/domain/text-annotations";

/*
 * Mentions and quotes per chunk for the document page, inside withRollback on the synthetic grid at 21.0° E / 35.2° N.
 */

const config = loadConfig("config");
const TEXT = "Kolona is a quiet bay. Holding is good in sand, depth 6 m.";

/** A mention of a new bay "Kolona" in chunk 0 of a version, a holding fact quoted from it, from a finished run. */
async function annotated(tx: Db) {
  const kolona = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.1, lat: 35.1 });
  const v = await insertTestVersion(tx, [TEXT]);
  const [m] = await tx
    .insert(mentions)
    .values({ documentVersionId: v.versionId, chunkId: v.chunkIds[0]!, geoObjectId: kolona, surface: "Kolona", charStart: 0, charEnd: 6, observedAt: "2026-10-19", confidence: 1, matchKind: "deterministic", extractionStatus: "done" })
    .returning({ id: mentions.id });
  const taskConfig = config.models.tasks["extract-facts"]!;
  const runId = await insertTestRun(tx);
  const extractionRunId = await insertTestExtractionRun(tx, { runId, model: taskConfig.model, promptVersion: taskConfig.promptVersion, status: "finished" });
  await tx.insert(extractionUnits).values({ extractionRunId, documentVersionId: v.versionId, geoObjectId: kolona, part: 0, level: "place", mentionIds: [m!.id], chunkIds: v.chunkIds, status: "done" });
  const start = TEXT.indexOf("Holding is good in sand");
  const [f] = await tx
    .insert(facts)
    .values({
      geoObjectId: kolona,
      attribute: "holding",
      value: "good",
      mentionId: m!.id,
      quote: "Holding is good in sand",
      quoteVerified: true,
      quoteChunkId: v.chunkIds[0]!,
      quoteStart: start,
      quoteEnd: start + "Holding is good in sand".length,
      observedAt: "2026-10-19",
      confidence: 0.9,
      extractionRunId,
      factSchemaVersion: "v2",
    })
    .returning({ id: facts.id });
  return { ...v, kolona, mentionId: m!.id, factId: f!.id, extractionRunId, runId, start };
}

describe("versionAnnotations", () => {
  it("lists a chunk's mentions and quotes with their spans", () =>
    withRollback(async (tx) => {
      const a = await annotated(tx);
      const [chunk] = await versionAnnotations(tx, a.versionId, config);
      expect(chunk).toMatchObject({ chunkId: a.chunkIds[0], ordinal: 0, text: TEXT, carriedFrom: null });
      expect(chunk!.spans).toEqual([
        { start: 0, end: 6, kind: "mention", ref: a.mentionId },
        { start: a.start, end: a.start + 23, kind: "quote", ref: a.factId },
      ]);
      expect(chunk!.mentions).toEqual([{ id: a.mentionId, geoObjectId: a.kolona, name: "Kolona", matchKind: "deterministic", confidence: 1 }]);
      expect(chunk!.facts).toEqual([
        { id: a.factId, geoObjectId: a.kolona, attribute: "holding", value: "good", confidence: 0.9, model: "claude-sonnet-5-5", extractionRunId: a.extractionRunId, runId: a.runId, active: true },
      ]);
    }));

  it("quotes of facts outside the active run are highlighted apart", () =>
    withRollback(async (tx) => {
      const a = await annotated(tx);
      // a comparison run quoting the same chunk: its fact stays, but is not active
      const comparison = await insertTestExtractionRun(tx, { runId: a.runId, model: "claude-opus-5-5", promptVersion: 3, status: "finished", purpose: "comparison" });
      const start = TEXT.indexOf("Kolona is a quiet bay");
      const [f] = await tx
        .insert(facts)
        .values({
          geoObjectId: a.kolona,
          attribute: "quietness",
          value: "quiet",
          mentionId: a.mentionId,
          quote: "Kolona is a quiet bay",
          quoteVerified: true,
          quoteChunkId: a.chunkIds[0]!,
          quoteStart: start,
          quoteEnd: start + "Kolona is a quiet bay".length,
          observedAt: "2026-10-19",
          confidence: 0.8,
          extractionRunId: comparison,
          factSchemaVersion: "v2",
        })
        .returning({ id: facts.id });
      const [chunk] = await versionAnnotations(tx, a.versionId, config);
      expect(chunk!.spans.filter((s) => s.kind !== "mention").map((s) => [s.kind, s.ref])).toEqual([
        ["inactive-quote", f!.id],
        ["quote", a.factId],
      ]);
      expect(chunk!.facts.find((x) => x.id === f!.id)!.active).toBe(false);
    }));

  it("annotations of a carried chunk come from its origin chunk", () =>
    withRollback(async (tx) => {
      const a = await annotated(tx);
      // version 2 carries chunk 0 over unchanged; version 3 carries it again (a chain) and adds a new chunk
      const v2 = await insertTestVersion(tx, [TEXT], { documentId: a.documentId, carried: { 0: a.chunkIds[0]! } });
      const v3 = await insertTestVersion(tx, [TEXT, "Ein neuer Absatz."], { documentId: a.documentId, carried: { 0: v2.chunkIds[0]! } });
      for (const versionId of [v2.versionId, v3.versionId]) {
        const [chunk, other] = await versionAnnotations(tx, versionId, config);
        expect(chunk!.carriedFrom).not.toBeNull();
        expect(chunk!.spans.map((s) => [s.kind, s.ref])).toEqual([
          ["mention", a.mentionId],
          ["quote", a.factId],
        ]);
        expect(chunk!.facts.map((f) => f.id)).toEqual([a.factId]);
        if (other) expect(other.spans).toEqual([]);
      }
    }));
});

describe("quoteContext", () => {
  it("the quote context cuts at word boundaries", () => {
    const text = "alpha beta gamma delta QUOTE epsilon zeta eta theta";
    const start = text.indexOf("QUOTE");
    // 8 characters before reach into "gamma": the split word is left out
    expect(quoteContext(text, start, start + 5, 8)).toEqual({ before: "… delta ", quote: "QUOTE", after: " epsilon …" });
    // a cut that falls on a space keeps the whole word after it; one inside "epsilon" drops it
    expect(quoteContext(text, start, start + 5, 6)).toEqual({ before: "… delta ", quote: "QUOTE", after: " …" });
    // nothing to cut: the full text, without marks
    expect(quoteContext(text, start, start + 5, 200)).toEqual({ before: "alpha beta gamma delta ", quote: "QUOTE", after: " epsilon zeta eta theta" });
    // a single long word before the cut leaves only the mark
    const long = "Donaudampfschifffahrt QUOTE";
    expect(quoteContext(long, 22, 27, 5).before).toBe("… ");
  });
});
