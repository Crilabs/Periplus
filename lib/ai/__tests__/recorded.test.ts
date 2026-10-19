import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertTestExtractionRun, insertTestGeoObject, insertTestRun, insertTestVersion } from "@/test/text";
import { extractFactsTask, type ExtractFactsInput, type ExtractFactsOutput } from "@/lib/ai/tasks/extract-facts";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { extractionUnits, facts, mentions, type GeoObjectType } from "@/lib/db/schema";
import { processFactOutput, type FactStats } from "@/lib/domain/extraction/facts";
import { checkQuoteFidelity, type QuoteFidelity } from "@/lib/domain/extraction/fidelity";
import type { FactLevel } from "@/lib/domain/facts/schema-types";

/*
 * Smoke test of the quote check against real model answers (Task 20): every `extract-facts` answer recorded by
 * `npm run fixtures:record -- --ai extract-facts` (`test/fixtures/ai/extract-facts/*.json`, the unit's chunk texts are
 * in its input) is processed like a batch result against those chunks, inside withRollback. Every stored fact must
 * verify and the run's Belegtreue must be 1; the number of rejected quotes is recorded as a test annotation (no
 * failure: dropping an unverifiable quote is the rule working) and goes to docs/pilot/m4-abnahme.md.
 */

const config = loadConfig("config");
const DIR = join(process.cwd(), "test/fixtures/ai/extract-facts");
const recorded = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).sort() : [];

/** A geo object type whose fact level is the unit's (without a place: by type). */
const TYPE_OF_LEVEL: Record<FactLevel, GeoObjectType> = { place: "bay", area: "area", island: "island", cape_strait: "cape", poi: "poi" };

/** The unit of the answer rebuilt from its input: its chunks as one version, the object, one mention, a running run. */
async function smoke(tx: Db, input: ExtractFactsInput, output: ExtractFactsOutput): Promise<{ stats: FactStats; fidelity: QuoteFidelity; stored: number }> {
  const v = await insertTestVersion(tx, input.chunks.map((c) => c.text));
  const geoObjectId = await insertTestGeoObject(tx, { type: TYPE_OF_LEVEL[input.level] });
  const [m] = await tx
    .insert(mentions)
    .values({ documentVersionId: v.versionId, chunkId: v.chunkIds[0]!, geoObjectId, surface: input.object.name.slice(0, 80), charStart: 0, charEnd: 1, observedAt: input.observedAt, confidence: 1, matchKind: "deterministic", extractionStatus: "done" })
    .returning({ id: mentions.id });
  const extractionRunId = await insertTestExtractionRun(tx, { runId: await insertTestRun(tx), factSchemaVersion: input.factSchemaVersion });
  const [unit] = await tx
    .insert(extractionUnits)
    .values({ extractionRunId, documentVersionId: v.versionId, geoObjectId, part: 0, level: input.level, mentionIds: [m!.id], chunkIds: v.chunkIds, status: "submitted" })
    .returning({ id: extractionUnits.id });
  const stats = await processFactOutput(
    tx,
    { id: unit!.id, extractionRunId, documentVersionId: v.versionId, geoObjectId, level: input.level, mentionIds: [m!.id], chunkIds: v.chunkIds },
    output,
    config,
  );
  const stored = await tx.select().from(facts).where(eq(facts.extractionRunId, extractionRunId));
  expect(stored.every((f) => f.quoteVerified)).toBe(true);
  return { stats, fidelity: await checkQuoteFidelity(tx, extractionRunId, config), stored: stored.length };
}

describe("recorded extract-facts answers", () => {
  it("the smoke test drops an invented quote and verifies the rest (hand-written answer)", () =>
    withRollback(async (tx) => {
      const input: ExtractFactsInput = {
        level: "place",
        factSchemaVersion: config.factSchema.version,
        maxFacts: config.extraction.maxFactsPerUnit,
        limits: { quoteMinChars: config.extraction.quote.minChars, quoteMaxChars: config.extraction.quote.maxChars, nameMaxChars: config.extraction.properNameMaxChars },
        object: { name: "Kolona", type: "bay", parents: [] },
        docType: "pilot_guide",
        observedAt: "2026-10-19",
        chunks: [{ n: 1, text: "Kolona is a quiet bay. Holding is good in sand, depth 6 m." }],
      };
      const output = extractFactsTask.output.parse({
        facts: [
          { attribute: "holding", value: '"good"', quote: "Holding is good in sand", chunk: 1, confidence: 0.9, observed_at: null, poi_name: null },
          { attribute: "quietness", value: '"quiet"', quote: "Kolona is a very quiet bay", chunk: 1, confidence: 0.8, observed_at: null, poi_name: null },
        ],
      });
      const r = await smoke(tx, input, output);
      expect(r.stats).toMatchObject({ proposed: 2, stored: 1, rejectedQuote: 1 });
      expect(r.stored).toBe(1);
      expect(r.fidelity).toMatchObject({ facts: 1, verified: 1, ratio: 1 });
    }));

  // One test per recorded answer; none exist until the first real recording (measured in the M7 pilot).
  for (const file of recorded) {
    it(`recorded answer ${file.slice(0, 12)}: every stored fact verifies`, ({ annotate }) =>
      withRollback(async (tx) => {
        const fixture = JSON.parse(readFileSync(join(DIR, file), "utf8")) as { input: ExtractFactsInput; output: unknown; model: string };
        const r = await smoke(tx, fixture.input, extractFactsTask.output.parse(fixture.output));
        expect(r.fidelity.ratio).toBe(1);
        expect(r.fidelity.failures).toEqual([]);
        await annotate(`${fixture.model}: ${r.stats.proposed} proposed, ${r.stats.stored} stored, ${r.stats.rejectedQuote} rejected quotes`);
      }));
  }
});
