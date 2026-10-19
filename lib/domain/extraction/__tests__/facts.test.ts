import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestExtractionRun, insertTestTile, insertTestVersion } from "@/test/text";
import type { ExtractedFact } from "@/lib/ai/tasks/extract-facts";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { extractionRuns, facts, mentions, unmatchedNames } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { tileIdFor } from "@/lib/domain/tiles";
import { emptyFactStats, processFactOutput, type ProcessUnit } from "@/lib/domain/extraction/facts";

const config = loadConfig("config");

const CHUNKS = [
  "## Kolona\n\nKolona Bay lies on the west side of Kalonisi.",
  "Kolona Bay is **well sheltered** from the north. Holding is good in sand, depth 6 m.",
  "In May 2024 the Taverna Nikos above the beach was open; the beach Psili Ammos is lovely.",
];

/**
 * A bay "Kolona" at 21.0 E / 35.2 N with mentions in chunks 0 and 1 of a 3-chunk version, and its unit; `third`
 * replaces the text of the third chunk.
 */
async function scene(tx: Db, third?: string) {
  const tile = await insertTestTile(tx, tileIdFor(21.0, 35.2));
  const bay = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.0, lat: 35.2, tiles: [tile] });
  const v = await insertTestVersion(tx, third === undefined ? CHUNKS : [CHUNKS[0]!, CHUNKS[1]!, third]);
  const mentionIds: string[] = [];
  for (const [i, start] of [
    [0, CHUNKS[0]!.indexOf("Kolona Bay")],
    [1, 0],
  ] as const) {
    const [m] = await tx
      .insert(mentions)
      .values({
        documentVersionId: v.versionId,
        chunkId: v.chunkIds[i]!,
        geoObjectId: bay,
        surface: "Kolona Bay",
        charStart: start,
        charEnd: start + "Kolona Bay".length,
        observedAt: "2026-10-19",
        confidence: 1,
        matchKind: "deterministic",
        extractionStatus: "done",
      })
      .returning({ id: mentions.id });
    mentionIds.push(m!.id);
  }
  const extractionRunId = await insertTestExtractionRun(tx);
  const unit: ProcessUnit = {
    id: newId(),
    extractionRunId,
    documentVersionId: v.versionId,
    geoObjectId: bay,
    level: "place",
    mentionIds,
    chunkIds: v.chunkIds,
  };
  return { ...v, tile, bay, mentionIds, unit };
}

const fact = (f: Partial<ExtractedFact>): ExtractedFact => ({
  attribute: "holding",
  value: '"good"',
  quote: "Holding is good in sand",
  chunk: 2,
  confidence: 0.9,
  observed_at: null,
  poi_name: null,
  ...f,
});

const factsOf = (tx: Db, extractionRunId: string) => tx.select().from(facts).where(eq(facts.extractionRunId, extractionRunId));

describe("processFactOutput", () => {
  it("a verified fact is stored with mention, quote offsets and schema v2", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const stats = await processFactOutput(tx, s.unit, { facts: [fact({})] }, config);
      expect(stats).toEqual({ ...emptyFactStats(), proposed: 1, stored: 1 });
      const [row] = await factsOf(tx, s.unit.extractionRunId);
      const start = CHUNKS[1]!.indexOf("Holding");
      expect(row).toMatchObject({
        geoObjectId: s.bay,
        attribute: "holding",
        value: "good",
        mentionId: s.mentionIds[1],
        quote: "Holding is good in sand",
        quoteVerified: true,
        quoteChunkId: s.chunkIds[1],
        quoteStart: start,
        quoteEnd: start + "Holding is good in sand".length,
        observedAt: "2026-10-19",
        confidence: 0.9,
        factSchemaVersion: "v2",
      });
    }));

  it("a fabricated quote is dropped and counted", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const out = {
        facts: [
          fact({ quote: "Holding is excellent in sand" }),
          // a lower-case or shortened quote and one joined from two sentences are not verbatim either
          fact({ attribute: "seabed", value: '["sand"]', quote: "holding is good in sand" }),
          fact({ attribute: "depth.anchoring_min", value: "6", quote: "from the north. depth 6 m" }),
          fact({ attribute: "quietness", value: '"quiet"', quote: "Holding is good … depth 6 m" }),
        ],
      };
      const stats = await processFactOutput(tx, s.unit, out, config);
      expect(stats).toMatchObject({ proposed: 4, stored: 0, rejectedQuote: 4 });
      expect(await factsOf(tx, s.unit.extractionRunId)).toHaveLength(0);
    }));

  it("'good' shelter is stored as 0.9", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      // the model leaves out the Markdown emphasis of the chunk: still verbatim
      const stats = await processFactOutput(
        tx,
        s.unit,
        { facts: [fact({ attribute: "shelter.N", value: '"good"', quote: "Kolona Bay is well sheltered from the north" })] },
        config,
      );
      expect(stats.stored).toBe(1);
      const [row] = await factsOf(tx, s.unit.extractionRunId);
      expect([row!.attribute, row!.value]).toEqual(["shelter.N", 0.9]);
      expect(CHUNKS[1]!.slice(row!.quoteStart!, row!.quoteEnd!)).toBe("Kolona Bay is **well sheltered** from the north");
    }));

  it("an island attribute on a place and broken JSON are counted separately", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const out = {
        facts: [
          fact({ attribute: "meltemi_exposure", value: '"high"' }),
          fact({ value: "good" }),
          fact({ value: '"excellent"', attribute: "quietness" }),
          fact({ attribute: "opening_bearing", value: '{"bearingDeg":90,"widthDeg":40}' }),
        ],
      };
      const stats = await processFactOutput(tx, s.unit, out, config);
      // a computed-only attribute counts as unknown for texts too
      expect(stats).toMatchObject({ proposed: 4, stored: 0, unknownAttribute: 2, invalidValue: 2, rejectedQuote: 0 });
      expect(await factsOf(tx, s.unit.extractionRunId)).toHaveLength(0);
    }));

  it("the quote is found in a neighbour chunk when the given chunk number is wrong", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const stats = await processFactOutput(tx, s.unit, { facts: [fact({ chunk: 3 }), fact({ attribute: "seabed", value: '["sand"]', chunk: 99 })] }, config);
      expect(stats).toMatchObject({ stored: 2, rejectedQuote: 0 });
      const rows = await factsOf(tx, s.unit.extractionRunId);
      expect(rows.map((r) => r.quoteChunkId)).toEqual([s.chunkIds[1], s.chunkIds[1]]);
    }));

  it("duplicate attributes keep the higher confidence", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const out = {
        facts: [
          fact({ confidence: 0.6, quote: "Holding is good in sand, depth 6 m" }),
          fact({ confidence: 0.95 }),
          fact({ confidence: 0.7 }),
          // a duplicate that fails its quote check does not oust the valid one
          fact({ confidence: 1, quote: "Holding is superb in sand" }),
        ],
      };
      const stats = await processFactOutput(tx, s.unit, out, config);
      expect(stats).toMatchObject({ proposed: 4, stored: 1, duplicate: 2, rejectedQuote: 1 });
      const [row] = await factsOf(tx, s.unit.extractionRunId);
      expect([row!.confidence, row!.quote]).toEqual([0.95, "Holding is good in sand"]);
    }));

  it("'2024-05' becomes 2024-05-15, a future date falls back to the version date", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const out = {
        facts: [
          fact({ observed_at: "2024-05" }),
          fact({ attribute: "seabed", value: '["sand"]', observed_at: "2099-01-01" }),
          fact({ attribute: "depth.anchoring_min", value: "6", quote: "Holding is good in sand, depth 6 m", observed_at: "1950-06-01" }),
        ],
      };
      await processFactOutput(tx, s.unit, out, config);
      const rows = await factsOf(tx, s.unit.extractionRunId);
      const byAttr = Object.fromEntries(rows.map((r) => [r.attribute, r.observedAt]));
      expect(byAttr).toEqual({ holding: "2024-05-15", seabed: "2026-10-19", "depth.anchoring_min": "2026-10-19" });
    }));

  it("a named taverna 1.2 km away becomes a poi mention, an unknown one an unmatched name", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      // 1.2 km north of the bay
      const taverna = await insertNamedObject(tx, { type: "poi", names: [{ name: "Taverna Nikos" }], lon: 21.0, lat: 35.2108 });
      // the beach exists, but 3 km away: outside the 2 km radius
      await insertNamedObject(tx, { type: "poi", names: [{ name: "Psili Ammos" }], lon: 21.0, lat: 35.227 });
      const out = {
        facts: [
          fact({
            attribute: "highlight.food",
            value: '{"present":true,"names":["Taverna Nikos"]}',
            quote: "the Taverna Nikos above the beach was open",
            chunk: 3,
            poi_name: "Taverna Nikos",
          }),
          fact({
            attribute: "highlight.beach",
            value: '{"present":true,"names":["Psili Ammos"]}',
            quote: "the beach Psili Ammos is lovely",
            chunk: 3,
            poi_name: "Psili Ammos",
          }),
        ],
      };
      const stats = await processFactOutput(tx, s.unit, out, config);
      expect(stats).toMatchObject({ stored: 2, poiMentions: 1, poiUnmatched: 1 });
      const poiMentions = await tx.select().from(mentions).where(eq(mentions.geoObjectId, taverna));
      const start = CHUNKS[2]!.indexOf("the Taverna Nikos");
      expect(poiMentions).toHaveLength(1);
      expect(poiMentions[0]).toMatchObject({
        documentVersionId: s.versionId,
        chunkId: s.chunkIds[2],
        charStart: start,
        charEnd: start + "the Taverna Nikos above the beach was open".length,
        surface: "the Taverna Nikos above the beach was open",
        matchKind: "model",
        extractionStatus: "done",
        model: "claude-sonnet-5-5",
        promptVersion: 1,
      });
      const unmatched = await tx.select().from(unmatchedNames).where(eq(unmatchedNames.documentVersionId, s.versionId));
      expect(unmatched.map((u) => [u.displayName, u.nameNormalized, u.hint, u.chunkId, u.tileId])).toEqual([
        ["Psili Ammos", "psili ammos", "poi:beach", s.chunkIds[2], s.tile],
      ]);
      // the facts of the highlights stay with the bay's mention
      const rows = await factsOf(tx, s.unit.extractionRunId);
      expect(new Set(rows.map((r) => r.geoObjectId))).toEqual(new Set([s.bay]));
    }));

  it("processing the same output twice stores nothing new", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const taverna = await insertNamedObject(tx, { type: "poi", names: [{ name: "Taverna Nikos" }], lon: 21.0, lat: 35.2108 });
      const out = {
        facts: [
          fact({}),
          fact({ attribute: "shelter.N", value: '"moderate"', quote: "well sheltered from the north" }),
          fact({ attribute: "highlight.food", value: '{"present":true,"names":["Taverna Nikos"]}', quote: "the Taverna Nikos above the beach was open", chunk: 3, poi_name: "Taverna Nikos" }),
          fact({ attribute: "highlight.beach", value: '{"present":true,"names":["Psili Ammos"]}', quote: "the beach Psili Ammos is lovely", chunk: 3, poi_name: "Psili Ammos" }),
        ],
      };
      expect(await processFactOutput(tx, s.unit, out, config)).toMatchObject({ stored: 4, poiMentions: 1, poiUnmatched: 1 });
      const again = await processFactOutput(tx, s.unit, out, config);
      // the counters count rows actually written
      expect(again).toMatchObject({ stored: 0, poiMentions: 0, poiUnmatched: 0 });
      expect(await factsOf(tx, s.unit.extractionRunId)).toHaveLength(4);
      expect(await tx.select().from(mentions).where(eq(mentions.geoObjectId, taverna))).toHaveLength(1);
      expect(await tx.select().from(unmatchedNames).where(eq(unmatchedNames.documentVersionId, s.versionId))).toHaveLength(1);
    }));

  it("facts beyond maxFactsPerUnit are not looked at", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const out = { facts: [fact({}), fact({ attribute: "seabed", value: '["sand"]' })] };
      const stats = await processFactOutput(tx, s.unit, out, { ...config, extraction: { ...config.extraction, maxFactsPerUnit: 1 } });
      expect(stats).toMatchObject({ proposed: 2, stored: 1, overLimit: 1 });
    }));
  it("facts are checked against and stored with the extraction run's fact schema version", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      // planned while v1 was active: `holding` (v2 only) was not in its prompt
      await tx.update(extractionRuns).set({ factSchemaVersion: "v1" }).where(eq(extractionRuns.id, s.unit.extractionRunId));
      const out = { facts: [fact({}), fact({ attribute: "depth.anchoring_min", value: "6", quote: "Holding is good in sand, depth 6 m" })] };
      const stats = await processFactOutput(tx, s.unit, out, config);
      expect(stats).toMatchObject({ stored: 1, unknownAttribute: 1 });
      const rows = await factsOf(tx, s.unit.extractionRunId);
      expect(rows.map((r) => [r.attribute, r.factSchemaVersion])).toEqual([["depth.anchoring_min", "v1"]]);
    }));

  it("a highlight name that is not in the quote creates neither a mention nor an unmatched name", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const nikos = await insertNamedObject(tx, { type: "poi", category: "food", names: [{ name: "Taverna Nikos" }], lon: 21.0, lat: 35.2108 });
      const yannis = await insertNamedObject(tx, { type: "poi", category: "food", names: [{ name: "Taverna Yannis" }], lon: 21.0, lat: 35.2109 });
      const out = {
        facts: [
          fact({
            attribute: "highlight.food",
            value: '{"present":true,"names":["Taverna Nikos","Taverna Yannis","Taverna Maria"]}',
            quote: "the Taverna Nikos above the beach was open",
            chunk: 3,
            poi_name: "Taverna Yannis",
          }),
        ],
      };
      const stats = await processFactOutput(tx, s.unit, out, config);
      // two names of `names` and the poi_name are not in the quote
      expect(stats).toMatchObject({ stored: 1, poiMentions: 1, poiUnmatched: 0, poiNameRejected: 3 });
      expect(await tx.select().from(mentions).where(eq(mentions.geoObjectId, yannis))).toHaveLength(0);
      expect(await tx.select().from(mentions).where(eq(mentions.geoObjectId, nikos))).toHaveLength(1);
      expect(await tx.select().from(unmatchedNames).where(eq(unmatchedNames.documentVersionId, s.versionId))).toHaveLength(0);
      // the stored value keeps only the names the quote supports
      const [row] = await factsOf(tx, s.unit.extractionRunId);
      expect(row!.value).toEqual({ present: true, names: ["Taverna Nikos"] });
    }));

  it("every name of a highlight in its quote reaches the gazetteer", () =>
    withRollback(async (tx) => {
      const s = await scene(tx, "Above the harbour the Taverna Nikos and the Taverna Maria serve fresh fish.");
      const nikos = await insertNamedObject(tx, { type: "poi", category: "food", names: [{ name: "Taverna Nikos" }], lon: 21.0, lat: 35.2108 });
      const out = {
        facts: [
          fact({
            attribute: "highlight.food",
            value: '{"present":true,"names":["Taverna Nikos","Taverna Maria"]}',
            quote: "the Taverna Nikos and the Taverna Maria serve fresh fish",
            chunk: 3,
            poi_name: null,
          }),
        ],
      };
      const stats = await processFactOutput(tx, s.unit, out, config);
      expect(stats).toMatchObject({ stored: 1, poiMentions: 1, poiUnmatched: 1, poiNameRejected: 0 });
      expect(await tx.select().from(mentions).where(eq(mentions.geoObjectId, nikos))).toHaveLength(1);
      const unmatched = await tx.select().from(unmatchedNames).where(eq(unmatchedNames.documentVersionId, s.versionId));
      expect(unmatched.map((u) => [u.displayName, u.hint])).toEqual([["Taverna Maria", "poi:food"]]);
    }));

  it("a beach named like a nearby chapel matches the beach", () =>
    withRollback(async (tx) => {
      const s = await scene(tx, "The beach of Agios Nikolaos below the chapel is sandy and shallow.");
      // created first, so without the category it would win the tie on the id
      const chapel = await insertNamedObject(tx, { type: "poi", category: "culture", names: [{ name: "Agios Nikolaos" }], lon: 21.0, lat: 35.2105 });
      const beach = await insertNamedObject(tx, { type: "poi", category: "beach", names: [{ name: "Agios Nikolaos" }], lon: 21.0, lat: 35.2106 });
      const out = {
        facts: [
          fact({
            attribute: "highlight.beach",
            value: '{"present":true,"names":["Agios Nikolaos"]}',
            quote: "The beach of Agios Nikolaos below the chapel is sandy",
            chunk: 3,
            poi_name: "Agios Nikolaos",
          }),
        ],
      };
      expect(await processFactOutput(tx, s.unit, out, config)).toMatchObject({ poiMentions: 1 });
      expect(await tx.select().from(mentions).where(eq(mentions.geoObjectId, beach))).toHaveLength(1);
      expect(await tx.select().from(mentions).where(eq(mentions.geoObjectId, chapel))).toHaveLength(0);
    }));

  it("an unmatched POI name keeps its poi hint where the matcher left the name unmatched already", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      // the matcher's row for the same name in the same chunk, without a hint
      await tx.insert(unmatchedNames).values({
        nameNormalized: "psili ammos",
        displayName: "Psili Ammos",
        hint: null,
        documentVersionId: s.versionId,
        chunkId: s.chunkIds[2]!,
        sourceId: s.sourceId,
        tileId: s.tile,
      });
      const out = {
        facts: [
          fact({ attribute: "highlight.beach", value: '{"present":true,"names":["Psili Ammos"]}', quote: "the beach Psili Ammos is lovely", chunk: 3, poi_name: "Psili Ammos" }),
        ],
      };
      expect(await processFactOutput(tx, s.unit, out, config)).toMatchObject({ poiUnmatched: 1 });
      const unmatched = await tx.select().from(unmatchedNames).where(eq(unmatchedNames.documentVersionId, s.versionId));
      expect(unmatched.map((u) => [u.nameNormalized, u.hint])).toEqual([["psili ammos", "poi:beach"]]);
    }));
});
